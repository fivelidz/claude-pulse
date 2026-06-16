// Claude Pulse — frontend. Vanilla JS + canvas, no framework.
// Single-page dashboard. Pulls aggregated data from the backend (Tauri
// commands, or the collector --web JSON API) and renders, all at once:
//   - an accelerometer-style live gauge (tokens/min needle)
//   - key stat tiles
//   - 5-hour and 7-day rolling rate-limit window utilization bars
//   - a per-minute "usage over time" graph with peak + rate-limit markers
//   - a calendar of daily usage
//
// Falls back to a demo data generator when neither backend is present (so the
// frontend can be developed in a plain browser).

const invoke = window.__TAURI__?.core?.invoke;
const tauriWindow = window.__TAURI__?.window;

// When served by the collector's `--web` mode, a JSON API is available at
// /api/snapshot and /api/days. We probe once; if it answers, use it. Otherwise
// fall back to demo data (plain browser dev with no backend at all).
let webApi = null; // null = unknown, true = available, false = absent
async function probeWebApi() {
  if (invoke) return false; // Tauri takes priority
  if (webApi !== null) return webApi;
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    webApi = r.ok;
  } catch {
    webApi = false;
  }
  return webApi;
}

// ── data access ────────────────────────────────────────────────────────────
// Trigger a fresh import (Tauri pulls live opencode/qalcode2 token usage). Belt
// + suspenders alongside the Rust background thread, so the UI always drives an
// update while it's open even if the timer thread ever stalls.
async function triggerImport() {
  if (!invoke) return;
  try {
    await invoke("import_usage");
  } catch {}
}

async function getSnapshot(windowMinutes) {
  if (invoke)
    return invoke("snapshot", { windowMinutes, bucketMinutes: null });
  if (await probeWebApi()) {
    try {
      const r = await fetch(`/api/snapshot?minutes=${windowMinutes}`, {
        cache: "no-store",
      });
      if (r.ok) return await r.json();
    } catch {}
  }
  return demoSnapshot(windowMinutes);
}

