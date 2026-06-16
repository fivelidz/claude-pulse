// claude-pulse — Rust backend.
// Reads the append-only usage.jsonl written by the collector proxy, aggregates
// it into per-minute buckets / day summaries, and exposes them to the webview.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Deserialize)]
struct RawLine {
    t: i64,
    #[serde(default)]
    kind: String, // "request" (default) | "ratelimit"
    #[serde(default)]
    status: i64,
    #[serde(default)]
    input: Option<f64>,
    #[serde(default)]
    output: Option<f64>,
    #[serde(rename = "cacheRead", default)]
    cache_read: Option<f64>,
    #[serde(rename = "cacheWrite", default)]
    cache_write: Option<f64>,
    #[serde(rename = "bytesIn", default)]
    bytes_in: Option<f64>,
    #[serde(rename = "bytesOut", default)]
    bytes_out: Option<f64>,
    #[serde(default)]
    cost: Option<f64>,
    #[serde(rename = "rateLimited", default)]
    rate_limited: bool,
    #[serde(default)]
    u5h: Option<f64>,
    #[serde(default)]
    u7d: Option<f64>,
    #[serde(rename = "reset5h", default)]
    reset5h: Option<f64>,
    #[serde(rename = "reset7d", default)]
    reset7d: Option<f64>,
    #[serde(default)]
    plan: Option<String>,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Debug, Default, Serialize, Clone)]
pub struct MinuteBucket {
    /// epoch ms at the start of the minute
    minute: i64,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    bytes_in: f64,
    bytes_out: f64,
    cost: f64,
    requests: u32,
    rate_limited: u32,
    /// max unified 5h utilization seen in this minute (0..1)
    u5h: f64,
    u7d: f64,
}

#[derive(Debug, Default, Serialize)]
pub struct Snapshot {
    /// per-minute buckets for the requested window, ascending by time
    minutes: Vec<MinuteBucket>,
    /// the single highest combined-tokens minute in the window (peak)
    peak_tokens: f64,
    peak_minute: i64,
    peak_requests: u32,
    peak_requests_minute: i64,
    /// total rate-limit events in the window
    rate_limited_total: u32,
    /// latest unified utilization seen (most recent non-empty)
    latest_u5h: f64,
    latest_u7d: f64,
    /// epoch SECONDS when each rolling window resets (0 if unknown)
    reset5h: f64,
    reset7d: f64,
    /// subscription plan label if known (e.g. "Max 20×")
    plan: Option<String>,
    /// totals across the window
    total_bytes_in: f64,
    total_bytes_out: f64,
    total_cost: f64,
    /// bucket size used (minutes) + the requested window (minutes)
    bucket_minutes: i64,
    window_minutes: i64,
    /// log file path (for the UI to show)
    log_path: String,
    /// whether the log file exists
    has_data: bool,
}

#[derive(Debug, Default, Serialize)]
pub struct DaySummary {
    /// YYYY-MM-DD (local)
    day: String,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    requests: u32,
    rate_limited: u32,
    peak_tpm: f64,
}

fn log_path() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    base.join("claude-pulse").join("usage.jsonl")
}

fn read_lines() -> Vec<RawLine> {
    let path = log_path();
    let Ok(text) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|l| serde_json::from_str::<RawLine>(l).ok())
        .collect()
}

const MIN_MS: i64 = 60_000;

