/**
 * opencode / qalcode2 LIVE token source.
 *
 * The accurate, current per-message token data is held by a running
 * opencode/qalcode2 server and exposed over its HTTP API — NOT in the on-disk
 * SQLite DB (which can be stale, e.g. when the claude-code subprocess provider
 * is active). This adapter polls the live server so Claude Pulse shows REAL,
 * up-to-the-minute tokens/min with no proxy and no credentials.
 *
 * Data flow:
 *   GET <server>/session                       → list sessions (newest first)
 *   GET <server>/session/:id/message           → messages incl. assistant
 *                                                 tokens {input,output,cache:{read,write}}
 *   → emit each NEW assistant message as a kind:"request" line in usage.jsonl
 *
 * We auto-discover the server (the same one serving /ratelimit) or honor
 * CLAUDE_PULSE_OPENCODE_URL. Read-only. Zero deps (pure Bun fetch).
 */

import { appendFile } from "fs/promises";
import { spawnSync } from "child_process";

const EXPLICIT = process.env["CLAUDE_PULSE_OPENCODE_URL"]; // e.g. http://localhost:43577

let baseUrl: string | null = EXPLICIT ?? null;
// message-id → cumulative total we've already recorded, so we only emit deltas
// once a message stops growing (or emit the final value once).
const seen = new Map<string, number>();
let initialized = false;

function localPorts(): number[] {
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

async function jget(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// An opencode server answers GET /session with an array of sessions.
async function isOpencode(base: string): Promise<boolean> {
  const j = await jget(base + "/session");
  return Array.isArray(j);
}

// Freshness of a server's /ratelimit snapshot (epoch ms), or 0 if none.
async function serverFreshness(base: string): Promise<number> {
  const j = await jget(base + "/ratelimit");
  return j && typeof j.at === "number" ? j.at : 0;
}

// Pick the FRESHEST opencode server. Multiple servers (old + current sessions)
// may run; we must use the one matching the user's CURRENT session, identified
// by the newest /ratelimit snapshot — otherwise we'd show another account's data.
async function discover(): Promise<string | null> {
  if (EXPLICIT) return (await isOpencode(EXPLICIT)) ? EXPLICIT : null;
  const candidates = localPorts().map((p) => `http://127.0.0.1:${p}`);
  const checked = await Promise.all(
    candidates.map(async (url) => {
      if (!(await isOpencode(url))) return null;
      return { url, at: await serverFreshness(url) };
    }),
  );
  let best: { url: string; at: number } | null = null;
  for (const c of checked) {
    if (!c) continue;
    if (!best || c.at > best.at) best = c;
  }
  baseUrl = best ? best.url : null;
  return baseUrl;
}

function tokensOf(m: any): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
} | null {
  const tk = m?.tokens;
  if (!tk) return null;
  const input = Number(tk.input ?? 0);
  const output = Number(tk.output ?? 0);
  const cacheRead = Number(tk.cache?.read ?? 0);
  const cacheWrite = Number(tk.cache?.write ?? 0);
  const total = input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, total };
}

function msgTime(m: any): number {
  const t = m?.time ?? {};
  return Number(t.completed ?? t.created ?? m?.time_created ?? Date.now());
}

/**
 * Poll the live server once and append any NEW assistant-message token lines.
 * On first run, looks back over recent sessions so the graph isn't empty.
 */
export async function importOpencodeLive(
  logFile: string,
  opts: { sessions?: number } = {},
): Promise<number> {
  const base = await discover();
  if (!base) return 0;

  const sessions = await jget(base + "/session");
  if (!Array.isArray(sessions)) return 0;

  // newest sessions first; on first run scan a few, after that just the active ones
  const sorted = [...sessions].sort(
    (a, b) =>
      (b?.time?.updated ?? b?.time?.created ?? 0) -
      (a?.time?.updated ?? a?.time?.created ?? 0),
  );
  const scanN = initialized ? 2 : (opts.sessions ?? 6);
  const toScan = sorted.slice(0, scanN);

  const lines: string[] = [];
  for (const s of toScan) {
    const sid = s?.id;
    if (!sid) continue;
    const msgs = await jget(`${base}/session/${sid}/message`);
    if (!Array.isArray(msgs)) continue;
    for (const item of msgs) {
      const m = item?.info ?? item;
      if (m?.role !== "assistant") continue;
      const id = m?.id;
      if (!id) continue;
      const tk = tokensOf(m);
      if (!tk || tk.total === 0) continue;
      // Record each message exactly ONCE, using its final token counts. A
      // message's tokens are only trustworthy once it's completed; emitting on
      // completion (one line per msgId) avoids any double-counting from streaming.
      if (seen.has(id)) continue;
      const completed = !!m?.time?.completed;
      if (!completed) continue; // not done streaming yet — wait
      seen.set(id, tk.total);
      lines.push(
        JSON.stringify({
          t: msgTime(m),
          kind: "request",
          status: 200,
          input: tk.input,
          output: tk.output,
          cacheRead: tk.cacheRead,
          cacheWrite: tk.cacheWrite,
          model: m?.modelID ?? m?.model ?? undefined,
          rateLimited: false,
          durationMs: 0,
          source: "opencode-live",
          msgId: id,
        }),
      );
    }
  }
  initialized = true;
  if (lines.length === 0) return 0;
  await appendFile(logFile, lines.join("\n") + "\n");
  return lines.length;
}

export function opencodeLiveBase(): string | null {
  return baseUrl;
}

// Standalone test: `bun run collector/opencode-live.ts`
if (import.meta.main) {
  const { homedir } = await import("os");
  const path = (await import("path")).default;
  const { mkdir } = await import("fs/promises");
  const DATA = path.join(
    process.env["XDG_DATA_HOME"] ?? path.join(homedir(), ".local", "share"),
    "claude-pulse",
  );
  await mkdir(DATA, { recursive: true });
  const LOG = path.join(DATA, "usage.jsonl");
  const n = await importOpencodeLive(LOG);
  console.log(
    `[claude-pulse] live import: ${n} new token messages from ${opencodeLiveBase() ?? "(no server found)"}`,
  );
}
