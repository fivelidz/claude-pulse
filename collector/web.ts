/**
 * claude-pulse web dashboard — the "no-Tauri" path.
 *
 * Serves the SAME frontend (app/src) over HTTP plus a small JSON API that
 * mirrors the Tauri Rust commands (`snapshot`, `day_summaries`). This lets
 * anyone view their usage in a browser — on this machine or a phone on the
 * same LAN — without downloading or building the desktop app.
 *
 * It reads the exact same usage.jsonl the collector writes and the desktop
 * app reads. Metadata only — there are no credentials or prompt bodies in
 * that file, so nothing sensitive is ever served.
 *
 * Zero dependencies — pure Bun. Launched by proxy.ts when `--web` is passed,
 * or standalone:  bun run collector/web.ts
 */

import { readFile, stat } from "fs/promises";
import { homedir } from "os";
import path from "path";
import { spawnSync } from "child_process";

const DATA_DIR = path.join(
  process.env["XDG_DATA_HOME"] ?? path.join(homedir(), ".local", "share"),
  "claude-pulse",
);
const LOG_FILE = path.join(DATA_DIR, "usage.jsonl");
const APP_DIR = path.join(import.meta.dir, "..", "app", "src");

const MIN_MS = 60_000;

// ── live rate-limit source (qalcode2 / opencode "/ratelimit" endpoint) ───────
// qalcode2 exposes the live Anthropic unified rate-limit snapshot — including
// the 5h/7d utilization AND their reset timestamps — at GET <server>/ratelimit.
// We auto-discover the server port (or honor CLAUDE_PULSE_RATELIMIT_URL) and
// poll it so claude-pulse shows the REAL current limits + reset countdowns
// even before the proxy has logged anything.
const RATELIMIT_URL = process.env["CLAUDE_PULSE_RATELIMIT_URL"]; // explicit override
let cachedRatelimit: any = undefined;
let cachedRatelimitAt = 0;

function listLocalBunPorts(): number[] {
  // Best-effort: parse `ss -tlnp` for bun servers bound to 127.0.0.1.
  try {
    const out = spawnSync("ss", ["-tlnp"], { encoding: "utf8", timeout: 2000 });
    const ports = new Set<number>();
    for (const line of (out.stdout ?? "").split("\n")) {
      if (!line.includes("127.0.0.1")) continue;
      if (!/bun|node/.test(line)) continue;
      const m = line.match(/127\.0\.0\.1:(\d+)/);
      if (m) ports.add(Number(m[1]));
    }
    return [...ports];
  } catch {
    return [];
  }
}

function looksLikeRatelimit(j: any): boolean {
  return (
    j &&
    (typeof j.unified5hUtilization === "number" ||
      typeof j.unified7dUtilization === "number")
  );
}

async function fetchRatelimitFrom(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return looksLikeRatelimit(j) ? j : null;
  } catch {
    return null;
  }
}

// Max age (ms) of a /ratelimit snapshot we'll trust. Multiple stale qalcode2
// servers from old sessions can be running; we must NOT show their data.
const MAX_RL_AGE_MS = 5 * 60_000; // 5 minutes

// Returns the FRESHEST live rate-limit snapshot across all local servers.
// Critical: when several qalcode2 servers run (old + current sessions), each
// reports different data. We pick the one whose `at` timestamp is newest, and
// reject anything older than MAX_RL_AGE_MS so stale accounts never leak in.
async function getLiveRatelimit(): Promise<any | null> {
  const now = Date.now();
  if (cachedRatelimit !== undefined && now - cachedRatelimitAt < 3000)
    return cachedRatelimit;

  const urls = RATELIMIT_URL
    ? [RATELIMIT_URL]
    : listLocalBunPorts().map((p) => `http://127.0.0.1:${p}/ratelimit`);

  const results = await Promise.all(
    urls.map(async (url) => {
      const j = await fetchRatelimitFrom(url);
      return j ? { url, j } : null;
    }),
  );

  let best: { url: string; j: any } | null = null;
  for (const r of results) {
    if (!r) continue;
    const at = Number(r.j.at ?? 0);
    if (now - at > MAX_RL_AGE_MS) continue; // too stale — skip
    if (!best || at > Number(best.j.at ?? 0)) best = r;
  }

  cachedRatelimitAt = now;
  if (!best) {
    cachedRatelimit = null;
    return null;
  }
  const j = best.j;
  cachedRatelimit = {
    u5h: j.unified5hUtilization ?? null,
    u7d: j.unified7dUtilization ?? null,
    reset5h: j.unified5hReset ?? 0,
    reset7d: j.unified7dReset ?? 0,
    status: j.unifiedStatus ?? null,
    plan: j.planLabel ?? null,
    source: best.url,
    at: j.at,
  };
  return cachedRatelimit;
}

