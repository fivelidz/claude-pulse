# Claude Pulse — where the numbers come from (and the honest limits)

This is the document to read before trying to "make the graph work." It explains
exactly how each number is obtained, why per-minute token data is hard, and the
realistic options for getting it automatically.

---

## The three independent metrics (different sources)

| Metric | Source | Works without anything extra? |
| --- | --- | --- |
| **5h / 7d window %** + reset times | Anthropic HTTP **response headers** (`anthropic-ratelimit-unified-*`) | Only if traffic flows through the collector proxy, OR a local qalcode2/opencode `/ratelimit` endpoint is polled |
| **Tokens / min** (TPM/ITPM/OTPM) | **Counting individual requests** — the `usage` object on each response | Only if requests are observed (proxy) or read from a tool's own records |
| **Observed per-minute ceiling** | The TPM level at the moment a **429** happens | Derived from the above |

**Critical fact:** Anthropic does **not** expose a tokens-per-minute time series.
There is no "get my usage history" endpoint. The only way to graph tokens/min is
to **count each request as it happens**. So a per-minute graph fundamentally
requires *observing the traffic* — there is no shortcut via an API.

---

## How qalcode2 computes its by-minute panel (reference)

See `BY_MINUTE_USAGE_PANEL.md` (copied from qalcode2) for the full version. The
short version, because it explains why Claude Pulse can't just "read it from a
file":

- qalcode2 watches its **in-memory reactive message store**. On each
  `message.updated` bus event it stores the message's cumulative `tokens`
  `{input, output, reasoning, cache:{read,write}}`.
- Every 1s, `recordTokens()` diffs each message's cumulative total against the
  last-seen value, pushes the delta into a rolling 60s window, and sums it →
  TPM / ITPM / OTPM / RPM.
- **ITPM = input + cache.write** (cache *reads* are excluded — Anthropic's rule).
- This data lives **only in memory**. It is never written to a file or DB that an
  external tool could read.

So "read qalcode2's per-minute data" is not possible by design — it's a live
in-process computation. Claude Pulse must observe traffic itself, the same way
qalcode2 does internally.

### Known breakage (2026-06): the `claude-code` provider
If qalcode2's own panel shows zeros, the usual cause is the `claude-code`
provider being autoloaded — it drives the `claude` CLI as a subprocess and
**bypasses the HTTP fetch wrapper** where headers + tokens are captured. Fix:
use the `anthropic` provider, or stop `claude-code` autoloading. (Details in
`BY_MINUTE_USAGE_PANEL.md` §0.) This does **not** affect Claude Pulse directly —
Claude Pulse never read qalcode2's in-memory data — but it's why "live numbers
stopped" in qalcode2 itself.

---

## How Claude Pulse gets tokens/min today

1. **Collector proxy (primary, works for anybody).** Point a tool at
   `ANTHROPIC_BASE_URL=http://localhost:8787`. Every response is forwarded
   untouched; the `usage` object + rate-limit headers are appended to
   `usage.jsonl` as a `request` line. Real per-request tokens → real tokens/min.
2. **opencode/qalcode2 DB importer (`collector/opencode-source.ts`).** Reads
   assistant-message token counts from `~/.local/share/opencode/opencode.db`
   (read-only) and appends them as `request` lines. Gives historical tokens/min
   for opencode users **only as far back as that DB has data** — note opencode
   writes this DB only for some providers, and it can go stale (e.g. when the
   `claude-code` subprocess provider is active, nothing is written).

Both are honest: if no recent traffic is observed, the graph is correctly empty.

---

## The right long-term design: system-wide transparent capture

The recurring goal is "open it and see my own tokens/min, no fuss." The only way
to do that automatically — for any Claude tool, without per-tool config — is to
**observe the machine's traffic to `api.anthropic.com`**. Options, honestly
ranked:

### A. Transparent system proxy (recommended)
Make the collector a transparent proxy that captures **all** localhost→Anthropic
traffic without the user setting `ANTHROPIC_BASE_URL` per tool. Mechanisms:
- A local HTTP(S) proxy + a one-time `HTTPS_PROXY`/system-proxy setting, **or**
- `/etc/hosts` + local TLS termination with a user-installed local CA.

Pros: works for every tool automatically; real tokens/min + headers.
Cons: requires terminating TLS (a locally-trusted CA the user installs once).
This is still local-first — the CA and key never leave the machine, and we only
read metadata. It's the same trust model as tools like mitmproxy / Proxyman.

### B. eBPF / uprobes on the TLS library
Hook `SSL_write`/`SSL_read` to read plaintext before encryption. Powerful and
truly zero-config, but needs root, is fragile across libssl versions, and is
hard to ship. Not recommended for v1.

### C. Per-tool opt-in (current)
`ANTHROPIC_BASE_URL=http://localhost:8787`. Zero special privileges, but the user
must set it for each tool. This is what works today.

### What does NOT work
- A bare web page reading your usage (browser can't see traffic or files).
- Reading encrypted packets off the wire without TLS termination.
- Any Anthropic endpoint returning a tokens/min history (none exists).

---

## Debugging "no data"

```bash
# 1. Is the collector running + serving?
curl -s localhost:8788/api/health

# 2. Is there a live rate-limit source (5h/7d)?
curl -s localhost:8787/ratelimit   # via collector overlay
# or directly on a qalcode2 server:
curl -s localhost:4096/ratelimit

# 3. How fresh is the token data in the log?
tail -1 ~/.local/share/claude-pulse/usage.jsonl

# 4. Is opencode's DB stale? (newest message age)
#    If this is months old, opencode isn't recording — use the proxy instead.
```

If the newest token line is older than your selected graph range, the graph is
**correctly** empty. Get recent data by routing a tool through the proxy.
