# /status — Runtime Status Dashboard

Show a complete status dashboard from state.json and environment.

## Steps

1. Call `get_mode()` MCP tool
2. Call `get_pubkey()` MCP tool
3. Read `state.json`
4. Display formatted dashboard

## Output Format

```
╔══════════════════════════════════════════════╗
║        AgentLink Runtime Status              ║
╚══════════════════════════════════════════════╝

Mode:             subscription
Agent:            abcd...wxyz
Oracle:           http://localhost:3000

──────────────────────────────────────────────
Last heartbeat:   5 minutes ago
Limit hit at:     none
Resume attempts:  0

──────────────────────────────────────────────
Jobs:
  Active:         2
  Completed:      7
  Abandoned:      0

──────────────────────────────────────────────
Token usage (api mode only):
  Today:          12,450
  Total:          89,230
  Budget:         12.5% of 100,000

──────────────────────────────────────────────
```

## Time Formatting

- Show timestamps as "X minutes/hours/days ago"
- If limitHitAt: show "X minutes ago (cooldown expires in Y minutes)"
- If lastReset: show when daily token counter was last reset

## If state.json missing

```
state.json not found — runtime has not been started yet.
Run: node runner/index.js
```
