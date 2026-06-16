/**
 * claude-pulse rate-limit poller.
 *
 * Your real Claude traffic often goes through a tool (qalcode2 / opencode /
 * Claude Code) that talks to Anthropic directly — NOT through this collector's
 * proxy — so the proxy log can stay empty even while you're heavily using Claude.
 *
 * This poller fixes that for the rate-limit windows: when a qalcode2 / opencode
 * server is running, it exposes the live Anthropic unified snapshot at
 * GET <server>/ratelimit. We poll it on an interval and APPEND a snapshot line
 * to usage.jsonl, so the 5h / 7d utilization is actually STORED over time and the
 * "usage over time" graph + history populate even without proxied requests.
 *
 * It writes a distinct `kind:"ratelimit"` line (no token counts) so the readers
 * can treat it as a utilization sample, not a request.
 *
 * Zero dependencies — pure Bun. Honors CLAUDE_PULSE_RATELIMIT_URL; otherwise it
 * auto-discovers a local server by scanning listening ports for /ratelimit.
 */

import { appendFile } from "fs/promises";
import { spawnSync } from "child_process";

export type RatelimitSample = {
  t: number; // epoch ms
  kind: "ratelimit";
  u5h?: number;
  u7d?: number;
  reset5h?: number; // epoch seconds
  reset7d?: number; // epoch seconds
  rlStatus?: string;
  plan?: string;
  source?: string;
};

const EXPLICIT_URL = process.env["CLAUDE_PULSE_RATELIMIT_URL"];

function listLocalPorts(): number[] {
  try {
    const out = spawnSync("ss", ["-tlnp"], { encoding: "utf8", timeout: 2000 });
    const ports = new Set<number>();
    for (const line of (out.stdout ?? "").split("\n")) {
      if (!line.includes("127.0.0.1") && !line.includes("0.0.0.0")) continue;
      if (!/bun|node/.test(line)) continue;
      const m = line.match(/:(\d+)\s/);
      if (m) ports.add(Number(m[1]));
    }
    return [...ports];
  } catch {
    return [];
  }
}

function looksLikeRl(j: any): boolean {
  return (
    j &&
    (typeof j.unified5hUtilization === "number" ||
      typeof j.unified7dUtilization === "number")
  );
}

async function fetchRl(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1200) });
    if (!r.ok) return null;
    const j = await r.json();
    return looksLikeRl(j) ? j : null;
  } catch {
    return null;
  }
}

let cachedUrl: string | null = EXPLICIT_URL ?? null;

async function discover(): Promise<string | null> {
  if (EXPLICIT_URL) {
    return (await fetchRl(EXPLICIT_URL)) ? EXPLICIT_URL : null;
  }
  if (cachedUrl && (await fetchRl(cachedUrl))) return cachedUrl;
  cachedUrl = null;
  for (const port of listLocalPorts()) {
    const url = `http://127.0.0.1:${port}/ratelimit`;
    if (await fetchRl(url)) {
      cachedUrl = url;
      return url;
    }
  }
  return null;
}

// Only append when something changed (avoids flooding the log with identical
// samples) OR when ~60s have passed (so the graph has a heartbeat).
let lastSig = "";
let lastWrite = 0;

async function pollOnce(logFile: string): Promise<RatelimitSample | null> {
  const url = await discover();
  if (!url) return null;
  const j = await fetchRl(url);
  if (!j) return null;

  const sample: RatelimitSample = {
    t: Date.now(),
    kind: "ratelimit",
    u5h: j.unified5hUtilization ?? undefined,
    u7d: j.unified7dUtilization ?? undefined,
    reset5h: j.unified5hReset ?? undefined,
    reset7d: j.unified7dReset ?? undefined,
    rlStatus: j.unifiedStatus ?? undefined,
    plan: j.planLabel ?? undefined,
    source: url,
  };

  const sig = `${sample.u5h}|${sample.u7d}|${sample.reset5h}|${sample.reset7d}`;
  const now = Date.now();
  if (sig === lastSig && now - lastWrite < 60_000) {
    return sample; // unchanged & wrote recently — skip disk write
  }
  lastSig = sig;
  lastWrite = now;
  try {
    await appendFile(logFile, JSON.stringify(sample) + "\n");
  } catch {
    /* best effort */
  }
  return sample;
}

/** Start polling. Returns a stop() function. */
export function startPoller(
  logFile: string,
  intervalMs = 15_000,
): { stop: () => void } {
  let stopped = false;
  let announced = false;
  const tick = async () => {
    if (stopped) return;
    const s = await pollOnce(logFile).catch(() => null);
    if (s && !announced) {
      announced = true;
      console.log(
        `[claude-pulse] rate-limit poller active — source: ${s.source}` +
          (s.plan ? ` (${s.plan})` : ""),
      );
    }
  };
  tick();
  const id = setInterval(tick, intervalMs);
  return {
    stop() {
      stopped = true;
      clearInterval(id);
    },
  };
}

// Standalone: `bun run collector/poller.ts`
if (import.meta.main) {
  const { homedir } = await import("os");
  const path = (await import("path")).default;
  const DATA_DIR = path.join(
    process.env["XDG_DATA_HOME"] ?? path.join(homedir(), ".local", "share"),
    "claude-pulse",
  );
  const { mkdir } = await import("fs/promises");
  await mkdir(DATA_DIR, { recursive: true });
  const LOG_FILE = path.join(DATA_DIR, "usage.jsonl");
  console.log(`[claude-pulse] poller writing rate-limit samples to ${LOG_FILE}`);
  startPoller(LOG_FILE);
}