/// Aggregate the last `window_minutes` of activity into time buckets.
///
/// `bucket_minutes` controls the bucket size (1 = per-minute for short ranges,
/// 60 = per-hour, 1440 = per-day for long ranges). When <= 0 it is chosen
/// automatically from the window so the graph stays readable at any scale.
#[tauri::command]
fn snapshot(window_minutes: i64, bucket_minutes: Option<i64>) -> Snapshot {
    let lines = read_lines();
    let now = now_ms();
    let cutoff = now - window_minutes * MIN_MS;

    // Auto-pick a bucket size: aim for <= ~360 buckets across the window.
    let bucket_min = match bucket_minutes {
        Some(b) if b > 0 => b,
        _ => {
            if window_minutes <= 360 {
                1
            } else if window_minutes <= 3 * 1440 {
                15
            } else if window_minutes <= 14 * 1440 {
                60
            } else {
                1440
            }
        }
    };
    let bucket_ms = bucket_min * MIN_MS;

    let mut buckets: BTreeMap<i64, MinuteBucket> = BTreeMap::new();
    let mut latest_u5h = 0.0;
    let mut latest_u7d = 0.0;
    let mut latest_reset5h = 0.0;
    let mut latest_reset7d = 0.0;
    let mut latest_plan: Option<String> = None;
    let mut latest_t = 0i64;

    for l in &lines {
        if l.t < cutoff {
            // still track latest utilization from older lines
            if l.t > latest_t {
                latest_t = l.t;
                if let Some(v) = l.u5h {
                    latest_u5h = v;
                }
                if let Some(v) = l.u7d {
                    latest_u7d = v;
                }
                if let Some(v) = l.reset5h {
                    latest_reset5h = v;
                }
                if let Some(v) = l.reset7d {
                    latest_reset7d = v;
                }
                if l.plan.is_some() {
                    latest_plan = l.plan.clone();
                }
            }
            continue;
        }
        let minute = (l.t / bucket_ms) * bucket_ms;
        let b = buckets.entry(minute).or_insert(MinuteBucket {
            minute,
            ..Default::default()
        });
        // utilization samples update window gauges only
        if let Some(v) = l.u5h {
            if v > b.u5h {
                b.u5h = v;
            }
        }
        if let Some(v) = l.u7d {
            if v > b.u7d {
                b.u7d = v;
            }
        }
        if l.kind != "ratelimit" {
            b.input += l.input.unwrap_or(0.0);
            b.output += l.output.unwrap_or(0.0);
            b.cache_read += l.cache_read.unwrap_or(0.0);
            b.cache_write += l.cache_write.unwrap_or(0.0);
            b.bytes_in += l.bytes_in.unwrap_or(0.0);
            b.bytes_out += l.bytes_out.unwrap_or(0.0);
            b.cost += l.cost.unwrap_or(0.0);
            b.requests += 1;
            if l.rate_limited || l.status == 429 {
                b.rate_limited += 1;
            }
        }
        if l.t > latest_t {
            latest_t = l.t;
            if let Some(v) = l.u5h {
                latest_u5h = v;
            }
            if let Some(v) = l.u7d {
                latest_u7d = v;
            }
            if let Some(v) = l.reset5h {
                latest_reset5h = v;
            }
            if let Some(v) = l.reset7d {
                latest_reset7d = v;
            }
            if l.plan.is_some() {
                latest_plan = l.plan.clone();
            }
        }
    }

    let minutes: Vec<MinuteBucket> = buckets.into_values().collect();

    let mut peak_tokens = 0.0;
    let mut peak_minute = 0i64;
    let mut peak_requests = 0u32;
    let mut peak_requests_minute = 0i64;
    let mut rate_limited_total = 0u32;
    let mut total_bytes_in = 0.0;
    let mut total_bytes_out = 0.0;
    let mut total_cost = 0.0;
    for b in &minutes {
        let tok = b.input + b.output;
        if tok > peak_tokens {
            peak_tokens = tok;
            peak_minute = b.minute;
        }
        if b.requests > peak_requests {
            peak_requests = b.requests;
            peak_requests_minute = b.minute;
        }
        rate_limited_total += b.rate_limited;
        total_bytes_in += b.bytes_in;
        total_bytes_out += b.bytes_out;
        total_cost += b.cost;
    }

    Snapshot {
        minutes,
        peak_tokens,
        peak_minute,
        peak_requests,
        peak_requests_minute,
        rate_limited_total,
        latest_u5h,
        latest_u7d,
        reset5h: latest_reset5h,
        reset7d: latest_reset7d,
        plan: latest_plan,
        total_bytes_in,
        total_bytes_out,
        total_cost,
        bucket_minutes: bucket_min,
        window_minutes,
        log_path: log_path().to_string_lossy().to_string(),
        has_data: !lines.is_empty(),
    }
}

