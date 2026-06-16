# qalcode2 Usage/Limits Sidebar Panel — How It Works

**Written 2026-06-16. If the per-minute token data has stopped working, read
the "What can go wrong" section at the bottom first.**

---

## What the panel shows

The **Usage / Limits** sidebar section (expandable with ▶, above the Voice section)
shows two independent data sources:

### 1. Per-minute usage — computed LOCALLY, no API calls

```
Per minute (last 60s, all sessions)
 • TPM    12.4K /min      ← combined tokens in the last 60s
 • ITPM    9.1K  in/min   ← input tokens (uncached input + cache writes)
 • OTPM    3.3K  out/min  ← output tokens
 • RPM       7   req/min  ← requests
 • Rate    210   tok/s    ← 10s rolling average
```

These numbers come from **watching the in-memory message store** and computing
deltas. No extra Anthropic API calls are made. It works by measuring what's
already happening.

### 2. Anthropic rate-limit headers — from HTTP response headers

```
Anthropic limits
 • 5h window  3% · resets 2h 14m
 • 7d window 12% · resets 5d 3h
   Binding: five hour
```

These come from Anthropic's HTTP response headers on real API responses.
They only appear **after you send a message** (Anthropic only sends them on
actual model responses). See `docs/ANTHROPIC_RATELIMIT_HEADERS.md` for the
full undocumented header reference.

### 3. Observed limit (learned from natural 429s)

```
Observed limit (from 3 hits)
 ≈ 7 req/min before 429
 ≈ 40K in-tok/min before 429
```

When a rate-limit rejection fires during normal use, we record the per-minute
throughput at that moment. The lowest observed value ≈ your effective ceiling.
Persisted to `~/.local/share/opencode/ratelimit-observed.json`.

---

## The full data flow

### Per-minute usage (local computation)

```
Anthropic API response arrives
       │
       ▼
AI SDK fires "message.updated" bus event with new token totals
       │
       ▼
sync.tsx event handler stores the message in the reactive store:
  store.message[sessionID] = [...messages]   (Record<sessionID, Message[]>)
       │
       ▼
sidebar.tsx: recordTokens() runs every 1 second (setInterval tick)
  - iterates Object.values(sync.data.message)
  - for each AssistantMessage (role === "assistant"):
      - reads m.tokens: { input, output, reasoning, cache: { read, write } }
      - ITPM counts: input + cache.write  (cache reads DON'T count per Anthropic's rule)
      - OTPM counts: output + reasoning
      - total = input + output + reasoning + cache.read + cache.write
      - diffs against lastSeen Map to get delta since last tick
      - pushes { t, total, input, output, requests } into tokenWindow[]
  - tokenWindow entries older than 60s are discarded
  - setTpm / setItpm / setOtpm / setRpm / setTps from window sums
       │
       ▼
Signals update → SolidJS reactivity re-renders the panel
```

**Key point:** `recordTokens()` reads **cumulative** token totals from each
message and stores the last-seen value per message ID in a `Map<id, totals>`.
Each tick it diffs the new total vs the stored value to get the delta, then
pushes the delta into the rolling 60s window. This correctly handles:

- Streaming responses (tokens accumulate over multiple ticks)
- Multiple concurrent sessions (all iterated via Object.values)
- Multiple steps per message (all contribute to the cumulative total)

### Rate-limit headers (server-side capture → /ratelimit poll)

```
Anthropic API response arrives at the provider fetch wrapper in provider.ts
       │
       ▼
provider.ts custom fetch wrapper calls:
  RateLimit.record(model.providerID, response)
       │
       ▼
ratelimit.ts: reads response headers:
  - OAuth/Max path: unified-status, unified-5h-utilization, unified-5h-reset,
                    unified-7d-utilization, unified-7d-reset,
                    unified-representative-claim, overage-status, overage-disabled-reason
  - API key path:   ratelimit-tokens-remaining/limit, ratelimit-requests-remaining/limit
  - both paths:     retry-after, http status
  Also stamps plan info (subscriptionType, rateLimitTier, planLabel) from credentials.
  Stores in memory as `latest` snapshot.
  Publishes ratelimit.updated bus event.
       │
       ▼
server.ts: GET /ratelimit route returns the latest snapshot (204 if none yet).
  Also calls RateLimit.ensurePlan() to load plan info from ~/.claude/.credentials.json
       │
       ▼
sidebar.tsx: polls GET /ratelimit every 1 second via fetch(sdk.url + "/ratelimit")
  Calls setRateLimit(snap) → SolidJS reactivity re-renders the limit section
```

