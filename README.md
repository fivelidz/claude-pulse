# Claude Pulse

**An open-source, local-first usage monitor for the Anthropic Claude API — with an accelerometer-style live gauge.**

Claude Pulse shows you, on a **single dashboard**, in real time and over history:

- **A live "accelerometer" gauge** — your tokens-per-minute as a sweeping needle with green → amber → red zones and a peak marker.
- **Rolling rate-limit windows** — your **5-hour "current session"** and **7-day "weekly (all models)"** window utilization as live bars with **"resets in Xh Ym" countdowns** (the limits that actually govern OAuth/subscription usage). When a qalcode2/opencode server is running, Pulse reads its live `/ratelimit` snapshot so the numbers + reset times are the **real** values from your account.
- **A token-usage-over-time graph** — input/output tokens and requests per bucket, with **peak markers** and **rate-limit (429) markers** so you can _see exactly when you got throttled and at what throughput_. Pick the scale: **60 min → 24 h → 3/7/30/90 days**; buckets auto-switch from per-minute to per-hour to per-day so longer ranges stay readable.
- **A calendar** — daily usage totals, peaks, and rate-limit counts across the last ~5 weeks.
- **A compact always-on-top widget mode** — park the gauge on a second monitor.

Two ways to view it: the **Tauri desktop app**, or a **no-install web dashboard** the collector can serve at `http://localhost:8788` (same UI, viewable from your phone on your LAN).

It works with **any** Claude tool — Claude Code, [qalcode2/opencode], custom scripts — because it captures usage at the network layer, not inside any one app.

> **Why it exists:** Anthropic publishes per-minute rate limits for _API-key_ usage, but **not** for _OAuth/subscription (Pro/Max)_ usage — which instead uses undocumented 5-hour and 7-day rolling windows plus a short-window/per-minute limit that isn't exposed anywhere. Claude Pulse lets you **discover your effective per-minute limit empirically, by observing your own traffic** — never by probing or attacking the API. See [`docs/RATE_LIMITS.md`](docs/RATE_LIMITS.md).

---

## How it works

```
   your Claude tools (Claude Code, qalcode2, scripts…)
        │   ANTHROPIC_BASE_URL=http://localhost:8787
        ▼
┌──────────────────────────┐   appends metadata    ┌─────────────────────────┐
│ collector (Bun proxy)    │ ───────────────────▶  │ usage.jsonl (local file)│
│ forwards to api.anthropic│                        └───────────┬─────────────┘
│ logs tokens+headers+429  │                                    │ reads
│ NEVER logs prompt bodies │                        ┌───────────▼─────────────┐
└──────────────────────────┘                        │ Claude Pulse (Tauri app)│
                                                     │ gauge · timeline · cal  │
                                                     └─────────────────────────┘
```