/// Per-day summaries for the calendar view, over the last `days` days.
#[tauri::command]
fn day_summaries(days: i64) -> Vec<DaySummary> {
    let lines = read_lines();
    let cutoff = now_ms() - days * 24 * 60 * MIN_MS;
    // group by local day string and by minute (to derive peak TPM per day)
    let mut day_map: BTreeMap<String, DaySummary> = BTreeMap::new();
    let mut day_minute: BTreeMap<(String, i64), f64> = BTreeMap::new();

    for l in &lines {
        if l.t < cutoff {
            continue;
        }
        if l.kind == "ratelimit" {
            continue; // utilization samples aren't requests
        }
        let day = local_day(l.t);
        let s = day_map.entry(day.clone()).or_insert(DaySummary {
            day: day.clone(),
            ..Default::default()
        });
        let inp = l.input.unwrap_or(0.0);
        let out = l.output.unwrap_or(0.0);
        s.input += inp;
        s.output += out;
        s.cache_read += l.cache_read.unwrap_or(0.0);
        s.cache_write += l.cache_write.unwrap_or(0.0);
        s.requests += 1;
        if l.rate_limited || l.status == 429 {
            s.rate_limited += 1;
        }
        let minute = (l.t / MIN_MS) * MIN_MS;
        *day_minute.entry((day, minute)).or_insert(0.0) += inp + out;
    }

    for ((day, _), tpm) in &day_minute {
        if let Some(s) = day_map.get_mut(day) {
            if *tpm > s.peak_tpm {
                s.peak_tpm = *tpm;
            }
        }
    }

    day_map.into_values().collect()
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Convert epoch ms to a local YYYY-MM-DD string (no chrono dep — minimal).
fn local_day(ms: i64) -> String {
    // Use the system's local offset via a simple approach: format with libc-free
    // arithmetic in UTC, then shift by the local offset seconds from `date`.
    // To avoid a chrono dependency we approximate with UTC day boundaries; the
    // collector timestamps are local-clock-based already for practical purposes.
    let secs = ms / 1000;
    let days_since_epoch = secs / 86400;
    // Convert days since 1970-01-01 to Y-M-D (civil from days algorithm).
    let (y, m, d) = civil_from_days(days_since_epoch);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

// Howard Hinnant's days->civil algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ── live rate-limit source (qalcode2 / opencode "/ratelimit" endpoint) ───────
// qalcode2 serves the live Anthropic unified rate-limit snapshot (5h/7d
// utilization + reset timestamps) at GET <server>/ratelimit. We auto-discover
// the local server port and read it with a dependency-free raw HTTP/1.0 GET.

#[derive(Debug, Default, Serialize, Clone)]
pub struct LiveRatelimit {
    available: bool,
    u5h: Option<f64>,
    u7d: Option<f64>,
    /// epoch SECONDS
    reset5h: Option<f64>,
    reset7d: Option<f64>,
    status: Option<String>,
    plan: Option<String>,
    source: Option<String>,
    /// epoch MS when this snapshot was taken by the server (freshness)
    at: Option<f64>,
}

/// Minimal HTTP/1.0 GET over TCP — no external deps. Returns the body string.
fn http_get(host: &str, port: u16, path: &str, timeout_ms: u64) -> Option<String> {
    let addr: std::net::SocketAddr = format!("{host}:{port}").parse().ok()?;
    // connect_timeout is essential: a plain TcpStream::connect to a filtered or
    // unresponsive port can block for tens of seconds and freeze the UI poll.
    let mut stream =
        TcpStream::connect_timeout(&addr, Duration::from_millis(timeout_ms)).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_millis(timeout_ms)))
        .ok()?;
    stream
        .set_write_timeout(Some(Duration::from_millis(timeout_ms)))
        .ok()?;
    let req = format!(
        "GET {path} HTTP/1.0\r\nHost: {host}\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = String::new();
    stream.read_to_string(&mut buf).ok()?;
    // split headers/body on the blank line
    let body = buf.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    if body.is_empty() {
        None
    } else {
        Some(body)
    }
}

/// Discover local bun/node ports via `ss -tlnp` (best effort).
fn local_listen_ports() -> Vec<u16> {
    use std::process::Command;
    let mut ports = Vec::new();
    if let Ok(out) = Command::new("ss").args(["-tlnp"]).output() {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if !line.contains("127.0.0.1") {
                continue;
            }
            if !(line.contains("bun") || line.contains("node")) {
                continue;
            }
            if let Some(idx) = line.find("127.0.0.1:") {
                let rest = &line[idx + "127.0.0.1:".len()..];
                let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(p) = num.parse::<u16>() {
                    if !ports.contains(&p) {
                        ports.push(p);
                    }
                }
            }
        }
    }
    ports
}