type Raw = {
  t: number;
  kind?: string; // "request" (default) | "ratelimit" (utilization sample only)
  status?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  bytesIn?: number;
  bytesOut?: number;
  cost?: number;
  rateLimited?: boolean;
  u5h?: number;
  u7d?: number;
  reset5h?: number;
  reset7d?: number;
  plan?: string;
  model?: string;
};

async function readLines(): Promise<Raw[]> {
  let text: string;
  try {
    text = await readFile(LOG_FILE, "utf8");
  } catch {
    return [];
  }
  const out: Raw[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

// ── snapshot: per-minute buckets for the last `windowMinutes` ────────────────
// `bucketMinutes`: 0 = auto-pick from the window so long ranges stay readable.
function buildSnapshot(lines: Raw[], windowMinutes: number, bucketMinutes = 0) {
  const now = Date.now();
  const cutoff = now - windowMinutes * MIN_MS;
  // auto bucket sizing: per-minute up to 6h, then 15m, 1h, 1d.
  const bucketMin =
    bucketMinutes > 0
      ? bucketMinutes
      : windowMinutes <= 360
        ? 1
        : windowMinutes <= 3 * 1440
          ? 15
          : windowMinutes <= 14 * 1440
            ? 60
            : 1440;
  const bucketMs = bucketMin * MIN_MS;
  const buckets = new Map<number, any>();
  let latestU5h = 0,
    latestU7d = 0,
    latestReset5h = 0,
    latestReset7d = 0,
    latestPlan: string | undefined,
    latestT = 0;

  for (const l of lines) {
    // Track most-recent rate-limit window values from ANY line type.
    if (l.t > latestT) {
      latestT = l.t;
      if (typeof l.u5h === "number") latestU5h = l.u5h;
      if (typeof l.u7d === "number") latestU7d = l.u7d;
      if (typeof l.reset5h === "number") latestReset5h = l.reset5h;
      if (typeof l.reset7d === "number") latestReset7d = l.reset7d;
      if (l.plan) latestPlan = l.plan;
    }
    if (l.t < cutoff) continue;
    const minute = Math.floor(l.t / bucketMs) * bucketMs;
    let b = buckets.get(minute);
    if (!b) {
      b = {
        minute,
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        bytes_in: 0,
        bytes_out: 0,
        cost: 0,
        requests: 0,
        rate_limited: 0,
        u5h: 0,
        u7d: 0,
      };
      buckets.set(minute, b);
    }
    // Utilization samples (kind:"ratelimit") only update the window gauges —
    // they are NOT requests and carry no tokens.
    if (typeof l.u5h === "number" && l.u5h > b.u5h) b.u5h = l.u5h;
    if (typeof l.u7d === "number" && l.u7d > b.u7d) b.u7d = l.u7d;
    if (l.kind === "ratelimit") continue;

    b.input += l.input ?? 0;
    b.output += l.output ?? 0;
    b.cache_read += l.cacheRead ?? 0;
    b.cache_write += l.cacheWrite ?? 0;
    b.bytes_in += l.bytesIn ?? 0;
    b.bytes_out += l.bytesOut ?? 0;
    b.cost += l.cost ?? 0;
    b.requests += 1;
    if (l.rateLimited || l.status === 429) b.rate_limited += 1;
  }

  const minutes = [...buckets.values()].sort((a, b) => a.minute - b.minute);

  let peak_tokens = 0,
    peak_minute = 0,
    peak_requests = 0,
    peak_requests_minute = 0,
    rate_limited_total = 0,
    total_bytes_in = 0,
    total_bytes_out = 0,
    total_cost = 0;
  for (const b of minutes) {
    const tok = b.input + b.output;
    if (tok > peak_tokens) {
      peak_tokens = tok;
      peak_minute = b.minute;
    }
    if (b.requests > peak_requests) {
      peak_requests = b.requests;
      peak_requests_minute = b.minute;
    }
    rate_limited_total += b.rate_limited;
    total_bytes_in += b.bytes_in;
    total_bytes_out += b.bytes_out;
    total_cost += b.cost;
  }

  return {
    minutes,
    peak_tokens,
    peak_minute,
    peak_requests,
    peak_requests_minute,
    rate_limited_total,
    total_bytes_in,
    total_bytes_out,
    total_cost,
    latest_u5h: latestU5h,
    latest_u7d: latestU7d,
    reset5h: latestReset5h,
    reset7d: latestReset7d,
    plan: latestPlan,
    bucket_minutes: bucketMin,
    window_minutes: windowMinutes,
    log_path: LOG_FILE,
    has_data: lines.length > 0,
  };
}

// ── day_summaries: per-day rollups for the last `days` days ──────────────────
function localDay(ms: number): string {
  const d = new Date(ms);
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

function buildDays(lines: Raw[], days: number) {
  const cutoff = Date.now() - days * 24 * 60 * MIN_MS;
  const dayMap = new Map<string, any>();
  const dayMinute = new Map<string, number>(); // `${day}|${minute}` -> tokens

  for (const l of lines) {
    if (l.t < cutoff) continue;
    if (l.kind === "ratelimit") continue; // utilization samples aren't requests
    const day = localDay(l.t);
    let s = dayMap.get(day);
    if (!s) {
      s = {
        day,
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        bytes_in: 0,
        bytes_out: 0,
        cost: 0,
        requests: 0,
        rate_limited: 0,
        peak_tpm: 0,
      };
      dayMap.set(day, s);
    }
    const inp = l.input ?? 0;
    const out = l.output ?? 0;
    s.input += inp;
    s.output += out;
    s.cache_read += l.cacheRead ?? 0;
    s.cache_write += l.cacheWrite ?? 0;
    s.bytes_in += l.bytesIn ?? 0;
    s.bytes_out += l.bytesOut ?? 0;
    s.cost += l.cost ?? 0;
    s.requests += 1;
    if (l.rateLimited || l.status === 429) s.rate_limited += 1;
    const minute = Math.floor(l.t / MIN_MS) * MIN_MS;
    const key = `${day}|${minute}`;
    dayMinute.set(key, (dayMinute.get(key) ?? 0) + inp + out);
  }

  for (const [key, tpm] of dayMinute) {
    const day = key.split("|")[0];
    const s = dayMap.get(day);
    if (s && tpm > s.peak_tpm) s.peak_tpm = tpm;
  }

  return [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day));
}

// ── static file serving for app/src ──────────────────────────────────────────
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveStatic(pathname: string): Promise<Response> {
  let rel = pathname === "/" ? "/index.html" : pathname;
  // prevent path traversal
  const safe = path
    .normalize(rel)
    .replace(/^(\.\.[/\\])+/, "")
    .replace(/^[/\\]+/, "");
  const file = path.join(APP_DIR, safe);
  if (!file.startsWith(APP_DIR)) return new Response("forbidden", { status: 403 });
  try {
    const data = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    return new Response(data, {
      headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

const json = (obj: unknown) =>
  new Response(JSON.stringify(obj), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

export function startWeb(port: number): void {
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;

      if (p === "/api/health") return json({ ok: true, log: LOG_FILE });

      if (p === "/api/version") return json({ version: "0.5.0" });

      if (p === "/api/ratelimit") {
        const rl = await getLiveRatelimit();
        return json(rl ?? { available: false });
      }

      if (p === "/api/snapshot") {
        const minutes = Math.max(
          1,
          // cap at 365 days (frontend max range is 90d; allow headroom so older
          // imported history is still queryable)
          Math.min(365 * 24 * 60, Number(url.searchParams.get("minutes") ?? 60)),
        );
        const bucketParam = url.searchParams.get("bucket");
        const bucket = bucketParam ? Number(bucketParam) : 0;
        const snap = buildSnapshot(await readLines(), minutes, bucket);
        // PRIMARY source is the user's OWN proxied traffic — the collector logs
        // the anthropic-ratelimit-unified-* headers (5h/7d + reset times) from
        // every response, so the limits come from the user's account with no
        // external dependency. An optional qalcode2/opencode /ratelimit endpoint
        // is used ONLY to fill gaps when the log has no rate-limit data yet, and
        // to add the (qalcode2-derived) plan label.
        const haveLogLimits = snap.latest_u5h > 0 || snap.latest_u7d > 0;
        const live = await getLiveRatelimit();
        if (live) {
          if (!haveLogLimits) {
            if (live.u5h != null) snap.latest_u5h = live.u5h;
            if (live.u7d != null) snap.latest_u7d = live.u7d;
            if (live.reset5h) snap.reset5h = live.reset5h;
            if (live.reset7d) snap.reset7d = live.reset7d;
          }
          (snap as any).plan = live.plan;
          (snap as any).rl_status = live.status;
        }
        return json(snap);
      }

      if (p === "/api/days") {
        const days = Math.max(
          1,
          Math.min(365, Number(url.searchParams.get("days") ?? 35)),
        );
        return json(buildDays(await readLines(), days));
      }

      // everything else: static frontend
      return serveStatic(p);
    },
  });

  console.log(
    `[claude-pulse] web dashboard on http://localhost:${server.port}`,
  );
  console.log(
    `[claude-pulse]   open it in any browser (or on your phone via this machine's LAN IP)`,
  );
}

// Allow standalone: `bun run collector/web.ts [port]`
if (import.meta.main) {
  const portArg = process.argv[2];
  const port = Number(
    portArg ?? process.env["CLAUDE_PULSE_WEB_PORT"] ?? 47822,
  );
  // sanity-check app dir exists
  try {
    await stat(path.join(APP_DIR, "index.html"));
  } catch {
    console.error(
      `[claude-pulse] cannot find frontend at ${APP_DIR} — run from the repo.`,
    );
    process.exit(1);
  }
  startWeb(port);
}