// Live rate-limit snapshot from qalcode2 (real 5h/7d % + reset times).
// Tauri: the Rust `ratelimit` command polls qalcode2's /ratelimit directly.
// Web: the collector exposes /api/ratelimit doing the same.
async function getLiveRatelimit() {
  if (invoke) {
    try {
      const j = await invoke("ratelimit");
      if (j && j.available !== false && j.available !== undefined) return j;
    } catch {}
    return null;
  }
  if (await probeWebApi()) {
    try {
      const r = await fetch("/api/ratelimit", { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        if (j && j.available !== false) return j;
      }
    } catch {}
  }
  return null;
}
async function getDays(days) {
  if (invoke) return invoke("day_summaries", { days });
  if (await probeWebApi()) {
    try {
      const r = await fetch(`/api/days?days=${days}`, { cache: "no-store" });
      if (r.ok) return await r.json();
    } catch {}
  }
  return demoDays(days);
}

// ── state ────────────────────────────────────────────────────────────────
let snap = null;
let days = [];
let needle = 0; // smoothed gauge needle
let gaugeMax = 20000; // auto-scaling gauge ceiling
let rangeMinutes = 60; // graph window

// ── gauge (accelerometer) ──────────────────────────────────────────────────
const gauge = document.getElementById("gauge");
const gctx = gauge.getContext("2d");

// Round a value up to a "nice" axis maximum (1/2/5 × 10^n).
function niceMax(v) {
  if (v <= 0) return 10000;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const f = v / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * base;
}

function drawGauge(tpm, peakTpm, rateLimited) {
  const w = gauge._cssW || gauge.width,
    h = gauge._cssH || gauge.height;
  const cx = w / 2,
    cy = h * 0.84,
    r = Math.min(w, h) * 0.58;
  gctx.clearRect(0, 0, w, h);

  // STABLE scale: snap the max to a nice round number that only grows (so the
  // needle position is meaningful and doesn't jitter every frame).
  const want = niceMax(Math.max(peakTpm, tpm, 4000) * 1.1);
  if (want > gaugeMax) gaugeMax = want; // grow only
  const gMax = gaugeMax;

  const start = Math.PI * 0.86,
    end = Math.PI * 2.14;
  const sweep = end - start;
  const angAt = (frac) => start + sweep * Math.max(0, Math.min(1, frac));

  // colored zones
  const zones = [
    [0.0, 0.6, "#4caf82"],
    [0.6, 0.85, "#f5c451"],
    [0.85, 1.0, "#e0564a"],
  ];
  gctx.lineWidth = 16;
  gctx.lineCap = "butt";
  for (const [a, b, col] of zones) {
    gctx.beginPath();
    gctx.strokeStyle = col;
    gctx.arc(cx, cy, r, start + sweep * a, start + sweep * b);
    gctx.stroke();
  }

  // ticks + NUMERIC LABELS at 0, 25, 50, 75, 100% of the scale
  gctx.fillStyle = "#8a93a6";
  gctx.font = "10px ui-monospace, monospace";
  for (let i = 0; i <= 4; i++) {
    const frac = i / 4;
    const ang = angAt(frac);
    const r1 = r - 22,
      r2 = r - 9;
    gctx.strokeStyle = "#4a5160";
    gctx.lineWidth = 2;
    gctx.beginPath();
    gctx.moveTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
    gctx.lineTo(cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2);
    gctx.stroke();
    // label just outside the arc
    const lr = r + 16;
    const lx = cx + Math.cos(ang) * lr;
    const ly = cy + Math.sin(ang) * lr;
    gctx.textAlign = frac < 0.4 ? "right" : frac > 0.6 ? "left" : "center";
    gctx.textBaseline = "middle";
    gctx.fillText(fmt(Math.round(gMax * frac)), lx, ly);
  }
  gctx.textBaseline = "alphabetic";

  // RATE-LIMIT HISTORY: small red ticks at the tokens/min levels where 429s
  // happened (your observed throttle points). Helps you see your effective
  // ceiling at a glance.
  const rlLevels = (snap?.minutes || [])
    .filter((m) => m.rate_limited > 0)
    .map((m) => m.input + m.output)
    .filter((v) => v > 0);
  if (rlLevels.length) {
    gctx.strokeStyle = "#e0564a";
    gctx.lineWidth = 2;
    for (const lvl of rlLevels) {
      const ang = angAt(lvl / gMax);
      gctx.beginPath();
      gctx.moveTo(cx + Math.cos(ang) * (r - 9), cy + Math.sin(ang) * (r - 9));
      gctx.lineTo(cx + Math.cos(ang) * (r + 10), cy + Math.sin(ang) * (r + 10));
      gctx.stroke();
    }
    // lowest observed 429 level = your effective ceiling — draw a dashed line
    const ceiling = Math.min(...rlLevels);
    const ca = angAt(ceiling / gMax);
    gctx.strokeStyle = "#e0564a";
    gctx.setLineDash([3, 3]);
    gctx.lineWidth = 1.5;
    gctx.beginPath();
    gctx.moveTo(cx, cy);
    gctx.lineTo(cx + Math.cos(ca) * (r + 10), cy + Math.sin(ca) * (r + 10));
    gctx.stroke();
    gctx.setLineDash([]);
  }

  // peak marker (amber)
  if (peakTpm > 0) {
    const pa = angAt(peakTpm / gMax);
    gctx.strokeStyle = "#f5c451";
    gctx.lineWidth = 3;
    gctx.beginPath();
    gctx.moveTo(cx + Math.cos(pa) * (r - 28), cy + Math.sin(pa) * (r - 28));
    gctx.lineTo(cx + Math.cos(pa) * (r + 8), cy + Math.sin(pa) * (r + 8));
    gctx.stroke();
  }

  // needle
  needle += (tpm - needle) * 0.18;
  const na = angAt(needle / gMax);
  gctx.strokeStyle = rateLimited ? "#e0564a" : "#d97757";
  gctx.lineWidth = 4;
  gctx.lineCap = "round";
  gctx.beginPath();
  gctx.moveTo(cx, cy);
  gctx.lineTo(cx + Math.cos(na) * (r - 6), cy + Math.sin(na) * (r - 6));
  gctx.stroke();
  gctx.fillStyle = rateLimited ? "#e0564a" : "#d97757";
  gctx.beginPath();
  gctx.arc(cx, cy, 7, 0, Math.PI * 2);
  gctx.fill();

  // center readout
  gctx.fillStyle = "#e6e9ef";
  gctx.textAlign = "center";
  gctx.font = "600 28px ui-monospace, monospace";
  gctx.fillText(fmt(Math.round(needle)), cx, cy - r * 0.40);
  gctx.fillStyle = "#7a8294";
  gctx.font = "11px ui-monospace, monospace";
  gctx.fillText("tokens / min", cx, cy - r * 0.40 + 18);
  // scale caption
  gctx.fillStyle = "#5a6172";
  gctx.font = "10px ui-monospace, monospace";
  gctx.fillText("scale 0–" + fmt(gMax) + " tok/min", cx, cy + 16);

  if (rateLimited) {
    gctx.fillStyle = "#e0564a";
    gctx.font = "600 13px ui-monospace, monospace";
    gctx.fillText("⛔ RATE LIMITED", cx, cy + 32);
  } else if (rlLevels.length) {
    gctx.fillStyle = "#e0564a";
    gctx.font = "10px ui-monospace, monospace";
    gctx.fillText(
      "⛔ seen at ~" + fmt(Math.min(...rlLevels)) + "/min",
      cx,
      cy + 32,
    );
  }
}

// ── usage-over-time graph ───────────────────────────────────────────────────
const timeline = document.getElementById("timeline");
const tctx = timeline.getContext("2d");

function drawTimeline(s) {
  const w = timeline._cssW || timeline.width,
    h = timeline._cssH || timeline.height;
  tctx.clearRect(0, 0, w, h);
  const pad = { l: 56, r: 14, t: 18, b: 28 };
  const plotW = w - pad.l - pad.r,
    plotH = h - pad.t - pad.b;
  // Build a DENSE, evenly-spaced series: one slot per bucket-interval across the
  // ENTIRE window, with empty intervals as zero bars. The backend only returns
  // non-empty buckets, so packing those together would distort the time axis
  // (e.g. 7 bursts shown as if contiguous). Filling the gaps makes the x-axis a
  // true time scale — "last 60 min" = 60 one-minute slots.
  const bucketMin = s.bucket_minutes || 1;
  const bucketMs = bucketMin * 60000;
  const rawMins = (s.minutes || []).filter(
    (m) => m.requests > 0 || m.input > 0 || m.output > 0,
  );
  if (rawMins.length === 0) {
    tctx.fillStyle = "#7a8294";
    tctx.textAlign = "center";
    tctx.font = "13px ui-monospace, monospace";
    tctx.fillText("No token usage in this window yet", w / 2, h / 2 - 8);
    tctx.fillStyle = "#5a6172";
    tctx.font = "11px ui-monospace, monospace";
    tctx.fillText(
      "use Claude (opencode/qalcode2 running) and it'll appear",
      w / 2,
      h / 2 + 12,
    );
    return;
  }
  // span the full requested window, aligned to bucket boundaries, ending "now"
  const nowMs = Date.now();
  const windowMin = s.window_minutes || rangeMinutes || 60;
  const endSlot = Math.floor(nowMs / bucketMs) * bucketMs;
  const startSlot = endSlot - (Math.ceil(windowMin / bucketMin) - 1) * bucketMs;
  const byMinute = new Map(rawMins.map((m) => [m.minute, m]));
  const mins = [];
  for (let t = startSlot; t <= endSlot; t += bucketMs) {
    mins.push(
      byMinute.get(t) || {
        minute: t,
        input: 0,
        output: 0,
        cache_read: 0,
        requests: 0,
        rate_limited: 0,
        u5h: 0,
        u7d: 0,
      },
    );
  }
  const total = (m) => m.input + m.output;
  const rawMax = Math.max(...mins.map(total), 1);
  // round the y-axis ceiling to a nice number so the range is clear at a glance
  const maxTok = niceMax(rawMax);
  const maxReq = Math.max(...mins.map((m) => m.requests), 1);
  const n = mins.length;
  const bw = plotW / n;
  const xOfMin = (i) => pad.l + i * bw;
  const xMid = (i) => pad.l + i * bw + bw / 2;
  const yOfTok = (v) => pad.t + plotH - (v / maxTok) * plotH;

  // y grid + token axis labels
  tctx.strokeStyle = "#232733";
  tctx.fillStyle = "#7a8294";
  tctx.textAlign = "right";
  tctx.font = "10px ui-monospace, monospace";
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (plotH * i) / 4;
    tctx.beginPath();
    tctx.moveTo(pad.l, y);
    tctx.lineTo(w - pad.r, y);
    tctx.stroke();
    tctx.fillText(fmt(Math.round((maxTok * (4 - i)) / 4)), pad.l - 6, y + 3);
  }
  // peak value label (top-right) so the range it reaches is explicit
  tctx.textAlign = "right";
  tctx.fillStyle = "#9aa3b5";
  tctx.font = "10px ui-monospace, monospace";
  tctx.fillText("peak " + fmt(Math.round(rawMax)) + "/min", w - pad.r, pad.t - 5);
  // y-axis title
  tctx.save();
  tctx.translate(13, pad.t + plotH / 2);
  tctx.rotate(-Math.PI / 2);
  tctx.textAlign = "center";
  tctx.fillStyle = "#9aa3b5";
  tctx.font = "10px ui-monospace, monospace";
  tctx.fillText("tokens / min", 0, 0);
  tctx.restore();

  // x-axis labels — format depends on the bucket/range scale:
  //   per-minute/15m  → HH:MM
  //   hourly          → "Mon HH:00"
  //   daily           → "M/D"
  tctx.textAlign = "center";
  tctx.fillStyle = "#7a8294";
  tctx.font = "10px ui-monospace, monospace";
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const fmtTick = (ms) => {
    const d = new Date(ms);
    if (bucketMin >= 1440) {
      return d.getMonth() + 1 + "/" + d.getDate();
    }
    if (bucketMin >= 60) {
      return (
        DOW[d.getDay()] +
        " " +
        String(d.getHours()).padStart(2, "0") +
        ":00"
      );
    }
    return (
      String(d.getHours()).padStart(2, "0") +
      ":" +
      String(d.getMinutes()).padStart(2, "0")
    );
  };
  const ticks = Math.min(bucketMin >= 1440 ? 8 : 7, n);
  for (let t = 0; t < ticks; t++) {
    const i = Math.round((t * (n - 1)) / Math.max(1, ticks - 1));
    const tx = xMid(i);
    // light vertical gridline so the time scale is readable
    tctx.strokeStyle = "#1c2029";
    tctx.lineWidth = 1;
    tctx.beginPath();
    tctx.moveTo(tx, pad.t);
    tctx.lineTo(tx, pad.t + plotH);
    tctx.stroke();
    tctx.fillStyle = "#8a93a6";
    tctx.fillText(fmtTick(mins[i].minute), tx, pad.t + plotH + 18);
  }
  // axis caption: total span + bucket size, so the scale is unambiguous
  tctx.textAlign = "left";
  tctx.fillStyle = "#5a6172";
  tctx.font = "9px ui-monospace, monospace";
  const spanLabel =
    bucketMin >= 1440
      ? `${Math.round(windowMin / 1440)}d · 1 bar = 1 day`
      : bucketMin >= 60
        ? `${Math.round(windowMin / 60)}h · 1 bar = ${bucketMin / 60}h`
        : `${windowMin}m · 1 bar = ${bucketMin}m`;
  tctx.fillText(spanLabel, pad.l, h - 2);

  // stacked input/output bars
  mins.forEach((m, i) => {
    const x = xOfMin(i);
    const inH = (m.input / maxTok) * plotH;
    const outH = (m.output / maxTok) * plotH;
    tctx.fillStyle = "#5b9bd5";
    tctx.fillRect(x + 1, pad.t + plotH - inH, Math.max(1, bw - 2), inH);
    tctx.fillStyle = "#c08fe0";
    tctx.fillRect(x + 1, pad.t + plotH - inH - outH, Math.max(1, bw - 2), outH);
  });

  // total tokens/min trend: STEPPED (harsh) — each minute is a flat top across
  // its bar width with vertical edges, so empty minutes drop hard to zero
  // instead of sloping. This reads as true per-minute throughput, not a smooth
  // interpolation that hides the gaps.
  const baseY = pad.t + plotH;
  const stepPath = () => {
    tctx.beginPath();
    tctx.moveTo(xOfMin(0), baseY);
    mins.forEach((m, i) => {
      const yT = yOfTok(total(m));
      const xL = xOfMin(i),
        xR = xOfMin(i) + bw;
      tctx.lineTo(xL, yT); // vertical rise/drop at the left edge
      tctx.lineTo(xR, yT); // flat across the minute
    });
    tctx.lineTo(xOfMin(n - 1) + bw, baseY);
  };
  // filled area under the step
  stepPath();
  tctx.closePath();
  const grad = tctx.createLinearGradient(0, pad.t, 0, baseY);
  grad.addColorStop(0, "rgba(217,119,87,0.30)");
  grad.addColorStop(1, "rgba(217,119,87,0.02)");
  tctx.fillStyle = grad;
  tctx.fill();
  // the step line itself
  tctx.strokeStyle = "#d97757";
  tctx.lineWidth = 2;
  tctx.lineJoin = "miter";
  stepPath();
  tctx.stroke();

  // requests line (secondary, normalized to its own max)
  tctx.strokeStyle = "#4caf82";
  tctx.lineWidth = 1.5;
  tctx.setLineDash([3, 3]);
  tctx.beginPath();
  mins.forEach((m, i) => {
    const x = xMid(i);
    const y = pad.t + plotH - (m.requests / maxReq) * plotH;
    i === 0 ? tctx.moveTo(x, y) : tctx.lineTo(x, y);
  });
  tctx.stroke();
  tctx.setLineDash([]);

  // rate-limit (429) markers — vertical red bands + dots at the top
  mins.forEach((m, i) => {
    if (m.rate_limited > 0) {
      const x = xOfMin(i);
      tctx.fillStyle = "rgba(224,86,74,0.18)";
      tctx.fillRect(x, pad.t, Math.max(2, bw), plotH);
      tctx.fillStyle = "#e0564a";
      tctx.fillRect(x, pad.t, Math.max(2, bw), 4);
      tctx.beginPath();
      tctx.arc(x + bw / 2, pad.t + 9, 3.5, 0, Math.PI * 2);
      tctx.fill();
    }
  });

  // peak marker
  if (s.peak_minute) {
    const idx = mins.findIndex((m) => m.minute === s.peak_minute);
    if (idx >= 0) {
      const x = xMid(idx);
      tctx.strokeStyle = "#f5c451";
      tctx.setLineDash([4, 3]);
      tctx.lineWidth = 1;
      tctx.beginPath();
      tctx.moveTo(x, pad.t);
      tctx.lineTo(x, pad.t + plotH);
      tctx.stroke();
      tctx.setLineDash([]);
    }
  }
}