fn parse_ratelimit(body: &str, source: &str) -> Option<LiveRatelimit> {
    let j: serde_json::Value = serde_json::from_str(body).ok()?;
    let u5h = j.get("unified5hUtilization").and_then(|v| v.as_f64());
    let u7d = j.get("unified7dUtilization").and_then(|v| v.as_f64());
    if u5h.is_none() && u7d.is_none() {
        return None;
    }
    Some(LiveRatelimit {
        available: true,
        u5h,
        u7d,
        reset5h: j.get("unified5hReset").and_then(|v| v.as_f64()),
        reset7d: j.get("unified7dReset").and_then(|v| v.as_f64()),
        status: j
            .get("unifiedStatus")
            .and_then(|v| v.as_str())
            .map(String::from),
        plan: j
            .get("planLabel")
            .and_then(|v| v.as_str())
            .map(String::from),
        source: Some(source.to_string()),
        at: j.get("at").and_then(|v| v.as_f64()),
    })
}

// Cache: (last_result, fetched_at_ms, last_good_port). Avoids rescanning every
// 2s poll and keeps the UI responsive even when no source is present.
static RL_CACHE: std::sync::OnceLock<std::sync::Mutex<(LiveRatelimit, i64, Option<u16>)>> =
    std::sync::OnceLock::new();

/// Poll qalcode2's /ratelimit for the live 5h/7d windows + reset times.
/// Honors CLAUDE_PULSE_RATELIMIT_URL (host:port or full URL) if set.
#[tauri::command]
fn ratelimit() -> LiveRatelimit {
    let cache = RL_CACHE.get_or_init(|| std::sync::Mutex::new((LiveRatelimit::default(), 0, None)));
    let now = now_ms();
    // serve cached result if fresh (< 4s old)
    if let Ok(guard) = cache.lock() {
        if now - guard.1 < 4000 {
            return guard.0.clone();
        }
    }

    let mut result = LiveRatelimit::default();
    let mut good_port: Option<u16> = None;

    // 1) explicit override (strict — no scanning)
    if let Ok(url) = std::env::var("CLAUDE_PULSE_RATELIMIT_URL") {
        if let Some((host, port, path)) = split_url(&url) {
            if let Some(body) = http_get(&host, port, &path, 1200) {
                if let Some(rl) = parse_ratelimit(&body, &url) {
                    result = rl;
                }
            }
        }
    } else {
        // 2) Scan ALL local servers and pick the FRESHEST snapshot (newest `at`).
        //    Multiple qalcode2 servers from old sessions may be running, each
        //    reporting different (stale) data — we must not show those. Reject
        //    anything older than 5 minutes.
        const MAX_AGE_MS: f64 = 5.0 * 60_000.0;
        let mut best_at: f64 = -1.0;
        for port in local_listen_ports() {
            if let Some(body) = http_get("127.0.0.1", port, "/ratelimit", 800) {
                let src = format!("http://127.0.0.1:{port}/ratelimit");
                if let Some(rl) = parse_ratelimit(&body, &src) {
                    let at = rl.at.unwrap_or(0.0);
                    if (now as f64) - at > MAX_AGE_MS {
                        continue; // stale — skip
                    }
                    if at > best_at {
                        best_at = at;
                        result = rl;
                        good_port = Some(port);
                    }
                }
            }
        }
    }

    if let Ok(mut guard) = cache.lock() {
        *guard = (result.clone(), now, good_port.or(guard.2));
    }
    result
}

