# Dogfood Test Scenarios

For each workflow in [`FLOWS.md`](FLOWS.md), the verbatim user prompt that triggers it + the observable expected behavior + how to verify it landed correctly.

These are the **manual test cases** for the plugin. Run during a fresh `claude --plugin-dir <PLUGIN_PATH>` session against a disposable scratch project (see [`docs/local-testing.md`](../local-testing.md) for setup).

## How to use this doc

For each scenario:

1. Set up the **prerequisites** (e.g., delete the DB, create some agents via flow #4 first).
2. Type the **trigger prompt** verbatim into Claude Code.
3. Watch the agent output against **expected behavior**.
4. Run the **verification** command(s) to confirm what landed in the DB / filesystem.
5. Tick ✓ or note the deviation in the trailing checkbox.

Reset between scenarios with `rm -rf .claude/tmb/` in the scratch project.

## Index by trigger style

| Trigger style | Scenarios |
|---|---|
| Implicit (any first prompt) — fires on null DB state | 1.1, 1.2, 1.3 |
| Code change implementation | 2.1–2.3, 3.1–3.3 |
| Explicit magic word ("re-onboard", "refresh architecture", "roundtable") | 1.4, 7.1, 9.1, 9.2 |
| On-demand domain agent ("I need an X agent") | 4.1–4.4 |
| Implicit cross-domain question (architect detects → invokes roundtable) | 9.3, 9.4 |
| Auto-fired (no user prompt) | 5.1, 6.1, 7.2–7.4, 8.1–8.2 |
| Status / read-only | (no agent spawn — silent) |

## Index by flow

| Flow | FLOWS.md § | Scenarios |
|---|---|---|
| 1 — First-Run Onboarding | [§1](FLOWS.md#1-first-run-onboarding) | 1.1, 1.2, 1.3, 1.4 |
| 2 — Simple Task | [§2](FLOWS.md#2-simple-task) | 2.1, 2.2, 2.3 |
| 3 — Difficult Task | [§3](FLOWS.md#3-difficult-task) | 3.1, 3.2, 3.3 |
| 4 — Agent-creator | [§4](FLOWS.md#4-agent-creator-on-demand-domain-agent) | 4.1, 4.2, 4.3, 4.4 |
| 5 — Skill Creation | [§5](FLOWS.md#5-skill-creation) | 5.1 |
| 6 — PR Review | [§6](FLOWS.md#6-pr-review) | 6.1 |
| 7 — Architecture Regen | [§7](FLOWS.md#7-architecture-regen) | 7.1, 7.2, 7.3, 7.4 |
| 8 — SWE Retry / Escalation | [§8](FLOWS.md#8-swe-retry--escalation) | 8.1, 8.2 |
| 9 — Roundtable | [§9](FLOWS.md#9-roundtable-multi-agent-deliberation) | 9.1, 9.2, 9.3, 9.4 |

---

## Flow 1 — First-Run Onboarding

### 1.1 — Fresh DB, any first prompt triggers onboarding

**Prerequisites:** `rm -rf .claude/tmb/` (no DB yet).

**Trigger prompt:**
> `hello`

**Expected behavior:**
1. Bro greets, introduces itself.
2. Asks "What should I call you?"
3. Asks "What would you like to call me? (default: bro)"
4. Asks branching model (1/2/3).
5. Based on choice, asks PR target (with default).
6. Asks protected branches if `custom`.
7. Closing: "Done. Identity and branching model saved. Tell me what you want to work on."

**Verification:**
```bash
sqlite3 .claude/tmb/trajectory.db <<'SQL'
SELECT * FROM identity;
SELECT key, value_json FROM plugin_config;
SQL
```
Expect rows in `identity` and 3 keys in `plugin_config` (branching_model, pr_target, protected_branches).

**Pass:** [ ]

### 1.2 — Code-touching ask DURING onboarding is held

**Prerequisites:** Reset DB. Start onboarding (type `hello`); answer through Step 1 (identity) but stop before Step 2.

**Trigger prompt** (mid-onboarding):
> `add a hello-world endpoint to the api`

**Expected behavior:**
1. Bro acknowledges the code-touching ask but **does not route to architect**.
2. Says something like "I'll get to that as soon as we finish setup. What's your branching model?"
3. Continues onboarding.
4. After onboarding closes, surfaces the held request: "Now — about that hello-world endpoint…"

**Verification:** No `tasks` row created during onboarding; no architect spawn in the session log.

**Pass:** [ ]

### 1.3 — Read-only ask DURING onboarding is answered, then resumes

**Prerequisites:** Reset DB. Start onboarding; pause before Step 2.

**Trigger prompt** (mid-onboarding):
> `what files are in this repo?`

**Expected behavior:**
1. Bro answers the read-only question (lists files).
2. Immediately resumes onboarding from where it paused.

**Pass:** [ ]

### 1.4 — Re-onboarding (explicit phrase, post-onboarding)

**Prerequisites:** Onboarding complete (1.1 passed). DB has identity + config rows.

**Trigger prompt:**
> `change branching model to gitflow`

**Expected behavior:**
1. Bro recognizes the re-onboard phrase.
2. Invokes `tmb-reonboard` skill (no agent spawn).
3. Re-runs the 3-step onboarding with **current values as press-enter defaults**.
4. Persists changes via `config_set`.

**Verification:** `plugin_config.branching_model` updated; `identity` unchanged unless rename was also requested.

**Pass:** [ ]

---

## Flow 2 — Simple Task

All three should produce: `triage:simple`, trivial template task spec, no ADR, architect → swe → pr-reviewer chain.

### 2.1 — Typo fix

**Prerequisites:** Onboarded scratch project with at least a README.

**Trigger prompt:**
> `fix the typo in README — "recieve" should be "receive"`

**Expected behavior:**
1. Bro pre-scans (inventory block emitted).
2. Proposes branch_id like `fix/typo-receive` + `triage: simple`.
3. Waits for "y".
4. Spawns architect with `task_id=N`.
5. Architect creates trivial-template task; spawns SWE.
6. SWE creates worktree, fixes the typo, commits.
7. pr-reviewer signs off; architect closes.

**Verification:**
```sql
SELECT branch_id, status, commit_sha FROM tasks ORDER BY id DESC LIMIT 1;
SELECT verdict FROM validation_attempts ORDER BY id DESC LIMIT 1;
```
Expect status='closed', verdict='pass'.

**Pass:** [ ]

### 2.2 — Add a code comment

**Trigger prompt:**
> `add a doc comment to the parseConfig function explaining what each option means`

**Expected:** Same as 2.1; `triage: simple`, no architecture/ touched.

**Pass:** [ ]

### 2.3 — Internal refactor with no API change

**Trigger prompt:**
> `extract the validation logic in parseConfig into a separate helper function — same external behavior`

**Expected:** Architect double-checks triage; if no public API surface changes, stays `simple`. Trivial-template spec.

**Pass:** [ ]

---

## Flow 3 — Difficult Task

All three should produce: `triage:difficult`, ADR file at `docs/trustmybot/architecture/manual/decisions/`, `discussion_append(kind='decision')` row, standard-template task spec.

### 3.1 — Add a new public API surface

**Trigger prompt:**
> `add OAuth login to our API — support Google and GitHub providers`

**Expected behavior:**
1. Pre-scan emitted.
2. Proposes branch_id like `feat/oauth-login` + `triage: difficult`.
3. After confirmation, architect spawns.
4. Architect aligns via `discussion_append(kind='question')` if any open questions.
5. Architect appends `discussion_append(kind='decision')` with the architectural plan.
6. Architect creates ADR at `docs/trustmybot/architecture/manual/decisions/N-oauth.md`.
7. THEN creates standard-template tasks; spawns SWE; pr-reviewer signs off.

**Verification:**
```bash
ls docs/trustmybot/architecture/manual/decisions/
```
Expect a new ADR file.

```sql
SELECT kind, body FROM discussions WHERE issue_id=<latest> ORDER BY id;
```
Expect at least one row with `kind='decision'`.

**Pass:** [ ]

### 3.2 — Schema / data-model change

**Trigger prompt:**
> `migrate from SQLite to Postgres for production`

**Expected:** difficult triage (data model change + new dependency); ADR + standard template.

**Pass:** [ ]

### 3.3 — Cross-cutting concern

**Trigger prompt:**
> `add structured request logging across every API endpoint`

**Expected:** difficult triage (new cross-cutting concern); ADR + standard template.

**Pass:** [ ]

---

## Flow 4 — Agent-creator

### 4.1 — User requests a domain role that doesn't exist

**Prerequisites:** No `legal-reviewer.md` in `.claude/agents/`.

**Trigger prompt:**
> `I need a legal-reviewer for this PR — someone who knows GDPR`

**Expected behavior:**
1. Bro recognizes role not in roster.
2. Says: "There's no legal-reviewer agent. Want me to create it via agent-creator? (yes/no)"
3. Waits for explicit yes.

**Pass:** [ ]

### 4.2 — User says yes; agent gets created

**Continuation of 4.1.**

**Trigger prompt:**
> `yes`

**Expected behavior:**
1. agent-creator skill asks up to 3 clarifying questions about scope/tools/responsibilities.
2. Drafts a tailored prompt.
3. Shows the prompt; asks final approval.
4. On final yes → writes `.claude/agents/legal-reviewer.md`.
5. Future routing recognizes the new agent.

**Verification:** `ls .claude/agents/` shows `legal-reviewer.md`.

**Pass:** [ ]

### 4.3 — User says no; bro routes via existing roster

**Continuation of 4.1, but say no instead.**

**Trigger prompt:**
> `no`

**Expected:** No file created; bro routes the original request through architect (or whichever agent best fits).

**Pass:** [ ]

### 4.4 — Reserved name refused

**Trigger prompt:**
> `create a new architect2 agent`

**Expected:** Skill refuses with "architect is a reserved name." (Same for `gatekeeper`, `swe`, `pr-reviewer`.)

**Pass:** [ ]

---

## Flow 5 — Skill Creation

Skill creation is mostly an internal architect decision — not directly user-triggered. Verified indirectly when architect identifies a recurring pattern.

### 5.1 — Architect proposes a skill after recurring pattern

**Hard to trigger reliably in a single session.** Observable when:
- Architect has executed the same checklist 2+ times in different tasks
- Architect surfaces: "I notice we keep doing X. Should I create a `<name>` skill so SWE has the checklist available?"

**Pass / Skip:** [ ]

---

## Flow 6 — PR Review

### 6.1 — pr-reviewer fires after SWE marks task completed

Auto-triggered as part of every successful task in flow 2 / 3. Verification:

```sql
SELECT t.branch_id, v.attempt_n, v.verdict, v.feedback
FROM validation_attempts v
JOIN tasks t ON v.task_id = t.id
ORDER BY v.id DESC LIMIT 5;
```

Expect at least one row per closed task with `verdict='pass'` (or `'fail'` followed by retry attempts).

**Pass:** [ ]

---

## Flow 7 — Architecture Regen

### 7.1 — Explicit phrase, full regen

**Trigger prompt:**
> `refresh architecture docs`

**Expected behavior:**
1. Bro recognizes the phrase (no architect spawn, no triage).
2. Invokes `refresh-architecture` skill with `scope:'full'`.
3. Calls `architecture_regen`.
4. 4 files updated under `docs/trustmybot/architecture/auto/`: `codebase-tree.md`, `erd.md`, `module-graph.md`, `changelog.md`.
5. Each carries a generated-header on line 1.
6. One-line summary if files changed; else silent.

**Verification:**
```bash
head -1 docs/trustmybot/architecture/auto/codebase-tree.md
sqlite3 .claude/tmb/trajectory.db "SELECT target, last_seen_sha FROM regen_state;"
```

**Pass:** [ ]

### 7.2 — First code-touching ask, > 25 commits behind

**Prerequisites:** Onboarded; some commits already on dev; `regen_state.last_seen_sha` is more than 25 commits behind HEAD.

**Trigger prompt:**
> `fix the navbar colour`

**Expected:** Bro emits exactly one nudge line BEFORE the pre-scan: `"Architecture docs are N commits behind. Run /tmb refresh-architecture when convenient."` Then proceeds with normal flow 2 chain.

**Pass:** [ ]

### 7.3 — First code-touching ask, ≤ 25 commits behind

**Prerequisites:** Same as 7.2 but `regen_state.last_seen_sha` is within 25 commits.

**Trigger prompt:**
> `fix the navbar colour`

**Expected:** Bro silently invokes `refresh-architecture` with `scope:'incremental'`. No user-facing output for the regen. Then proceeds with normal flow 2 chain.

**Pass:** [ ]

### 7.4 — First-ever session, no `regen_state` rows

**Prerequisites:** Fresh DB (no regen has ever run).

**Trigger prompt:**
> `add a feature`

**Expected:** lazy-regen-check stays silent (no regen attempted; full initial regen could be expensive). Pre-scan proceeds normally.

**Pass:** [ ]

---

## Flow 8 — SWE Retry / Escalation

### 8.1 — Validation fails once → architect retries with feedback

**Hard to deterministically trigger.** Observable when SWE produces output that fails the spec's `## Verification` commands.

**Verification:**
```sql
SELECT attempt_n, verdict, feedback FROM validation_attempts
WHERE task_id=<failing_task> ORDER BY attempt_n;
```

Expect 2 rows: `attempt_n=1, verdict='fail'` then `attempt_n=2, verdict='pass'`.

**Pass:** [ ]

### 8.2 — 3 fails → escalation to Human

Set the `success_criteria` deliberately impossible (manual setup) so SWE will fail 3 times.

**Expected:**
- 3 rows in `validation_attempts` all with `verdict='fail'`.
- `tasks.status = 'escalated'`.
- `discussion_append(kind='note', body=<blocker>)` appended.
- Bro surfaces to Human: "this task hit 3 fails — split / change approach / abandon?"

**Pass:** [ ]

---

## Flow 9 — Roundtable

This flow has **four distinct corners** depending on whether the trigger is explicit/implicit and whether enough planning agents exist.

### 9.1 — Explicit magic word, ≥2 planners present

**Prerequisites:** `.claude/agents/` contains `architect.md`, `ceo.md`, `cto.md` (or any combination ≥ 2 planners; SWE always excluded).

**Trigger prompt:**
> `let's do a roundtable on whether to adopt OAuth or stay with session cookies`

**Expected behavior:**
1. Bro recognizes "roundtable" magic word + topic.
2. Routes to architect; architect invokes `roundtable` skill.
3. Skill globs `.claude/agents/`, picks 2-4 best-matching participants by frontmatter description (excluding SWE).
4. Spawns participants in **parallel** (multiple `Task` calls in one message).
5. Each participant returns a position + reasoning.
6. Architect synthesizes XML output: convergence + tensions + recommendation.
7. `ledger_log(event_type='roundtable_summary', topic=..., participants=..., recommendation=...)`.
8. Invokes `roundtable-cleanup` skill.

**Verification:**
```sql
SELECT event_type, summary FROM ledger
WHERE event_type='roundtable_summary' ORDER BY id DESC LIMIT 1;
```

**Pass:** [ ]

### 9.2 — Explicit magic word, only `architect` present

**Prerequisites:** Fresh project with only the four shipped agents (gatekeeper, architect, swe, pr-reviewer); no domain agents.

**Trigger prompt:**
> `let's do a roundtable on whether to adopt OAuth or stay with session cookies`

**Expected behavior:**
1. Bro / architect recognizes roundtable request.
2. Skill checks: only `architect` is a planner (SWE always excluded; pr-reviewer reviews code, not strategy).
3. Skill **escalates back**: "Roundtable needs ≥2 planning voices. Currently only architect is available. Want me to create additional planners (e.g., `ceo`, `cto`)?"
4. Routes via `agent-creator` flow if user says yes; otherwise architect proceeds solo.

**Pass:** [ ]

### 9.3 — Implicit cross-domain question, ≥2 planners present

**Prerequisites:** `.claude/agents/` contains `ceo.md` + `cto.md` + `architect.md` already (created via flow 4 earlier).

**Trigger prompt** (no magic word — architect must DETECT cross-domain):
> `should we ship our beta to enterprise customers next quarter or wait until we have SSO?`

**Expected behavior:**
1. Bro routes to architect (could be ceo since it's strategic — gatekeeper may ask the framing question).
2. Architect detects: this isn't a single-domain decision (touches product timing, technical readiness, business risk).
3. Architect invokes `roundtable` skill **without explicit user request**.
4. Skill picks ceo + cto (+ architect as convener).
5. Same flow as 9.1 from there.

**Pass:** [ ]

**Notes:** This is the trickiest scenario — architect's judgment of "this is cross-domain" is fuzzy. May fail if architect's prompt doesn't clearly direct it to invoke roundtable for cross-domain calls. If it fails: file as a follow-up issue; architect prompt may need a clearer "when to invoke roundtable" rule.

### 9.4 — Implicit cross-domain question, only `architect` present

**Prerequisites:** Only the four shipped agents; no domain planners.

**Trigger prompt:**
> `should we ship our beta to enterprise customers next quarter or wait until we have SSO?`

**Expected behavior:**
1. Bro routes to architect (no ceo/cto to route to).
2. Architect recognizes the question is cross-domain (product + tech + risk) and beyond its scope.
3. Architect surfaces: "This question spans product + tech + risk decisions — I'd want a `ceo` and `cto` voice on it. Want me to create them via agent-creator first, then run a roundtable?"
4. If user says yes → flow 4 (agent-creator) for each missing role → flow 9.3 from there.
5. If user says no → architect makes a best-effort solo recommendation, flagging the dimensions it couldn't credibly evaluate.

**Pass:** [ ]

---

## Reset / cleanup between scenarios

```bash
# In the scratch project root:
rm -rf .claude/tmb/                         # wipe trajectory DB
rm -rf .claude/agents/                      # wipe user-created domain agents
rm -rf docs/trustmybot/                     # wipe generated + manual architecture docs
git checkout -- .                           # revert any SWE-committed changes
```

## Filing observed deviations

When a scenario's expected behavior doesn't match actual output:

1. Note the scenario ID (e.g., 9.3) and what diverged.
2. Capture the relevant agent output as a code block.
3. File an issue tagged `dogfood` with the title `dogfood: <scenario ID> — <one-line deviation>`.
4. Reference this file: `See SCENARIOS.md#<scenario-anchor>`.

## Related

- [`FLOWS.md`](FLOWS.md) — the flowcharts each scenario verifies
- [`docs/local-testing.md`](../local-testing.md) — how to launch a scratch session
- [`tests/run-all.sh`](../../tests/run-all.sh) — automated suites that run before any dogfood test