---

## Exact files involved

| File                                                           | Role                                                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `packages/opencode/src/provider/ratelimit.ts`                  | Captures headers from responses, holds latest snapshot in memory, exposes `record()` / `get()` / `ensurePlan()` / `planOnly()` |
| `packages/opencode/src/provider/provider.ts`                   | Custom fetch wrapper calls `RateLimit.record()` on every response                                                              |
| `packages/opencode/src/server/server.ts`                       | `GET /ratelimit` route — returns latest snapshot                                                                               |
| `packages/opencode/src/cli/cmd/tui/context/sdk.tsx`            | Exposes `sdk.url` (the opencode server base URL) to the TUI                                                                    |
| `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx` | All the rendering: `recordTokens()`, `noteRejection()`, poll loop, signals, JSX panel                                          |
| `packages/opencode/src/auth/index.ts`                          | `Auth.plan()` — reads `subscriptionType` + `rateLimitTier` from `~/.claude/.credentials.json`                                  |
| `~/.local/share/opencode/ratelimit-observed.json`              | Persisted observed ceiling (lowest throughput at 429 time)                                                                     |

---

## Token field shape (AssistantMessage)

The `tokens` object on a message in `sync.data.message[sessionID][n]`:

```typescript
tokens: {
  input: number,      // uncached input tokens (after cache breakpoints)
  output: number,     // output tokens
  reasoning: number,  // reasoning/thinking tokens
  cache: {
    read: number,     // tokens served from cache (DON'T count toward ITPM)
    write: number,    // tokens written to cache (DO count toward ITPM)
  }
}
```

Defined in: `packages/opencode/src/session/message-v2.ts` (AssistantMessage schema)
and `packages/sdk/openapi.json` (SDK type source of truth).