fn split_url(url: &str) -> Option<(String, u16, String)> {
    let s = url.strip_prefix("http://").unwrap_or(url);
    let (hostport, path) = match s.find('/') {
        Some(i) => (&s[..i], &s[i..]),
        None => (s, "/ratelimit"),
    };
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().ok()?),
        None => (hostport.to_string(), 80u16),
    };
    Some((host, port, path.to_string()))
}

// ── self-sufficient opencode/qalcode2 token importer (no collector needed) ───
// The desktop app pulls per-message token usage straight from a running
// opencode/qalcode2 server's HTTP API and appends it to usage.jsonl, so just
// launching the app populates the tokens/min graph — no separate collector.

use std::collections::HashSet;
use std::sync::Mutex;

// msgIds we've already written, so we never double-count across imports.
static SEEN_MSGS: std::sync::OnceLock<Mutex<HashSet<String>>> = std::sync::OnceLock::new();
static LAST_IMPORT_MS: std::sync::OnceLock<Mutex<i64>> = std::sync::OnceLock::new();
// (last rate-limit signature, last write ms) — to throttle ratelimit samples.
static RL_SAMPLE_STATE: std::sync::OnceLock<Mutex<(String, i64)>> = std::sync::OnceLock::new();

/// HTTP GET that reads a (possibly large) body to EOF with a generous timeout.
fn http_get_big(host: &str, port: u16, path: &str, timeout_ms: u64) -> Option<Vec<u8>> {
    let addr: std::net::SocketAddr = format!("{host}:{port}").parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(1000)).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_millis(timeout_ms)))
        .ok()?;
    let req = format!(
        "GET {path} HTTP/1.0\r\nHost: {host}\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).ok()?;
    // split headers/body at the first blank line
    let sep = b"\r\n\r\n";
    let pos = buf.windows(4).position(|w| w == sep)?;
    Some(buf[pos + 4..].to_vec())
}

/// Find the freshest opencode server port (newest /ratelimit `at`).
fn freshest_opencode_port() -> Option<u16> {
    if let Ok(url) = std::env::var("CLAUDE_PULSE_OPENCODE_URL") {
        // host:port → port
        if let Some((_h, port, _p)) = split_url(&url) {
            return Some(port);
        }
    }
    let now = now_ms() as f64;
    let mut best: Option<(u16, f64)> = None;
    for port in local_listen_ports() {
        if let Some(body) = http_get("127.0.0.1", port, "/ratelimit", 700) {
            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&body) {
                // must look like a ratelimit snapshot
                if j.get("unified5hUtilization").is_some() || j.get("unified7dUtilization").is_some()
                {
                    let at = j.get("at").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    if now - at <= 5.0 * 60_000.0 {
                        if best.map(|(_, b)| at > b).unwrap_or(true) {
                            best = Some((port, at));
                        }
                    }
                }
            }
        }
    }
    best.map(|(p, _)| p)
}