// ── 5h / 7d rolling windows ─────────────────────────────────────────────────
// `resetEpochSec` is the epoch-seconds at which the window resets (0 = unknown).
function setWindow(prefix, frac, resetEpochSec) {
  const pctEl = document.getElementById(prefix + "-pct");
  const fillEl = document.getElementById(prefix + "-fill");
  const noteEl = document.getElementById(prefix + "-note");
  if (!frac && !resetEpochSec) {
    // no data captured yet for this window
    pctEl.textContent = "–";
    pctEl.style.color = "var(--muted)";
    fillEl.style.width = "0%";
    if (noteEl) noteEl.textContent = "waiting for a request through the collector";
    return;
  }
  if (frac == null || Number.isNaN(frac)) {
    pctEl.textContent = "–";
    fillEl.style.width = "0%";
  } else {
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    pctEl.textContent = pct + "% used";
    fillEl.style.width = pct + "%";
    // Solid colour by how full the bar actually is — only red when near the
    // limit, not a fixed green→red gradient on every bar.
    const col =
      pct >= 85
        ? "var(--rl)"
        : pct >= 60
          ? "var(--peak)"
          : "var(--req)";
    fillEl.style.background = col;
    pctEl.style.color =
      pct >= 85 ? "var(--rl)" : pct >= 60 ? "var(--peak)" : "var(--text)";
  }
  if (noteEl) noteEl.textContent = "resets in " + fmtReset(resetEpochSec);
}