**ITPM formula (matches Anthropic's rule):**

```
ITPM = tokens.input + tokens.cache.write
```

Cache reads are excluded because Anthropic doesn't count them toward ITPM for
most models (this is documented in the official rate-limits docs).

---

## What can go wrong — the likely causes of a breakage

### 0. The `claude-code` provider is active (MOST LIKELY — diagnosed 2026-06-16)

**This is the probable root cause of the current breakage.**

Commit `8289c95` added a `claude-code` provider with `autoload: true` in
`provider/provider.ts`. This provider drives the `claude` CLI as a subprocess
rather than making HTTP requests to `api.anthropic.com` directly. It
**completely bypasses the HTTP fetch wrapper** where `RateLimit.record()` is
called, so:

- No rate-limit headers are captured → "Anthropic limits" section stays blank
- Token data from the subprocess may arrive differently or at different timing
  → per-minute TPM/ITPM/OTPM may be 0

**Check:** look at what provider is shown in the model picker. If it says
`claude-code` rather than `anthropic`, this is the issue.

**Fix options:**

1. **Use the `anthropic` provider** (the normal path with OAuth fallback) — the
   model picker should show models like `claude-opus-4-7` via `anthropic/*`,
   not `claude-code/*`.
2. **Make `claude-code` NOT autoload** — in `provider/provider.ts` change:
   ```typescript
   "claude-code": async () => {
     return { autoload: true, options: {} }  // ← THIS
   ```
   to:
   ```typescript
   "claude-code": async () => {
     // Only autoload if the user explicitly opted in via config
     const cfg = await Config.global()
     return { autoload: cfg.provider?.["claude-code"]?.enabled === true, options: {} }
   ```
3. **Add RateLimit.record() to the claude-code subprocess path** — in
   `provider/sdk/claude-code/src/index.ts`, synthesize a fake `Response`
   object from the subprocess output and call `RateLimit.record()` on it.
   This is the most work but gives the best result.

**Quick diagnosis:** run qalcode2, send a message, then:

```bash
curl http://localhost:4096/ratelimit
# If 204 (no content), the fetch wrapper isn't capturing headers.
# If JSON with unified-status etc., the provider is working correctly.
```

### 1. `m.tokens` is undefined or null

`recordTokens()` does `if (!t) continue` — so if `m.tokens` is undefined,
the message is silently skipped and TPM stays 0.

**Why this happens:** Messages may not have `tokens` set until the `step-finish`
part arrives. During streaming, `message.updated` fires repeatedly but `tokens`
is only populated once the step finishes. If QTK or another change altered the
event flow so `step-finish` isn't arriving or `tokens` is no longer on the
message object at the top level, `recordTokens()` would see empty data.

**Debug check:** In the browser console (Tauri dev tools), run:

```js
// Check what sync.data.message actually contains
// Look for tokens: {...} on assistant messages
```

Or add a temporary `console.log(m.id, m.role, m.tokens)` inside `recordTokens()`.

### 2. `sync.data.message` is empty or the wrong shape

The store key is `sessionID → Message[]`. If `Object.values(sync.data.message)`
returns empty arrays or the messages have the wrong shape (e.g. they're wrapped
in an extra `.info` layer), `recordTokens()` produces nothing.

**Check:** confirm `messages.data!.map((x) => x.info)` on line 347 of `sync.tsx`
is still correct. If the API now returns messages differently (e.g. unwrapped),
the messages might be arriving as `x` not `x.info`, and `m.tokens` would be
undefined (token field is one level off).

### 3. The 1s tick isn't running

`rlTimer = setInterval(...)` in `onMount`. If the component unmounts and remounts
(e.g. navigation), `onCleanup` kills the timer, and `onMount` should restart it.
If something prevents the mount, the tick never runs.

### 4. The `lastSeen` Map is populated but deltas are always 0

If tokens arrive once and are never updated (e.g. `message.updated` stops firing
after step-finish), the `if (total > prev.total)` check never triggers on
subsequent ticks because the cumulative total doesn't grow.

### 5. QTK or another agent modified the message store event handler

If `case "message.updated"` in `sync.tsx` was changed to not store token data,
or if the message schema changed upstream (e.g. `tokens` moved to a different
field name), `recordTokens()` reads stale/empty values.

---

## How to debug it live

**Step 1:** Add a temporary log to `recordTokens()` to see what's coming in:

```typescript
function recordTokens() {
  const now = Date.now()
  let total_messages = 0,
    assistant_messages = 0,
    has_tokens = 0
  for (const messages of Object.values(sync.data.message)) {
    for (const m of messages) {
      total_messages++
      if (m.role !== "assistant") continue
      assistant_messages++
      if (m.tokens) has_tokens++
      // log the first one
      if (assistant_messages === 1) console.log("sample msg:", m.id, m.role, m.tokens)
    }
  }
  console.log(`recordTokens: total=${total_messages} assistant=${assistant_messages} with_tokens=${has_tokens}`)
  // ... rest of function
}
```

**Step 2:** Check what the server /ratelimit endpoint returns:

```bash
curl http://localhost:4096/ratelimit
# Should return JSON with at least { "at": <epoch> }
# If 204, no rate-limit headers have been captured yet (normal before first message)
```

**Step 3:** Verify `provider.ts` is still calling `RateLimit.record()`:

```bash
grep -n "RateLimit.record" packages/opencode/src/provider/provider.ts
# Should show one match around line 799
```

**Step 4:** Check `ratelimit-observed.json` exists and has data:

```bash
cat ~/.local/share/opencode/ratelimit-observed.json
```

---

## Quick reference: the 3 rate-limit tiers on a Max account

| Layer                 | Window                        | Where we observe it                                                 |
| --------------------- | ----------------------------- | ------------------------------------------------------------------- |
| Short burst/per-min   | ~60s (undocumented for OAuth) | **Measured locally** from token deltas + learned from observed 429s |
| 5-hour session window | 5h rolling                    | `anthropic-ratelimit-unified-5h-utilization` header (0.0–1.0)       |
| 7-day weekly window   | 7d rolling                    | `anthropic-ratelimit-unified-7d-utilization` header (0.0–1.0)       |

The per-minute numbers you see (TPM/ITPM/OTPM/RPM) are your **measured usage**.
Anthropic does not send per-minute limit ceilings for OAuth/Max accounts — only
the 5h/7d utilization fractions. You discover your effective per-minute ceiling
by observing when you get 429'd (the "Observed limit" section in the panel).

Full undocumented header reference: `docs/ANTHROPIC_RATELIMIT_HEADERS.md`
