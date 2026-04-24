# Testing

Three-layer test framework for the TMB plugin. Each layer catches a different class of bug; skipping any layer means shipping a bug the others cannot see.

| Layer | What | Where | Runs | Catches |
|---|---|---|---|---|
| **1 — Unit** | Handler logic with synthetic args; no LLM, no protocol | `mcp/trajectory-server/src/test/*.test.ts` | `bun run test` (CI) | Handler bugs, constraint violations, return-shape drift |
| **2 — Integration** | Real server subprocess over JSON-RPC stdio; per-agent workflows + role matrix + schema contract | `tests/mcp-integration/*.test.mjs` | `bun run test` (CI) | Schema drift, missing `agent` param, protocol plumbing, role-enforcement gaps, cross-tool workflow bugs |
| **3 — Dogfood** | Human-driven interactive Claude Code session | [`docs/architecture/SCENARIOS.md`](../architecture/SCENARIOS.md) | Manual (follow [`local-setup.md`](./local-setup.md)) | UX regressions, agent prompt drift, routing decisions, anything that depends on real LLM judgment |

**Golden rule:** *Layer N green does not imply Layer N+1 green.* Layer 1 passed with 235 tests while a critical bug sat in production — the MCP schema stripped the `agent` parameter on every call, collapsing all role checks to `caller_role: 'unknown'`. Layer 2 would have caught that at the wire level in milliseconds. Always run all three.

---

## Layer 1 — Unit

**Purpose:** verify each MCP handler's business logic with synthetic arguments. Calls the handler function directly, bypassing the MCP SDK and the JSON-RPC wire.

**Runtime:** Node's built-in test runner (`node --test`) against compiled `dist/` output.

**Run:**

```bash
cd mcp/trajectory-server
bun run build && node --test dist/test/*.test.js
# Or via the orchestrator:
bash tests/run-all.sh
```

**What it catches:**
- Handler logic errors (wrong column written, wrong row returned)
- SQLite constraint violations (schema-level invariants)
- Validation regex drift
- Return-shape drift (the shape tests already exercise)

