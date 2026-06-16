# AGENTS.md — continuation guide for Claude Pulse

Read this first if you're an AI agent or contributor picking up this project.

## What this is

An open-source, local-first Claude API usage monitor with an accelerometer-style
gauge. Two parts: a **Bun proxy collector** and a **Tauri desktop app**. See README.

## Current status (2026-06-16)

- ✅ `collector/proxy.ts` — DONE and **tested end-to-end** (forwards to Anthropic,
  logs token usage + rate-limit headers + 429s to `usage.jsonl`, never logs bodies).
  Verified: client gets exact upstream body back; log line contains tokens + 5h/7d
  utilization. Streaming (SSE) usage extraction implemented via `response.body.tee()`.
- ✅ `app/src/` frontend — DONE: gauge, timeline, calendar, widget mode, demo-data
  fallback for browser dev. Vanilla JS + canvas, no framework.
- ✅ `app/src-tauri/` Rust backend — DONE: reads JSONL, aggregates per-minute +
  per-day, exposes `snapshot(window_minutes)` and `day_summaries(days)` commands.
- ⬜ **NOT yet built/verified:** `tauri build` on this machine (needs icons +
  `cargo`/webkit2gtk-4.1, both present). Generate placeholder icons first.
- ⬜ Local web mode in the collector (serve the dashboard at :8788 reading the log).
- ⬜ Snapshot export (anonymized stats JSON/PNG) + Cloudflare Pages renderer.
- ⬜ `docs/RATE_LIMITS.md`, `docs/METHOD.md` — copy from
  `~/projects/github_repos/qalcode2/docs/ANTHROPIC_RATELIMIT_HEADERS.md` and
  `~/projects/qalarc.com/projects/claude-ratelimit-monitor/METHOD.md`.

## Next steps (in order)

1. **Generate Tauri icons** (`app/src-tauri/icons/`): `cargo tauri icon <png>` or
   drop 32x32/128x128/icon.png placeholders. Then `cd app && bun install && bun run build`.
   Fix any Rust compile errors (the lib.rs is written but unbuilt — verify it compiles).
2. **Copy the docs** listed above into `docs/`.
3. **Local web mode:** add a `--web` flag to `collector/proxy.ts` that also serves
   `app/src/` statically + a `/api/snapshot` + `/api/days` JSON endpoint mirroring the
   Rust commands (so the same `app.js` works against either Tauri OR fetch). This is
   the safe "view on my phone / second screen" path — see `docs/WEB_SHARING.md`.
4. **Snapshot export** for sharing (see WEB_SHARING.md). NEVER add credential upload.
5. Polish gauge visuals; add model breakdown; add configurable gauge max.

## Hard rules (do not violate)

- **NEVER log prompt/completion bodies or auth tokens.** Metadata only. This is the
  project's core promise.
- **NEVER build a feature that sends a user's API key/OAuth token to a remote server.**
  The "share stats online" feature must work by uploading an anonymized SNAPSHOT the
  user explicitly exports — not credentials. See `docs/WEB_SHARING.md`.
- **NEVER brute-force / probe rate limits.** Discovery is by passive observation of
  the user's own traffic only.
- Keep the collector **zero-dependency** (pure Bun) and the frontend **framework-free**
  (vanilla JS + canvas) — low barrier for contributors.

## Architecture notes

- Data file: `~/.local/share/claude-pulse/usage.jsonl` (XDG data dir). One JSON object
  per line. Schema in `collector/proxy.ts` (`LogLine`) and `app/src-tauri/src/lib.rs`
  (`RawLine`). **If you change the schema, update BOTH and keep it backward-compatible**
  (all fields optional on read). Reset timestamps (`reset5h`/`reset7d`, epoch seconds)
  flow through `Snapshot` for the "resets in" countdowns.
- **Live rate-limit source:** when a qalcode2/opencode server is running it serves the
  real Anthropic unified snapshot at `GET <server>/ratelimit` (`unified5hUtilization`,
  `unified5hReset`, `unified7dUtilization`, `unified7dReset` epoch seconds, `planLabel`).
  Both the Rust `ratelimit` command (`lib.rs`, dependency-free TCP GET + `ss` port
  discovery) and the collector web mode (`/api/ratelimit`) read it and overlay it onto
  the snapshot's 5h/7d values. Override the URL with `CLAUDE_PULSE_RATELIMIT_URL`.
- **Graph time scales:** `snapshot(window_minutes, bucket_minutes)` auto-buckets
  (per-minute ≤6h, 15m ≤3d, hourly ≤14d, daily beyond). Frontend ranges go to 90 days.
- The frontend is auth-aware-agnostic: it just renders whatever aggregates the backend
  returns. OAuth users get `u5h`/`u7d` populated; API-key users get `tokensRemaining`.
- Tauri command names use snake_case in Rust but are invoked camelCase-arg from JS
  (`invoke("snapshot", { windowMinutes })`).

## Testing

- Collector: see the README quick-start, or the fake-upstream test pattern used during
  development (spin a local Bun server returning a `usage` object + `anthropic-ratelimit-*`
  headers, point `CLAUDE_PULSE_UPSTREAM` at it).
- Frontend: `bun run preview` in `app/` → opens with demo data, no Tauri needed.

## Provenance / related

- Born from qalcode2's in-TUI usage panel + the rate-limit header reverse-engineering.
- Reference docs: `~/projects/github_repos/qalcode2/docs/ANTHROPIC_RATELIMIT_HEADERS.md`.
- Ties into the `~/projects/anthropic_pursuit/` portfolio (this is a spearhead artifact).
