# Claude Pulse × gmux integration

Show live **tokens/min + 5h/7d rate-limit windows** as a status item inside
[gmux](https://github.com/fivelidz/gmux) — its tmux status bar and phone PWA.

## How it works

Claude Pulse's collector writes a sidecar JSON to a project's `.opencode/`
directory; gmux reads it per-pane (same pattern it uses for QTK savings).

**Enable the exporter** (writes `.opencode/claude-pulse.json` every 5s):

```bash
# in the collector
bun run proxy.ts --web --gmux /path/to/your/project
# or, project dir from env / cwd:
CLAUDE_PULSE_GMUX=1 CLAUDE_PULSE_PROJECT=/path/to/project bun run proxy.ts --gmux
# or write once:
bun run collector/gmux-export.ts /path/to/project
```

### Sidecar schema — `.opencode/claude-pulse.json`

```jsonc
{
  "schema": 1,
  "ts": 1781597166575,   // epoch ms
  "tpm": 4592,           // tokens/min (last 60s)
  "rpm": 7,              // requests/min (last 60s)
  "u5h": 0.85,           // 5-hour window utilization (0..1)
  "u7d": 0.99,           // 7-day window utilization (0..1)
  "reset5h": 1781600400, // epoch s
  "reset7d": 1781614800, // epoch s
  "plan": "Max 20×",
  "status": "allowed_warning"
}
```

## gmux side — the edits to surface a "claude-pulse" item

gmux has no generic sidecar auto-discovery, so add a small reader/formatter
(mirrors the existing QTK code). Four edits:

### 1. `src/status/monitor.py`
```python
CLAUDE_PULSE_REL = ".opencode/claude-pulse.json"   # near QTK_SAVINGS_REL (~line 58)

def read_claude_pulse(project_dir):                 # clone read_qtk_savings (~line 1013)
    # mtime-cached read of <project_dir>/.opencode/claude-pulse.json
    # return dict or None; require data.get("schema") == 1
    ...
```
Add to the `PaneInfo` dataclass:
```python
pulse_tpm: int = 0
pulse_u5h: float = 0.0
pulse_u7d: float = 0.0
pulse_plan: str = ""
```
Populate them in the pane-scan block (~lines 957–1001), next to the `qtk_*`
assignment:
```python
cp = read_claude_pulse(project_dir)
if cp:
    t = cp.get("totals", cp)
    pane.pulse_tpm  = cp.get("tpm", 0)
    pane.pulse_u5h  = cp.get("u5h", 0.0)
    pane.pulse_u7d  = cp.get("u7d", 0.0)
    pane.pulse_plan = cp.get("plan") or ""
```

### 2. `src/status/pane_status.py`
```python
def format_pulse_widget(pane):                      # clone format_qtk_widget (~line 247)
    if not pane.pulse_tpm and not pane.pulse_u5h:
        return ""
    tpm = _fmt_tokens(pane.pulse_tpm)
    u5 = round(pane.pulse_u5h * 100)
    u7 = round(pane.pulse_u7d * 100)
    return f"#[fg=colour173]⚡ {tpm}/m 5h{u5}% 7d{u7}%#[default]"
```
Append it in `format_status_right()` (~line 353), next to the QTK widget.

### 3. `src/voice/phone_bridge.py`
In `get_pane_summary()` (~lines 119–124) add the `pulse_*` fields to the dict.

### 4. `src/overlay/phone.html`
Add a `pulseHtml` card block near the `qtkHtml` block (~line 633) reading
`agent.pulse_tpm`, `agent.pulse_u5h`, `agent.pulse_u7d`.

## Result

The tmux status bar shows, per active pane/project:

```
⚡ 4.6K/m 5h85% 7d99%
```

— live tokens/min and your rolling-window utilization, right where you work.
The same fields flow to the phone PWA card via the gmux WS bridge (:8767).