**What it cannot catch:**
- Anything that depends on the MCP inputSchema (validation layer strips unknown params before handler sees them)
- Role enforcement via `requireRoles` middleware (tests pass `agent: 'x'` synthetically; in production the MCP SDK decides whether the param even reaches the handler)
- Protocol plumbing bugs (stdio transport, JSON-RPC framing)
- Cross-tool workflow bugs (does bro's onboarding sequence actually complete without intermediate state corruption)

**When to add:**
- Every new MCP tool gets at least one unit test for the happy path, one per validation failure, and one per distinct state transition it implements.

---

## Layer 2 — Integration

**Purpose:** exercise the real MCP server as users' agents do — spawn the compiled binary as a subprocess, speak JSON-RPC over stdio, verify both the protocol and the business logic end-to-end.

**Runtime:** Node test runner against `.mjs` test files that use the `@modelcontextprotocol/sdk` client to connect to the server.

**Run:**

```bash
bash tests/mcp-integration/run.sh
# Or via the orchestrator:
bash tests/run-all.sh
```

**Test categories:**

- **Schema contract** (`schema-contract.test.mjs`) — every tool's inputSchema declares `agent` with the four-role enum. One test, guards the entire MCP surface.
- **Role matrix** (`role-matrix.test.mjs`) — for every tool that wraps its handler with `requireRoles`, verify: missing `agent` → forbidden; wrong `agent` → forbidden; right `agent` → success.
- **Per-agent workflows** (`agent-{bro,architect,swe,pr-reviewer}-workflow.test.mjs`) — each agent runs its realistic end-to-end MCP sequence.
  - `bro`: onboarding sequence (identity + config × 3), reonboard rename, session-start resume.
  - `architect`: simple-task flow, difficult-task flow with ADR thread, skill lifecycle.
  - `swe`: pickup → running → atomic close, with ledger + audit + file_registry.
  - `pr-reviewer`: pass path, fail path, 3-attempt retry loop.

**What it catches:**
- Schema drift that breaks param passthrough (the bug that caused 0-tool-uses in PR #41 dogfood).
- Missing `requireRoles` wrappers on tools that should be role-restricted.
- Required-arg signature changes (caught 3 such bugs in `ledger_log`, `issue_resume`, `skill_promote` while writing the workflow tests).
- Cross-tool invariants (e.g., validation_record writes must be visible via validation_history within the same session).

**What it cannot catch:**
- UX regressions in agent prompts.
- Routing logic that depends on LLM judgment.
- Whether the agent *chooses* to call the right MCP at the right time — it tests that the call works when made.

**When to add:**
- Every new MCP tool that wraps `requireRoles` gets a role-matrix test.
- Every new behavioral responsibility added to any of the four core agents gets a line in that agent's workflow test.
- Every protocol-level concern (schema, transport, error shape) gets a contract test.

**Regression teeth proof:** removing `requireRoles('identity_set', ['bro'], …)` from `identity.ts` → Layer 2 fails on the very next run with `architect must be forbidden from identity_set`. Verified 2026-04-24.

---

## Layer 3 — Dogfood

**Purpose:** exercise the full stack with a real LLM driving real agents — the only way to validate UX, prompt drift, routing quality, and everything that depends on model judgment.

**Runtime:** human-driven. You run `claude --plugin-dir …` in a scratch project and follow a scenario script.

**Run:**

1. Follow [`local-setup.md`](./local-setup.md) for environment setup.
2. Walk [`docs/architecture/SCENARIOS.md`](../architecture/SCENARIOS.md) — 30+ scenarios mapped to [`docs/architecture/FLOWS.md`](../architecture/FLOWS.md).
3. Record observations in each scenario's pass/fail checkbox.
4. File GitHub issues for any scenario that doesn't match its "expected behavior" column.

**What it catches:**
- Agent routing mistakes (bro skips onboarding, architect bypasses validation, etc.).
- Prompt drift (agent forgets to call a required MCP).
- UX regressions (multi-choice form feels awkward, default values wrong).
- Anything an LLM can mis-read.

**What it cannot catch efficiently:**
- Regressions in tool schemas or role enforcement — those are Layer 1/2 concerns. If Layer 3 finds a schema bug, that's a signal Layer 1/2 coverage is incomplete.

**When to add:**
- Every new user-facing flow (new scenario entry in `SCENARIOS.md`).
- Every change to an agent's routing rules.
- Every release candidate (smoke-run the top-10 scenarios before tagging).

---

## Decision tree: which layer?

```
Is the change a pure handler detail (SQL, validation, return shape)?
  → Layer 1 only.

Does the change touch:
  - a tool's inputSchema?
  - a requireRoles wrapper?
  - cross-tool invariants (e.g., validation_history must reflect validation_record)?
  - an agent's MCP responsibility sequence?
  → Layer 1 AND Layer 2.

Does the change affect:
  - an agent's prompt?
  - a skill's behavior?
  - a routing rule in bro/architect?
  - the UX of any user-facing interaction?
  → Layer 1 AND Layer 2 AND Layer 3 (add a scenario).
```

---

## Running the full battery

```bash
# All automated layers (CI also runs this):
bun run test
```

This runs: 235 Layer 1 unit + 21 Layer 2 integration + 16 hook script tests + 4 agent-budget lint checks. Expected runtime ≤ 10s on a modern laptop.

For Layer 3, follow [`local-setup.md`](./local-setup.md) and walk [`docs/architecture/SCENARIOS.md`](../architecture/SCENARIOS.md). There's no automated runner — the point is human observation.

---

## Anti-patterns

- **"Layer 1 is green, ship it."** Layer 1 bypasses the MCP protocol layer. The 0-tool-uses bug in PR #41 had 235 Layer 1 tests green while every `identity_set` call in production returned `forbidden` because the schema stripped the `agent` param before the handler saw it. Always validate at the wire level.
- **"Layer 3 will catch it."** Dogfood is slow (minutes per scenario) and non-deterministic (depends on LLM). Schema bugs, role bugs, and required-arg bugs should be caught in ms by Layer 2. Layer 3 is for what only a real LLM session can reveal.
- **"The handler already validates args, so schema doesn't matter."** It does. The LLM discovers what params to pass from the inputSchema. If `agent` isn't declared, the LLM won't pass it, and role enforcement silently fails.
- **Adding a new MCP tool without a Layer 2 test.** Ship a test alongside the tool, not after. Every protected tool must have a role-matrix test; every tool used in any agent's workflow must appear in that agent's workflow test.

---

## Related

- [`tests/README.md`](../../tests/README.md) — test harness layout on disk
- [`local-setup.md`](./local-setup.md) — how to run Layer 3
- [`docs/architecture/SCENARIOS.md`](../architecture/SCENARIOS.md) — Layer 3 scenario library
- [`docs/architecture/FLOWS.md`](../architecture/FLOWS.md) — the workflows scenarios map to
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — pre-PR checklist