// ── usage-limit history mini-chart (5h + 7d utilization over time) ────────────
const limhist = document.getElementById("limhist");
const lhctx = limhist ? limhist.getContext("2d") : null;
function drawLimHist(s) {
  if (!lhctx) return;
  // fit to CSS width × dpr
  const dpr = window.devicePixelRatio || 1;
  const cssW = limhist.parentElement.clientWidth;
  const cssH = 58;
  if (limhist.width !== Math.round(cssW * dpr)) {
    limhist.width = Math.round(cssW * dpr);
    limhist.height = Math.round(cssH * dpr);
  }
  lhctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = cssW,
    h = cssH;
  lhctx.clearRect(0, 0, w, h);
  const pad = { l: 30, r: 6, t: 5, b: 12 };
  const plotW = w - pad.l - pad.r,
    plotH = h - pad.t - pad.b;

  // use buckets that carry a utilization sample
  const pts = (s.minutes || []).filter((m) => (m.u5h || 0) > 0 || (m.u7d || 0) > 0);
  if (pts.length < 2) {
    lhctx.fillStyle = "#5a6172";
    lhctx.font = "10px ui-monospace, monospace";
    lhctx.textAlign = "center";
    lhctx.fillText("building history…", w / 2, h / 2);
    return;
  }
  // span the FULL requested window (same time scale as the token graph) so the
  // axis is meaningful, not just the span of the few samples.
  const nowMs = Date.now();
  const winMin = s.window_minutes || rangeMinutes || 60;
  const t0 = nowMs - winMin * 60000;
  const t1 = nowMs;
  const x = (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * plotW;
  const y = (frac) => pad.t + plotH - Math.max(0, Math.min(1, frac)) * plotH;

  // gridlines + % axis labels (0 / 50 / 100)
  lhctx.strokeStyle = "#1c2029";
  lhctx.lineWidth = 1;
  lhctx.fillStyle = "#5a6172";
  lhctx.font = "8px ui-monospace, monospace";
  lhctx.textAlign = "right";
  for (const g of [0, 0.5, 1]) {
    lhctx.beginPath();
    lhctx.moveTo(pad.l, y(g));
    lhctx.lineTo(w - pad.r, y(g));
    lhctx.stroke();
    lhctx.fillText(Math.round(g * 100) + "%", pad.l - 4, y(g) + 3);
  }
  // time labels along the bottom (match the token graph format)
  lhctx.textAlign = "center";
  lhctx.fillStyle = "#5a6172";
  const bMin = s.bucket_minutes || 1;
  const tlabel = (ms) => {
    const d = new Date(ms);
    if (bMin >= 1440) return d.getMonth() + 1 + "/" + d.getDate();
    return (
      String(d.getHours()).padStart(2, "0") +
      ":" +
      String(d.getMinutes()).padStart(2, "0")
    );
  };
  for (let k = 0; k <= 4; k++) {
    const t = t0 + ((t1 - t0) * k) / 4;
    lhctx.fillText(tlabel(t), x(t), h - 2);
  }

  const line = (key, color) => {
    lhctx.strokeStyle = color;
    lhctx.lineWidth = 1.8;
    lhctx.lineJoin = "round";
    lhctx.beginPath();
    let started = false;
    for (const m of pts) {
      const v = m[key] || 0;
      if (v <= 0) continue;
      const px = x(m.minute),
        py = y(v);
      started ? lhctx.lineTo(px, py) : lhctx.moveTo(px, py);
      started = true;
    }
    lhctx.stroke();
  };
  line("u7d", "#5b9bd5"); // 7d
  line("u5h", "#d97757"); // 5h on top
}

// Format a "resets in Xh Ym" string from an epoch-seconds reset timestamp.
function fmtReset(resetEpochSec) {
  if (!resetEpochSec) return "–";
  const secs = Math.round(resetEpochSec - Date.now() / 1000);
  if (secs <= 0) return "now";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h} hr ${m} min`;
  return `${m} min`;
}

// ── calendar ────────────────────────────────────────────────────────────────
function drawCalendar(list) {
  const el = document.getElementById("calendar");
  el.innerHTML = "";
  if (!list || list.length === 0) {
    el.innerHTML =
      '<div style="color:#7a8294;grid-column:1/-1">No daily data yet.</div>';
    return;
  }
  for (const d of list) {
    const div = document.createElement("div");
    div.className = "day" + (d.rate_limited > 0 ? " rl" : "");
    div.innerHTML = `
      <span class="d">${d.day}</span>
      <span class="tot">${fmt(Math.round(d.input + d.output))}</span>
      <span class="sub">${fmt(Math.round(d.input))} in · ${fmt(Math.round(d.output))} out</span>
      <span class="sub">${d.requests} req · peak ${fmt(Math.round(d.peak_tpm))}/min</span>
      ${d.rate_limited > 0 ? `<span class="rlbadge">⛔ ${d.rate_limited} rate-limited</span>` : ""}
    `;
    el.appendChild(div);
  }
}

// ── refresh ─────────────────────────────────────────────────────────────────
// "Tokens/min now" = the most recent minute that actually has tokens, within the
// last ~2 minutes. Turns are bursty (a big completed message then a gap until the
// next finishes), so reading only the current calendar-minute flickers to 0
// between turns. Looking back up to 2 minutes keeps the live number meaningful.
function currentTpm(s) {
  const mins = s.minutes || [];
  if (!mins.length) return 0;
  const nowMin = Math.floor(Date.now() / 60000) * 60000;
  // scan from newest backwards, but only within the last 2 minutes
  for (let i = mins.length - 1; i >= 0; i--) {
    const m = mins[i];
    if (nowMin - m.minute > 2 * 60000) break;
    const tok = (m.input || 0) + (m.output || 0);
    if (tok > 0) return tok;
  }
  return 0;
}

function setReadout(s) {
  const last = (s.minutes || []).at(-1);
  const tpm = currentTpm(s);
  const totalTok = (s.minutes || []).reduce(
    (a, m) => a + m.input + m.output,
    0,
  );
  const totalReq = (s.minutes || []).reduce((a, m) => a + m.requests, 0);
  document.getElementById("r-tpm").textContent = fmt(Math.round(tpm));
  document.getElementById("r-rpm").textContent = last ? last.requests : 0;
  document.getElementById("r-peak").textContent = fmt(
    Math.round(s.peak_tokens || 0),
  );
  document.getElementById("r-429").textContent = s.rate_limited_total || 0;
  document.getElementById("r-total").textContent = fmt(Math.round(totalTok));
  document.getElementById("r-reqtot").textContent = fmt(totalReq);

  // data transfer + efficiency (window totals)
  const mins = s.minutes || [];
  const totalInput = mins.reduce((a, m) => a + (m.input || 0), 0);
  const totalOutput = mins.reduce((a, m) => a + (m.output || 0), 0);
  const totalCacheRead = mins.reduce((a, m) => a + (m.cache_read || 0), 0);
  const bIn = s.total_bytes_in ?? mins.reduce((a, m) => a + (m.bytes_in || 0), 0);
  const bOut =
    s.total_bytes_out ?? mins.reduce((a, m) => a + (m.bytes_out || 0), 0);
  const cost = s.total_cost ?? mins.reduce((a, m) => a + (m.cost || 0), 0);
  const setTxt = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  setTxt("r-input", totalInput > 0 ? fmt(totalInput) : "–");
  setTxt("r-output", totalOutput > 0 ? fmt(totalOutput) : "–");
  setTxt("r-cacheread", totalCacheRead > 0 ? fmt(totalCacheRead) : "–");

  // 4th tile adapts to the available data:
  //  - proxy source (has wire bytes) → show ↑/↓ bytes transferred
  //  - cost known (>0) → show est. cost
  //  - otherwise → cache hit rate (always meaningful)
  if (bIn > 0 || bOut > 0) {
    setTxt("x4-label", "Data transfer");
    setTxt("r-x4", `${fmtBytes(bIn)} ↑ / ${fmtBytes(bOut)} ↓`);
    setTxt("x4-sub", "request / response bytes");
  } else if (cost > 0) {
    setTxt("x4-label", "Est. cost");
    setTxt("r-x4", "$" + cost.toFixed(2));
    setTxt("x4-sub", "this window");
  } else {
    const cacheBase = totalCacheRead + totalInput;
    setTxt("x4-label", "Cache hit rate");
    setTxt(
      "r-x4",
      cacheBase > 0
        ? Math.round((totalCacheRead / cacheBase) * 100) + "%"
        : "–",
    );
    setTxt("x4-sub", "cache-read ÷ total input");
  }

  setWindow("w5h", s.latest_u5h || 0, s.reset5h || 0);
  setWindow("w7d", s.latest_u7d || 0, s.reset7d || 0);

  const planEl = document.getElementById("plan-label");
  if (planEl) {
    // Identify which account/server is the active source. Two Max accounts look
    // identical in the headers, so we key on the source port and let you name it.
    let acct = "";
    const m = (s.source || "").match(/:(\d+)/);
    if (m) {
      const port = m[1];
      const names = JSON.parse(localStorage.getItem("pulse.accts") || "{}");
      acct = " · " + (names[port] || "acct :" + port);
    }
    planEl.textContent = (s.plan ? "· " + s.plan : "") + acct;
    if (m) planEl.dataset.port = m[1];
  }

  const src = document.getElementById("datasrc");
  if (src)
    src.textContent = s.has_data
      ? `log: ${s.log_path}`
      : "No data yet — start the collector proxy and route a tool through it.";
}

function renderAll() {
  if (!snap) return;
  const last = (snap.minutes || []).at(-1);
  const tpm = currentTpm(snap);
  const rl = last ? last.rate_limited > 0 : false;
  drawGauge(tpm, snap.peak_tokens || 0, rl);
  drawTimeline(snap);
  drawCalendar(days);
}

async function tick() {
  try {
    triggerImport(); // fire-and-forget: keep the log fresh while the UI is open
    const s = await getSnapshot(rangeMinutes);
    if (s) {
      // The snapshot's latest_u5h/u7d come from the log (the backend importer
      // stores ratelimit samples there). If the live /ratelimit poll has FRESHER
      // values, prefer those so the windows track in real time. Either way, never
      // let a present value get overwritten by a zero.
      if (liveRl) {
        if (liveRl.u5h != null && liveRl.u5h > 0) s.latest_u5h = liveRl.u5h;
        if (liveRl.u7d != null && liveRl.u7d > 0) s.latest_u7d = liveRl.u7d;
        if (liveRl.reset5h) s.reset5h = liveRl.reset5h;
        if (liveRl.reset7d) s.reset7d = liveRl.reset7d;
        if (liveRl.plan && !s.plan) s.plan = liveRl.plan;
        if (liveRl.source) s.source = liveRl.source; // which server/account
      }
      // carry forward the last good limits so they never blink to empty
      if (s.latest_u5h > 0) lastGoodU5h = s.latest_u5h;
      if (s.latest_u7d > 0) lastGoodU7d = s.latest_u7d;
      if (s.reset5h) lastGoodReset5h = s.reset5h;
      if (s.reset7d) lastGoodReset7d = s.reset7d;
      if (s.plan) lastGoodPlan = s.plan;
      if (!(s.latest_u5h > 0) && lastGoodU5h > 0) {
        s.latest_u5h = lastGoodU5h;
        s.reset5h = lastGoodReset5h;
      }
      if (!(s.latest_u7d > 0) && lastGoodU7d > 0) {
        s.latest_u7d = lastGoodU7d;
        s.reset7d = lastGoodReset7d;
      }
      if (!s.plan && lastGoodPlan) s.plan = lastGoodPlan;
      snap = s;
    }
  } catch (e) {
    console.error("[pulse] tick snapshot failed", e);
  }
  if (!snap) return;
  setReadout(snap);
  drawTimeline(snap);
  drawLimHist(snap);
  const last = (snap.minutes || []).at(-1);
  drawGauge(
    currentTpm(snap),
    snap.peak_tokens || 0,
    last ? last.rate_limited > 0 : false,
  );
}

// Poll the live rate-limit source on its own cadence so a slow/absent qalcode2
// can never stall the main snapshot/render loop.
let liveRl = null;
// Last known-good limit values, so the windows never blink to empty between polls.
let lastGoodU5h = 0,
  lastGoodU7d = 0,
  lastGoodReset5h = 0,
  lastGoodReset7d = 0,
  lastGoodPlan = "";
async function pollRatelimit() {
  try {
    const live = await getLiveRatelimit();
    if (live) liveRl = live;
  } catch (e) {
    console.error("[pulse] ratelimit poll failed", e);
  }
}

async function refreshDays() {
  try {
    const d = await getDays(35);
    if (d) {
      days = d;
      drawCalendar(days);
    }
  } catch (e) {
    console.error("[pulse] days refresh failed", e);
  }
}

// ── responsive canvas sizing ─────────────────────────────────────────────────
// Size each canvas to its container's CSS box × devicePixelRatio so it stays
// crisp and fills the available space when the window is resized/enlarged.
function fitCanvas(canvas, cssHeight, maxWidth) {
  const dpr = window.devicePixelRatio || 1;
  const parent = canvas.parentElement;
  let cssW = parent.clientWidth - 2; // minus border
  if (maxWidth) cssW = Math.min(cssW, maxWidth);
  const cssH = cssHeight;
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  const needW = Math.round(cssW * dpr);
  const needH = Math.round(cssH * dpr);
  if (canvas.width !== needW || canvas.height !== needH) {
    canvas.width = needW;
    canvas.height = needH;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Drawing code uses canvas.width/height; expose CSS px via these:
  canvas._cssW = cssW;
  canvas._cssH = cssH;
}

function layout() {
  // gauge: compact, capped so it doesn't dominate the viewport
  const gaugeCardW = gauge.parentElement.clientWidth - 12;
  const gaugeH = Math.min(195, Math.max(160, gaugeCardW * 0.52));
  fitCanvas(gauge, gaugeH, Math.round(gaugeH * 1.55));
  // timeline: fill width, height scales with window (compact)
  const tlH = Math.min(320, Math.max(180, window.innerHeight * 0.28));
  fitCanvas(timeline, tlH);
  if (snap) {
    const last = (snap.minutes || []).at(-1);
    drawGauge(
      currentTpm(snap),
      snap.peak_tokens || 0,
      last ? last.rate_limited > 0 : false,
    );
    drawTimeline(snap);
  }
}
window.addEventListener("resize", layout);
// initial + after first paint
requestAnimationFrame(layout);

// ── UI zoom (Ctrl + scroll, Ctrl +/-/0) ──────────────────────────────────────
// Scales the whole interface like browser zoom. The Tauri webview doesn't wire
// this up by default, so we do it via CSS zoom and re-fit the canvases after so
// they re-render crisp (not janky/blurry). Persisted across launches.
let uiZoom = parseFloat(localStorage.getItem("pulse.zoom") || "1") || 1;
function applyZoom(z) {
  uiZoom = Math.max(0.5, Math.min(2.5, Math.round(z * 100) / 100));
  // `zoom` reflows layout (better than transform:scale for our flex/canvas UI)
  document.body.style.zoom = String(uiZoom);
  localStorage.setItem("pulse.zoom", String(uiZoom));
  // re-fit canvases at the new effective size so they stay sharp
  requestAnimationFrame(layout);
}
if (uiZoom !== 1) applyZoom(uiZoom);

window.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return; // only Ctrl+wheel zooms the UI
    e.preventDefault();
    applyZoom(uiZoom + (e.deltaY < 0 ? 0.1 : -0.1));
  },
  { passive: false },
);
window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === "=" || e.key === "+") {
    e.preventDefault();
    applyZoom(uiZoom + 0.1);
  } else if (e.key === "-") {
    e.preventDefault();
    applyZoom(uiZoom - 0.1);
  } else if (e.key === "0") {
    e.preventDefault();
    applyZoom(1);
  }
});

// gauge animates smoothly; data refetched every 2s; days every 30s;
// rate-limit polled every 5s on its own loop (never blocks the render)
pollRatelimit();
setInterval(pollRatelimit, 5000);
setInterval(tick, 2000);
setInterval(() => {
  if (snap) {
    const last = (snap.minutes || []).at(-1);
    drawGauge(
      currentTpm(snap),
      snap.peak_tokens || 0,
      last ? last.rate_limited > 0 : false,
    );
  }
}, 33);
setInterval(refreshDays, 30000);

// ── range selector ───────────────────────────────────────────────────────────
const rangeSelect = document.getElementById("rangeSelect");
const rangeLabel = {
  60: "last 60 min",
  180: "last 3 h",
  360: "last 6 h",
  720: "last 12 h",
  1440: "last 24 h",
  4320: "last 3 days",
  10080: "last 7 days",
  43200: "last 30 days",
  129600: "last 90 days",
};
// ordered list of zoom levels (minutes) — matches the dropdown
const ZOOM_LEVELS = [60, 180, 360, 720, 1440, 4320, 10080, 43200, 129600];
async function applyRange(minutes) {
  rangeMinutes = minutes;
  rangeSelect.value = String(minutes);
  await tick();
}
rangeSelect.addEventListener("change", () => applyRange(Number(rangeSelect.value)));

// Graph time-range is chosen via the dropdown (no scroll-wheel hijacking —
// the wheel scrolls the page; Ctrl+wheel zooms the UI).

// Deep-link the range via URL hash (e.g. #range=10080) — shareable + lets the
// headless renderer/preview open a specific scale.
function rangeFromHash() {
  const m = location.hash.match(/range=(\d+)/);
  if (m) {
    const v = Number(m[1]);
    if (v > 0) applyRange(v);
  }
}
window.addEventListener("hashchange", rangeFromHash);
rangeFromHash();

// ── tab switching (Dashboard / How it works) ─────────────────────────────────
function selectTab(name) {
  document
    .querySelectorAll("#tabs button")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document
    .querySelectorAll("main.view")
    .forEach((m) => m.classList.toggle("active", m.dataset.view === name));
  if (name === "dashboard") requestAnimationFrame(layout);
  if (location.hash.replace("#", "") !== name)
    history.replaceState(null, "", "#" + name);
}
document.querySelectorAll("#tabs button").forEach((b) => {
  b.addEventListener("click", () => selectTab(b.dataset.view));
});
{
  const h = location.hash.replace("#", "");
  if (h === "about" || h === "dashboard") selectTab(h);
}

// ── version display ───────────────────────────────────────────────────────────
async function showVersion() {
  let v = null;
  try {
    if (invoke) v = await invoke("app_version");
    else if (await probeWebApi()) {
      const r = await fetch("/api/version", { cache: "no-store" });
      if (r.ok) v = (await r.json()).version;
    }
  } catch {}
  const el = document.getElementById("version");
  if (el) el.textContent = v ? "v" + v : "";
}
showVersion();

// ── widget mode (compact, gauge only) ────────────────────────────────────────
let widgetMode = false;
// Click the plan/account label to name the active account (handy with multiple
// Claude Max accounts — stored locally, keyed by the server port).
{
  const planEl = document.getElementById("plan-label");
  if (planEl) {
    planEl.style.cursor = "pointer";
    planEl.title = "click to name this account";
    planEl.addEventListener("click", () => {
      const port = planEl.dataset.port;
      if (!port) return;
      const names = JSON.parse(localStorage.getItem("pulse.accts") || "{}");
      const cur = names[port] || "";
      const name = prompt(`Name for account on port ${port}:`, cur);
      if (name !== null) {
        names[port] = name.trim();
        localStorage.setItem("pulse.accts", JSON.stringify(names));
        if (snap) setReadout(snap);
      }
    });
  }
}

document.getElementById("widgetBtn").addEventListener("click", async () => {
  widgetMode = !widgetMode;
  document.body.classList.toggle("widget", widgetMode);
  if (tauriWindow) {
    const win = tauriWindow.getCurrentWindow
      ? tauriWindow.getCurrentWindow()
      : null;
    if (win) {
      await win.setAlwaysOnTop(widgetMode);
      await win.setSize(
        new tauriWindow.LogicalSize(
          widgetMode ? 320 : 980,
          widgetMode ? 260 : 760,
        ),
      );
    }
  }
});

// ── helpers ──────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function fmtBytes(n) {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + " GB";
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + " MB";
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(1) + " KB";
  return n + " B";
}

// ── demo data (browser dev only, no backend) ─────────────────────────────────
function demoSnapshot(windowMinutes) {
  const now = Date.now();
  const minutes = [];
  let peak = 0,
    peakMin = 0,
    rl = 0;
  for (let i = windowMinutes; i >= 0; i--) {
    const minute = (Math.floor(now / 60000) - i) * 60000;
    const active = Math.random() < 0.7;
    const base = active
      ? Math.max(0, Math.sin(i / 9) * 3500 + 3000 + (Math.random() * 2500 - 1000))
      : 0;
    const input = Math.round(base * 0.6),
      output = Math.round(base * 0.4);
    const requests = base > 0 ? Math.max(1, Math.round(base / 2500)) : 0;
    const rate_limited = base > 9000 && Math.random() > 0.7 ? 1 : 0;
    rl += rate_limited;
    if (input + output > peak) {
      peak = input + output;
      peakMin = minute;
    }
    minutes.push({
      minute,
      input,
      output,
      cache_read: 0,
      cache_write: 0,
      requests,
      rate_limited,
      u5h: Math.min(0.85, i / windowMinutes + 0.1),
      u7d: 0.3,
    });
  }
  return {
    minutes,
    peak_tokens: peak,
    peak_minute: peakMin,
    peak_requests: 6,
    peak_requests_minute: peakMin,
    rate_limited_total: rl,
    latest_u5h: 0.2,
    latest_u7d: 0.9,
    reset5h: Math.floor(now / 1000) + (4 * 3600 + 35 * 60), // ~4h35m
    reset7d: Math.floor(now / 1000) + (8 * 3600 + 35 * 60), // ~8h35m
    log_path: "(demo data — no backend detected)",
    has_data: true,
  };
}
function demoDays(days) {
  const out = [];
  const today = Math.floor(Date.now() / 86400000);
  for (let i = days; i >= 0; i--) {
    const dt = new Date((today - i) * 86400000);
    const day = dt.toISOString().slice(0, 10);
    const off = Math.random() < 0.25;
    const input = off ? 0 : Math.round(Math.random() * 400000),
      output = off ? 0 : Math.round(Math.random() * 180000);
    out.push({
      day,
      input,
      output,
      cache_read: 0,
      cache_write: 0,
      requests: off ? 0 : Math.round(Math.random() * 250),
      rate_limited: !off && Math.random() > 0.8 ? Math.round(Math.random() * 4) : 0,
      peak_tpm: off ? 0 : Math.round(Math.random() * 14000),
    });
  }
  return out;
}

tick();
refreshDays();