/// Pull new assistant-message token counts from the freshest opencode server and
/// append them to usage.jsonl. Returns the number of new lines written.
/// Throttled so it runs at most once every few seconds.
fn import_opencode_tokens() -> usize {
    let last = LAST_IMPORT_MS.get_or_init(|| Mutex::new(0));
    let now = now_ms();
    {
        let mut g = last.lock().unwrap();
        if now - *g < 4000 {
            return 0;
        }
        *g = now;
    }
    let Some(port) = freshest_opencode_port() else {
        return 0;
    };

    // Also persist a rate-limit SAMPLE (5h/7d utilization + resets + plan) to the
    // log so the windows stay populated AND we build usage-limit history over
    // time. Throttled: only write when the value changed or >=55s since last.
    if let Some(rlbody) = http_get("127.0.0.1", port, "/ratelimit", 800) {
        if let Ok(j) = serde_json::from_str::<serde_json::Value>(&rlbody) {
            let u5h = j.get("unified5hUtilization").and_then(|v| v.as_f64());
            let u7d = j.get("unified7dUtilization").and_then(|v| v.as_f64());
            if u5h.is_some() || u7d.is_some() {
                let sig = format!(
                    "{:?}|{:?}|{:?}|{:?}",
                    u5h,
                    u7d,
                    j.get("unified5hReset").and_then(|v| v.as_f64()),
                    j.get("unified7dReset").and_then(|v| v.as_f64())
                );
                let st = RL_SAMPLE_STATE.get_or_init(|| Mutex::new((String::new(), 0)));
                let mut should = false;
                {
                    let mut g = st.lock().unwrap();
                    if g.0 != sig || now - g.1 >= 55_000 {
                        g.0 = sig;
                        g.1 = now;
                        should = true;
                    }
                }
                if should {
                    let line = serde_json::json!({
                        "t": now,
                        "kind": "ratelimit",
                        "u5h": u5h,
                        "u7d": u7d,
                        "reset5h": j.get("unified5hReset").and_then(|v| v.as_f64()),
                        "reset7d": j.get("unified7dReset").and_then(|v| v.as_f64()),
                        "rlStatus": j.get("unifiedStatus").and_then(|v| v.as_str()),
                        "plan": j.get("planLabel").and_then(|v| v.as_str()),
                        "source": "opencode-live-rust",
                    });
                    if let Some(parent) = log_path().parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    if let Ok(mut f) = fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(log_path())
                    {
                        use std::io::Write as _;
                        let _ = f.write_all((line.to_string() + "\n").as_bytes());
                    }
                }
            }
        }
    }

    // list sessions
    let Some(sbody) = http_get_big("127.0.0.1", port, "/session", 2500) else {
        return 0;
    };
    let Ok(sessions) = serde_json::from_slice::<serde_json::Value>(&sbody) else {
        return 0;
    };
    let Some(arr) = sessions.as_array() else {
        return 0;
    };
    // newest sessions first
    let mut sess: Vec<&serde_json::Value> = arr.iter().collect();
    sess.sort_by(|a, b| {
        let ta = a
            .get("time")
            .and_then(|t| t.get("updated"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let tb = b
            .get("time")
            .and_then(|t| t.get("updated"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        tb.partial_cmp(&ta).unwrap_or(std::cmp::Ordering::Equal)
    });

    let seen = SEEN_MSGS.get_or_init(|| Mutex::new(HashSet::new()));
    // First run scans more sessions to backfill; later runs just the active few.
    let first_run = seen.lock().unwrap().is_empty();
    let scan_n = if first_run { 12 } else { 3 };

    let mut new_lines: Vec<String> = Vec::new();
    for s in sess.into_iter().take(scan_n) {
        let Some(sid) = s.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        let path = format!("/session/{sid}/message");
        let Some(mbody) = http_get_big("127.0.0.1", port, &path, 3000) else {
            continue;
        };
        let Ok(msgs) = serde_json::from_slice::<serde_json::Value>(&mbody) else {
            continue;
        };
        let Some(marr) = msgs.as_array() else {
            continue;
        };
        for item in marr {
            // message may be {info:{...}} or flat
            let m = item.get("info").unwrap_or(item);
            if m.get("role").and_then(|v| v.as_str()) != Some("assistant") {
                continue;
            }
            let Some(id) = m.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            // only finalized messages (tokens trustworthy on completion)
            let completed = m
                .get("time")
                .and_then(|t| t.get("completed"))
                .is_some();
            if !completed {
                continue;
            }
            let tk = m.get("tokens");
            let input = tk
                .and_then(|t| t.get("input"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let output = tk
                .and_then(|t| t.get("output"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let cache_read = tk
                .and_then(|t| t.get("cache"))
                .and_then(|c| c.get("read"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let cache_write = tk
                .and_then(|t| t.get("cache"))
                .and_then(|c| c.get("write"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            if input + output + cache_read + cache_write == 0.0 {
                continue;
            }
            {
                let mut sg = seen.lock().unwrap();
                if sg.contains(id) {
                    continue;
                }
                sg.insert(id.to_string());
            }
            let t = m
                .get("time")
                .and_then(|tt| tt.get("completed"))
                .and_then(|v| v.as_f64())
                .or_else(|| {
                    m.get("time")
                        .and_then(|tt| tt.get("created"))
                        .and_then(|v| v.as_f64())
                })
                .unwrap_or(now as f64) as i64;
            let model = m
                .get("modelID")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let line = serde_json::json!({
                "t": t,
                "kind": "request",
                "status": 200,
                "input": input,
                "output": output,
                "cacheRead": cache_read,
                "cacheWrite": cache_write,
                "model": model,
                "rateLimited": false,
                "durationMs": 0,
                "source": "opencode-live-rust",
                "msgId": id,
            });
            new_lines.push(line.to_string());
        }
    }

    if new_lines.is_empty() {
        return 0;
    }
    // append to the log
    use std::io::Write as _;
    if let Some(parent) = log_path().parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let _ = f.write_all((new_lines.join("\n") + "\n").as_bytes());
    }
    new_lines.len()
}

/// Tauri command: trigger an import (called by the frontend on its poll loop).
#[tauri::command]
fn import_usage() -> usize {
    import_opencode_tokens()
}

/// App version (from Cargo.toml) so the UI can show which build is running.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Debug helper: print the 60-min snapshot as JSON and exit. Run with
/// `claude-pulse --debug-snapshot`.
pub fn debug_snapshot() {
    let n = import_opencode_tokens();
    eprintln!("[debug] imported {n} lines");
    let s = snapshot(60, None);
    println!("{}", serde_json::to_string_pretty(&s).unwrap());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Explicitly set the window icon from the embedded PNG so the taskbar
            // / window decoration shows it even for unbundled (target/release)
            // runs where the platform might not pick up the bundle icon.
            use tauri::Manager;
            if let Some(win) = app.get_webview_window("main") {
                let bytes = include_bytes!("../icons/512x512.png");
                if let Ok(img) = tauri::image::Image::from_bytes(bytes) {
                    let _ = win.set_icon(img);
                }
            }
            // Launch the backend ourselves: a thread that pulls live opencode/
            // qalcode2 token usage into the log every few seconds. This makes the
            // app self-sufficient — opening it populates the graph, no separate
            // collector process required.
            eprintln!(
                "[claude-pulse] v{} started — importing live usage every 5s",
                env!("CARGO_PKG_VERSION")
            );
            std::thread::spawn(|| {
                // import immediately on startup so data shows fast, then loop
                let n = import_opencode_tokens();
                eprintln!("[claude-pulse] initial import: {n} lines");
                loop {
                    std::thread::sleep(Duration::from_secs(5));
                    let _ = import_opencode_tokens();
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            snapshot,
            day_summaries,
            ratelimit,
            import_usage,
            app_version
        ])
        .run(tauri::generate_context!())
        .expect("error while running claude-pulse");
}
