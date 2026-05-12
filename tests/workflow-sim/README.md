# L4 — Workflow Simulation

These tests **drive the real MCP server through scripted tool sequences** to verify that each FLOWS.md flow produces the right state transitions, audit events, and role-enforcement behavior — **without needing Claude Code to be running**.

The harness is `tests/mcp-integration/harness.mjs` (shared with L3). Each test spawns the MCP server in a subprocess, opens an in-memory SQLite DB (`TRAJECTORY_DB_PATH=:memory:`), and walks one flow end-to-end as multiple MCP tool calls — first as bro, then SWE, then pr-reviewer, etc.

## Coverage map

Cross-reference: [`docs/architecture/FLOWS.md`](../../docs/architecture/FLOWS.md).

| FLOWS.md flow | Test file | Status |
|---|---|---|
| 1 — First-run onboarding | n/a | **L5 only** — depends on Claude AskUserQuestion + filesystem template copy |
| 2 — Simple task | `flow-02-simple-task.test.mjs` | ✅ end-to-end MCP sequence |
| 3 — Difficult task | `flow-03-difficult-task.test.mjs` | ✅ Q+A discussions + decision record |
| 4 — Agent-creator | n/a | **L5 only** — pure filesystem write |
| 5 — Skill creation | n/a | **L5 only** — pure filesystem write |
| 6 — Push gate | `flow-06-push-gate.test.mjs` | ✅ closed-task + validation_record + retry |
| 7 — Scan + architecture refresh | covered by `mcp/trajectory-server/src/test/scan.test.ts` (unit) | ✅ scan_run + deep_scan_completed audit |
| 8 — SWE retry / escalation | `flow-08-swe-retry.test.mjs` | ✅ multiple validation_attempts + status='escalated' |
| 9 — Roundtable | n/a | covered by audit 'roundtable_summary' event in flow-03 + role-matrix |
| C — Consultant invocation | n/a | covered by `tests/mcp-integration/role-matrix.test.mjs` |

## What L4 does NOT test

- The **Claude side** of the chain — bro's prompt parsing, AskUserQuestion rendering, agent-spawn isolation, subagent prompt precedence. Those need L5 (manual dogfood with Claude Code).
- **Filesystem-only flows** (template copy, ADR file write, agent-creator file write) — handled directly by bash via Bro's tools, not by MCP. Those are caught at Layer 0 (file presence after install) and Layer 5 (visual confirmation).

## Why these flows exist as L4 tests

Each test asserts the **structural contract** of a flow:

- The right MCP tools get called in the right order
- The right rows land in the right tables
- Role enforcement (`requireRoles`) fires correctly per agent
- Audit events are recorded for downstream snapshot/report use
- Status transitions follow the documented state machine

If a flow's contract changes (new step, new role enforcement, new audit event), the corresponding test file changes too — that's how `FLOWS.md` and the code stay in sync.

## Running

These tests are run by the integration runner alongside `tests/mcp-integration/`:

```
bash tests/mcp-integration/run.sh
```

Or via the full suite:

```
bash tests/run-all.sh
```

CI runs them on every PR.
