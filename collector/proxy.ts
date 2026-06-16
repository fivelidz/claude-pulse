#!/usr/bin/env bun
/**
 * claude-pulse collector — a transparent local proxy for the Anthropic API.
 *
 * Point any Claude tool at it:
 *   export ANTHROPIC_BASE_URL=http://localhost:8787
 *   export ANTHROPIC_BEDROCK_BASE_URL=http://localhost:8787   # (if applicable)
 *
 * It forwards every request to https://api.anthropic.com untouched, then logs
 * METADATA ONLY (never prompt/response bodies) to a shared JSONL file that the
 * claude-pulse desktop app reads:
 *   - token usage (from the response JSON `usage` field)
 *   - rate-limit headers (anthropic-ratelimit-*, including the OAuth unified set)
 *   - HTTP status (200 / 429 / etc) and retry-after
 *
 * Privacy: request and response bodies are streamed straight through. We parse
 * only the small `usage` object out of non-streaming responses and only read
 * headers. No prompts, no completions, no auth tokens are ever written to disk.
 *
 * Zero dependencies — pure Bun.
 */

import { appendFile, mkdir } from "fs/promises";
import { homedir } from "os";
import path from "path";
import { startWeb } from "./web.ts";
import { startPoller } from "./poller.ts";
import { startGmuxExport } from "./gmux-export.ts";

const UPSTREAM =
  process.env["CLAUDE_PULSE_UPSTREAM"] ?? "https://api.anthropic.com";
const PORT = Number(process.env["CLAUDE_PULSE_PORT"] ?? 8787);
// Optional local web dashboard (`--web` flag or CLAUDE_PULSE_WEB=1). Lets you
// view usage in a browser with no Tauri app. Default port 8788.
const WEB_ENABLED =
  process.argv.includes("--web") || process.env["CLAUDE_PULSE_WEB"] === "1";
const WEB_PORT = Number(process.env["CLAUDE_PULSE_WEB_PORT"] ?? 8788);
const DATA_DIR = path.join(
  process.env["XDG_DATA_HOME"] ?? path.join(homedir(), ".local", "share"),
  "claude-pulse",
);
const LOG_FILE = path.join(DATA_DIR, "usage.jsonl");

await mkdir(DATA_DIR, { recursive: true });

type LogLine = {
  t: number; // epoch ms
  kind: "request";
  status: number;
  model?: string;
  // token usage (if present in response)
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  // rate-limit headers
  rlStatus?: string; // unified status: allowed | allowed_warning | rejected
  rlClaim?: string; // representative claim
  u5h?: number;
  u7d?: number;
  reset5h?: number;
  reset7d?: number;
  tokensRemaining?: number;
  requestsRemaining?: number;
  retryAfter?: number;
  rateLimited: boolean;
  durationMs: number;
  // wire bytes transferred (request body sent → Anthropic, response body received)
  bytesIn?: number; // request body bytes (you → Anthropic)
  bytesOut?: number; // response body bytes (Anthropic → you)
};

async function logLine(line: LogLine) {
  try {
    await appendFile(LOG_FILE, JSON.stringify(line) + "\n");
  } catch (e) {
    console.error("[claude-pulse] log write failed:", e);
  }
}

