/**
 * Claude Pulse → gmux status exporter.
 *
 * gmux (the tmux agent orchestrator) shows per-project status items in its tmux
 * status bar / phone PWA by reading sidecar JSON files under a project's
 * `.opencode/` directory. This module writes a `.opencode/claude-pulse.json`
 * sidecar containing the live tokens/min + 5h/7d rate-limit windows, so a
 * "claude-pulse" status item can appear in gmux.
 *
 * Schema (claude-pulse.json):
 *   {
 *     "schema": 1,
 *     "ts": <epoch ms>,
 *     "tpm": <tokens/min, last 60s>,
 *     "rpm": <requests/min, last 60s>,
 *     "u5h": <0..1>, "u7d": <0..1>,
 *     "reset5h": <epoch s>, "reset7d": <epoch s>,
 *     "plan": "Max 20×",
 *     "status": "allowed|allowed_warning|rejected"
 *   }
 *
 * gmux needs a small reader/formatter to surface a distinct "claude-pulse" item
 * (see docs/GMUX_INTEGRATION.md). The sidecar is written regardless so the data
 * is available for any consumer.
 *
 * Zero deps. Reads the same usage.jsonl the rest of Claude Pulse uses.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import path from "path";

const DATA_DIR = path.join(
  process.env["XDG_DATA_HOME"] ?? path.join(homedir(), ".local", "share"),
  "claude-pulse",
);
const LOG_FILE = path.join(DATA_DIR, "usage.jsonl");

// Where to write the sidecar. Default: the gmux/opencode project dir if given,
// else the current working directory's .opencode/.
function sidecarPath(projectDir?: string): string {
  const base = projectDir ?? process.env["CLAUDE_PULSE_PROJECT"] ?? process.cwd();
  return path.join(base, ".opencode", "claude-pulse.json");
}

const MIN_MS = 60_000;

type Raw = {
  t: number;
  kind?: string;
  input?: number;
  output?: number;
  rateLimited?: boolean;
  status?: number;
  u5h?: number;
  u7d?: number;
  reset5h?: number;
  reset7d?: number;
  plan?: string;
  rlStatus?: string;
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
    } catch {}
  }
  return out;
}

export function buildGmuxStatus(lines: Raw[]) {
  const now = Date.now();
  const cutoff = now - MIN_MS; // last 60s
  let tokens = 0,
    requests = 0;
  let latestU5h = 0,
    latestU7d = 0,
    latestReset5h = 0,
    latestReset7d = 0,
    latestPlan: string | undefined,
    latestStatus: string | undefined,
    latestT = 0;

  for (const l of lines) {
    if (l.t > latestT) {
      latestT = l.t;
      if (typeof l.u5h === "number") latestU5h = l.u5h;
      if (typeof l.u7d === "number") latestU7d = l.u7d;
      if (typeof l.reset5h === "number") latestReset5h = l.reset5h;
      if (typeof l.reset7d === "number") latestReset7d = l.reset7d;
      if (l.plan) latestPlan = l.plan;
      if (l.rlStatus) latestStatus = l.rlStatus;
    }
    if (l.kind === "ratelimit") continue;
    if (l.t < cutoff) continue;
    tokens += (l.input ?? 0) + (l.output ?? 0);
    requests += 1;
  }

  return {
    schema: 1,
    ts: now,
    tpm: Math.round(tokens),
    rpm: requests,
    u5h: latestU5h,
    u7d: latestU7d,
    reset5h: latestReset5h,
    reset7d: latestReset7d,
    plan: latestPlan ?? null,
    status: latestStatus ?? null,
  };
}

export async function writeGmuxSidecar(projectDir?: string): Promise<string> {
  const lines = await readLines();
  const status = buildGmuxStatus(lines);
  const out = sidecarPath(projectDir);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(status, null, 2));
  return out;
}

/** Start periodic export. Returns stop(). */
export function startGmuxExport(
  projectDir?: string,
  intervalMs = 5000,
): { stop: () => void } {
  let stopped = false;
  let announced = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const p = await writeGmuxSidecar(projectDir);
      if (!announced) {
        announced = true;
        console.log(`[claude-pulse] gmux sidecar → ${p}`);
      }
    } catch {}
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

// Standalone: `bun run collector/gmux-export.ts [projectDir]`
if (import.meta.main) {
  const dir = process.argv[2];
  const p = await writeGmuxSidecar(dir);
  console.log("[claude-pulse] wrote gmux sidecar:", p);
}