- **collector/** — a zero-dependency Bun HTTP proxy. Point any tool at it with `ANTHROPIC_BASE_URL`. It transparently forwards every request to `api.anthropic.com`, and logs **metadata only** (token counts from the response `usage` object, rate-limit headers, HTTP status, timing) to `~/.local/share/claude-pulse/usage.jsonl`. **It never writes prompt or completion text, and never writes your auth token.**
- **app/** — a Tauri 2 desktop app (Rust backend + vanilla-JS/canvas frontend). The Rust side reads + aggregates the JSONL log; the frontend renders the gauge, timeline, and calendar.

Everything is **local-first**: no account, no cloud, no telemetry. The collector and app talk only to each other via a file on your disk.

---

## Quick start

### 1. Run the collector

```bash
cd collector
bun install
bun run start          # listens on http://localhost:8787

# …or also serve the dashboard in a browser (no desktop app needed):
bun proxy.ts --web     # proxy on :8787, web dashboard on http://localhost:8788
```

### 2. Point a Claude tool at it

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
# now run Claude Code / qalcode2 / your script as usual
```

### 3. Run the app

```bash
cd app
bun install
bun run dev            # Tauri dev window
# or: bun run build    # produces an AppImage / .deb in src-tauri/target
```

The whole dashboard is on **one page**: the live gauge and key stats up top, the 5-hour / 7-day rolling-window utilization bars, the token-usage-over-time graph (with peak + rate-limit markers), and the daily calendar below. Use the **range** selector to widen the graph to 3 h / 6 h / 12 h / 24 h, or hit **⊟ Widget** to shrink to an always-on-top gauge for a second monitor.

> Prefer the browser? Run the collector with `--web` (above) and open `http://localhost:8788` — same dashboard, no desktop app. Or develop the UI standalone with `bun run preview` in `app/`; with no backend it falls back to a built-in demo data generator.

### Does this "just work" for anybody?

Yes — locally, with no configuration:

- **The graph + per-minute usage + 429 markers** work for **anyone** the moment they
  run the collector and route a Claude tool through it. The data is their own
  `usage.jsonl`; nothing else is needed.
- **The real 5-hour / 7-day windows + "resets in" countdowns + plan label** appear
  **automatically if a qalcode2/opencode server is running** on the same machine —
  Claude Pulse auto-discovers its local `/ratelimit` endpoint (scans local ports).
  No setup; if it's not running, those bars simply stay empty and everything else
  still works. (You can pin the source with `CLAUDE_PULSE_RATELIMIT_URL`.)
- **API-key-only users** don't have OAuth 5h/7d windows at all (those are a
  Pro/Max subscription concept), so the window bars won't populate for them — by
  design. Their token/request counts and graph still work.

> ⚠️ The live `/ratelimit` discovery is **local-only** (it reads a server on your
> own machine). The hosted page at qalarc.com is a **showcase**, not a live tool —
> it can't (and shouldn't) reach anyone's private local server. To actually track
> your usage, run the collector locally as above.

---

## Finding your per-minute rate limit (the whole point)

1. Use Claude normally through the collector.
2. When you hit a limit, the timeline shows a **red 429 marker** at that minute, and you can read the **input/output/requests-per-minute** bars right before it.
3. Over a few natural hits, the throughput level where 429s cluster ≈ **your effective short-window limit**.

This is **observation, not brute-forcing.** We never send synthetic bursts to provoke limits — that risks flagging your account (especially on subscription OAuth). We only record what your real workload already does. See [`docs/RATE_LIMITS.md`](docs/RATE_LIMITS.md) and [`docs/METHOD.md`](docs/METHOD.md).

---

## The "share my stats on a website" idea — read this first

A frequently-requested feature is a hosted web page (e.g. on Cloudflare) where people enter their Claude details and see their stats online. **We deliberately do _not_ do the naive version of this, and here's the honest why:**

- A website that asks for your **Anthropic API key or OAuth token** is a credential-harvesting pattern — even if well-intentioned, users shouldn't paste live API credentials into a third-party web form, and you shouldn't ask them to. It's exactly the anti-pattern security training warns about.
- Sending your token to someone else's server (even Cloudflare Workers) means your credential leaves your machine. That's the thing to avoid.

**What we do instead (safe, and still shareable):**

1. **Local web UI (recommended).** The collector can optionally serve the same dashboard as a local web page (`http://localhost:8788`) reading your local `usage.jsonl`. Same visuals, never leaves your machine, viewable from your phone on your LAN. (See `docs/ROADMAP.md` → "local web mode".)
2. **Share a snapshot, not credentials.** Export an anonymized stats summary (totals, peaks, rate-limit timings — no prompts, no token) as a JSON/PNG you can post anywhere. A static Cloudflare Pages site could _render an uploaded snapshot file_ — no credentials involved.
3. **Optional self-hosted sync.** Advanced users can point the collector at _their own_ endpoint. We never run a central server that holds anyone's credentials.

The rule: **credentials never leave the user's machine.** A Cloudflare page that _renders a snapshot the user chooses to upload_ is fine; a Cloudflare page that _collects API keys_ is not, and we won't build that. See `docs/WEB_SHARING.md` for the full design.

---

## Privacy & safety

- **Metadata only.** The collector logs token counts, rate-limit headers, status codes, timestamps. Never prompts, completions, or auth tokens.
- **Local-first.** No cloud, no account, no telemetry. Data lives in one file on your disk.
- **Transparent proxy.** Requests/responses stream straight through, untouched. The collector just observes headers + the small `usage` object.
- **Read-your-own-account only.** All rate-limit data comes from headers Anthropic returns _to you_. This is observability, not circumvention.

---

## Project layout

```
claude-pulse/
├── README.md            ← you are here
├── AGENTS.md            ← continuation guide for AI agents / contributors
├── LICENSE              ← MIT
├── collector/           ← Bun proxy that logs usage metadata
│   ├── proxy.ts
│   └── package.json
├── app/                 ← Tauri desktop app
│   ├── src/             ← frontend (index.html, app.js, styles.css)
│   └── src-tauri/       ← Rust backend (lib.rs, tauri.conf.json, …)
└── docs/
    ├── RATE_LIMITS.md   ← the documented + undocumented limit reference
    ├── METHOD.md        ← observe-don't-brute-force rationale
    ├── WEB_SHARING.md   ← the safe design for sharing stats online
    └── ROADMAP.md
```

## Status

Functional. Collector tested end-to-end; the Tauri app builds and runs on Linux
(webkit2gtk), and the same UI is available as a no-install web dashboard
(`collector --web`). Contributions welcome — see `AGENTS.md`.

**Repo:** https://github.com/fivelidz/claude-pulse

## License

MIT.