function numHeader(h: Headers, k: string): number | undefined {
  const v = h.get(k);
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function extractUsageFromBody(bodyText: string): Partial<LogLine> {
  // Non-streaming responses contain a top-level `usage` object.
  try {
    const j = JSON.parse(bodyText);
    const u = j?.usage;
    if (!u) return {};
    return {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      model: j?.model,
    };
  } catch {
    return {};
  }
}

function extractUsageFromSSE(sseText: string): Partial<LogLine> {
  // Streaming responses: usage arrives in message_start (input) and
  // message_delta (output) SSE events. Scan for the JSON payloads.
  const out: Partial<LogLine> = {};
  try {
    for (const line of sseText.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      const j = JSON.parse(payload);
      if (j.type === "message_start" && j.message?.usage) {
        out.input = j.message.usage.input_tokens ?? out.input ?? 0;
        out.cacheRead =
          j.message.usage.cache_read_input_tokens ?? out.cacheRead ?? 0;
        out.cacheWrite =
          j.message.usage.cache_creation_input_tokens ?? out.cacheWrite ?? 0;
        out.model = j.message.model ?? out.model;
      }
      if (j.type === "message_delta" && j.usage) {
        out.output = j.usage.output_tokens ?? out.output ?? 0;
      }
    }
  } catch {
    // best-effort
  }
  return out;
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const started = Date.now();
    const url = new URL(req.url);
    const target = UPSTREAM + url.pathname + url.search;

    // Count request-body bytes (you → Anthropic) as they stream through, without
    // buffering. A passthrough TransformStream tallies each chunk's byte length.
    let bytesIn = 0;
    let forwardBody: BodyInit | null | undefined = req.body;
    if (req.body) {
      const counter = new TransformStream({
        transform(chunk, controller) {
          bytesIn += chunk?.byteLength ?? 0;
          controller.enqueue(chunk);
        },
      });
      forwardBody = req.body.pipeThrough(counter);
    }

    // Forward request untouched (headers + body stream).
    const upstreamReq = new Request(target, {
      method: req.method,
      headers: req.headers,
      body: forwardBody,
      // @ts-ignore Bun duplex for streaming bodies
      duplex: "half",
    });

    let resp: Response;
    try {
      resp = await fetch(upstreamReq);
    } catch (e) {
      console.error("[claude-pulse] upstream error:", e);
      return new Response(
        JSON.stringify({ error: "claude-pulse upstream fetch failed" }),
        {
          status: 502,
          headers: { "content-type": "application/json" },
        },
      );
    }

    const h = resp.headers;
    const rlStatus = h.get("anthropic-ratelimit-unified-status") ?? undefined;
    const retryAfter = numHeader(h, "retry-after");
    const rateLimited = resp.status === 429 || rlStatus === "rejected";

    const base: Partial<LogLine> = {
      rlStatus,
      rlClaim:
        h.get("anthropic-ratelimit-unified-representative-claim") ?? undefined,
      u5h: numHeader(h, "anthropic-ratelimit-unified-5h-utilization"),
      u7d: numHeader(h, "anthropic-ratelimit-unified-7d-utilization"),
      reset5h: numHeader(h, "anthropic-ratelimit-unified-5h-reset"),
      reset7d: numHeader(h, "anthropic-ratelimit-unified-7d-reset"),
      tokensRemaining: numHeader(h, "anthropic-ratelimit-tokens-remaining"),
      requestsRemaining: numHeader(h, "anthropic-ratelimit-requests-remaining"),
      retryAfter,
      rateLimited,
    };

    // Only the /v1/messages path carries token usage worth logging.
    const isMessages = url.pathname.includes("/messages");
    const contentType = h.get("content-type") ?? "";

    if (isMessages && resp.body) {
      // Tee the body so we can inspect usage WITHOUT blocking the client stream.
      const [clientStream, inspectStream] = resp.body.tee();

      // Inspect asynchronously; log when done. Never delays the client.
      (async () => {
        try {
          const text = await new Response(inspectStream).text();
          const bytesOut = Buffer.byteLength(text, "utf8");
          const usage = contentType.includes("event-stream")
            ? extractUsageFromSSE(text)
            : extractUsageFromBody(text);
          await logLine({
            t: started,
            kind: "request",
            status: resp.status,
            durationMs: Date.now() - started,
            bytesIn,
            bytesOut,
            ...base,
            ...usage,
          } as LogLine);
        } catch {
          await logLine({
            t: started,
            kind: "request",
            status: resp.status,
            durationMs: Date.now() - started,
            bytesIn,
            ...base,
          } as LogLine);
        }
      })();

      return new Response(clientStream, {
        status: resp.status,
        headers: resp.headers,
      });
    }

    // Non-messages request (or no body): log metadata only, pass through.
    await logLine({
      t: started,
      kind: "request",
      status: resp.status,
      durationMs: Date.now() - started,
      bytesIn,
      ...base,
    } as LogLine);

    return resp;
  },
});

if (WEB_ENABLED) {
  startWeb(WEB_PORT);
}

// Self-populate the 5h/7d windows by polling a local qalcode2/opencode
// /ratelimit endpoint (if present) and storing samples — so the dashboard fills
// in even when your Claude traffic doesn't go through this proxy. Disable with
// --no-poll or CLAUDE_PULSE_NO_POLL=1.
const POLL_DISABLED =
  process.argv.includes("--no-poll") ||
  process.env["CLAUDE_PULSE_NO_POLL"] === "1";
if (!POLL_DISABLED) {
  startPoller(LOG_FILE);
}

// Optional gmux integration: write a .opencode/claude-pulse.json sidecar so a
// "claude-pulse" status item can show in gmux. Enable with --gmux [projectDir]
// or CLAUDE_PULSE_GMUX=1 (project dir from CLAUDE_PULSE_PROJECT or cwd).
const GMUX_ENABLED =
  process.argv.includes("--gmux") || process.env["CLAUDE_PULSE_GMUX"] === "1";
if (GMUX_ENABLED) {
  const gi = process.argv.indexOf("--gmux");
  const dir =
    gi >= 0 && process.argv[gi + 1] && !process.argv[gi + 1].startsWith("--")
      ? process.argv[gi + 1]
      : undefined;
  startGmuxExport(dir);
}

const line = "─".repeat(58);
console.log(`
┌${line}┐
  ⚡  Claude Pulse collector is running
${line}
  1. Point any Claude tool at the proxy:

       export ANTHROPIC_BASE_URL=http://localhost:${server.port}

     (then run Claude Code / opencode / your script as usual)
${
  WEB_ENABLED
    ? `
  2. Open the dashboard in any browser — including your phone
     on the same Wi-Fi:

       http://localhost:${WEB_PORT}
`
    : `
  2. See your usage: run the desktop app, or restart with --web
     to view the dashboard in a browser:

       bun proxy.ts --web    →    http://localhost:${WEB_PORT}
`
}
  Privacy: only metadata is logged (tokens, rate-limit headers,
  timing). Never prompts, completions, or your API key.
  Log: ${LOG_FILE}
└${line}┘
`);
