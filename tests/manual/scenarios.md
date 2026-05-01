# Layer 5 — Manual Dogfood Checklist

> **What this is:** a tight, ~10-item checklist of the things **only a human walking through Claude Code can verify**. L0–L4 cover the rest structurally (Docker install-smoke, lint, MCP unit + integration, workflow-simulation trajectory tests).
>
> **When you must run this:**
> - **Before promoting a release candidate to stable** (the canonical RC validation step — see [`CONTRIBUTING.md` § Release ritual](../../CONTRIBUTING.md#release-ritual) Path 2).
> - **Before tagging any release** ≥ v0.2.0. The release script (`scripts/release.sh`) refuses to tag until `MANUAL_DOGFOOD_PASSED=v<X.Y.Z>` matches the version being released.
>
> **Hotfixes** can bypass via `BYPASS_DOGFOOD=1`, with the bypass reason documented in the release commit. Acceptable when the change demonstrably can't affect Claude-side behavior (doc-only releases, CI-only fixes).

---

## Setup

Two test paths — see [`setup.md`](./setup.md) for the full instructions, including verify commands and reset procedures.

| Path | Command | Use when |
|---|---|---|
| **A — Local dev** | `claude --plugin-dir <plugin-clone>` | Active development; fast iteration; hot reload via `/reload-plugins`. |
| **B — Marketplace RC** | `/plugin install tmb@trustmybot-rc` (in CC) | **REQUIRED for RC validation** before promoting to stable. Exercises CC's actual install lifecycle. |

**For RC validation: use Path B.** Path A bypasses the install lifecycle that broke v0.2.0 + v0.3.0 — it can't catch that bug class. Path B is the only manual path that does.

For each scenario below: set up a fresh scratch project per [`setup.md`](./setup.md), run the trigger, verify against the expected behavior, then reset (`rm -rf .claude/tmb`) before the next scenario.

---

## The checklist

### ① Trigger word activation

**Type:** `hey` (no "bro")
**Expected:** regular Claude Code response, no plugin involvement, no MCP call.

**Type:** `@bro hello`
**Expected:** Claude announces "Entering bro mode" before doing anything else. Onboarding kicks off (3 questions: name, branching model, PR target).

✅ Pass criteria: trigger detection + onboarding launches **only** on `@bro`.

---

### ② AskUserQuestion radio UI rendering

During onboarding, the branching-model question is supposed to use Claude Code's radio-form UI (not a plain text question).

✅ Pass criteria: you see a proper form with selectable options (github-flow / gitflow / custom), not "type 1, 2, or 3."

---

### ③ No template copy after onboarding (v0.3.0+)

After answering the 3 onboarding questions:

```bash
ls .claude/agents/ 2>&1   # should NOT exist OR be empty
ls .claude/skills/ 2>&1   # should NOT exist OR be empty
```

✅ Pass criteria: **`.claude/agents/` and `.claude/skills/` are EMPTY (or don't exist).** swe + pr-reviewer + 7 default skills serve from the plugin globally. The trajectory DB at `.claude/<plugin-name>/trajectory.db` (`.claude/tmb/` for stable, `.claude/tmb-rc/` for the RC channel) SHOULD exist with identity + config rows. Onboarding only writes to MCP, never to the filesystem.

---

### ④ Subagent prompt precedence

Ask: `@bro write a python file that prints hello`

When SWE spawns, the SWE subagent uses **its own template's prompt** (terse, task-focused), not bro's persona prompt. Test by inspecting the spawn:

✅ Pass criteria: SWE doesn't say "Trust me bro" or "Entering bro mode." It just executes the task.

---

### ⑤ Worktree isolation

Same task as ④. After SWE returns:

```bash
git worktree list  # should show a worktree under .claude/worktrees/ or similar
```

✅ Pass criteria: SWE worked in an isolated worktree, NOT directly on the main branch tree.

---

### ⑥ Bro task gate (verification before close)

After SWE completes ④, bro should:
1. Re-run the spec's `## Verification` commands.
2. Sanity-check the diff against the spec's `## Files`.
3. Confirm each `## Success Criteria` bullet.
4. THEN flip the task to `closed`.

✅ Pass criteria: bro's response includes evidence of running the verification (you see the command output in the conversation), not a bare "task closed."

---

### ⑦ Push gate fires (pr-reviewer is global, no copy)

After ④–⑥, set up a remote and try to push:

```bash
git remote add origin <a-bare-repo-or-fake>
git push -u origin main 2>&1
```

Should be **blocked** by the pre-push hook with a message asking you to run `@bro review before push`.

Run that:

```bash
@bro review before push
```

✅ Pass criteria:
- `.claude/agents/pr-reviewer.md` does **NOT** appear — pr-reviewer ships globally with the plugin (v0.3.0+). CC dispatches by name to the global plugin file.
- pr-reviewer is spawned, runs review, signs off via MCP.
- Re-running `git push` succeeds.

---

### ⑧ Resume after kill

Mid-task (during ④), kill Claude Code (`Ctrl-C`). Restart, re-enter the project. Type:

```
@bro
```

✅ Pass criteria: bro detects the in-progress issue/task via `issue_resume`, summarizes where it left off, and offers to continue. **Not** "what would you like me to do?" (that would mean amnesia).

---

### ⑨ Bro tone + catchphrase discipline

Across all scenarios:

✅ Pass criteria:
- Tone is terse and in-character (not corporate AI-fluff).
- "Trust me bro, it works" only appears AFTER a successful task close + push gate, never on a fail / retry / unverified state.
- No padding, no narration of what bro is about to do — bro just does it and reports.

---

### S-22: Agent collision dialog (TRU-72 / #22)

Validates the `tmb_agent-creator` collision flow.

**Setup:**
1. Fresh scratch project (or any project without `.claude/agents/legal-reviewer.md`).
2. Hand-create `<project>/.claude/agents/legal-reviewer.md` with minimal content + no `tmb_owner` field:
   ```yaml
   ---
   name: legal-reviewer
   description: User-authored legal reviewer (test fixture)
   ---
   ```

**Run:**
- In CC, ask `@bro create a legal-reviewer agent` (or otherwise trigger `tmb_agent-creator` with the same name).

**Expect:**
- bro detects the collision, shows a unified diff, calls AskUserQuestion with 3 options (Skip / Adopt+manage / Overwrite).
- **Pick Skip** → file unchanged, no `tmb_owner` added; ledger has `tmb_agent_collision_skipped` event.
- **Pick Adopt + manage** → file content unchanged BUT frontmatter now has `tmb_owner: user-adopted`; ledger has `tmb_agent_adopted` event.
- **Pick Overwrite** → file content replaced with template/from-scratch; frontmatter has `tmb_owner: bro`; ledger has `tmb_agent_overwritten` event.

**Headless variant:** with `TMB_HEADLESS=1`, the same flow halts before any of the three writes.

---

---

### S-24: Roundtable deterministic workflow (#141 / TRU-63)

Validates the full roundtable flow end-to-end: state machine enforcement,
AUQ shape hook, atomic `roundtable_finalize_decisions`, five DB capture
surfaces, and follow-up issue creation.

**Setup:**
1. Fresh scratch project with at least 3 consultant agents under `.claude/agents/`
   (ceo, cto, pm — or trigger `tmb_agent-creator` first).
2. Create a carrier issue via `@bro let's hold a roundtable on <topic>`.

**Run:**
- Ask `@bro hold a roundtable on <topic> — participants: ceo, cto, pm`.

**Expect — Phase 1:**
- `roundtable_create(expected_participants=3)` called at the start;
  server rejects if `expected_participants` is missing or outside 2–5.
- Initial `state='collecting'` returned.

**Expect — Phase 2 (collect):**
- Each participant spawned in parallel (one `Task` per agent).
- After each responds: `discussion_append(kind='analysis')` + `roundtable_vote`.
- After the 3rd distinct non-human vote: server auto-flips `state → awaiting_human`.

**Expect — Phase 4 (AUQ):**
- ONE `AskUserQuestion` with Q1 `multiSelect:true` (agreements) + Q2–Q4 radio
  (disagreements). The `roundtable-auq-shape` hook blocks any other shape while
  `state=awaiting_human` and no human vote is recorded yet.
- Headless variant (`TMB_HEADLESS=1`): bro halts per `tmb_headless-fallback`.

**Expect — Phase 5 (finalize):**
- ONE `roundtable_finalize_decisions(ratified=[...], unratified=[...], resolutions=[...])`
  call. Server writes all discussion + vote rows atomically; sets `ratification_received_at`.
- Attempting `roundtable_close` BEFORE `roundtable_finalize_decisions` results
  in `precondition_failed` (no human votes yet).

**Expect — Phase 6 (close):**
- `roundtable_close` succeeds only after `roundtable_finalize_decisions` has
  recorded ≥1 human vote.
- `roundtable_summarize` assembles the canonical summary; passed to `ledger_log`.

**Expect — Phase 7 (follow-ups):**
- Second `AskUserQuestion` (multiSelect, one option per ratified agreement).
- `issue_create` per checked item.
- Carrier issue closed if one-shot.

**DB verification (via sqlite3 or MCP):**
```sql
-- State machine columns
SELECT id, topic, state, status, expected_participants, ratification_received_at, closed_at
FROM roundtables WHERE issue_id = <N>;

-- 1. kind='analysis' rows (one per participant)
SELECT author, kind, body FROM discussions WHERE issue_id = <N> AND kind = 'analysis';

-- 2. answer + decision rows (per Human ratification)
SELECT author, kind, body FROM discussions WHERE issue_id = <N> AND kind IN ('answer','decision');

-- 3. roundtable record state
SELECT id, topic, state, status, outcome, closed_at FROM roundtables WHERE issue_id = <N>;

-- 4. vote attribution (participant column)
SELECT participant, vote, rationale FROM roundtable_votes WHERE roundtable_id = <id>;

-- 5. ledger summary
SELECT event_type, summary FROM ledger WHERE issue_id = <N> AND event_type = 'roundtable_summary';
```

All five surfaces must have data; `state='closed'`, `ratification_received_at` non-null.

**Optional local mirror:**
```bash
ls <workspace>/.claude/tmb/roundtables/  # file exists if dir was writable
git -C <plugin-path> status <workspace>/.claude/tmb/roundtables/  # nothing tracked
```

✅ Pass criteria:
- `roundtable_create` rejected without `expected_participants`.
- Server auto-flips `state → awaiting_human` after Nth vote.
- AUQ shape hook blocks malformed batches; valid shape passes.
- ONE `roundtable_finalize_decisions` call writes all ratification rows atomically.
- `roundtable_close` before finalize → `precondition_failed`.
- `roundtable_close` after finalize → `state='closed'`.
- All five DB surfaces populated.
- AUQ rendered as checkbox (agreements) + radio (disagreements).
- Dissent explicitly in `kind='decision'` row.
- Follow-up issues created for ratified actions.

---

## S-25: /roundtable slash command end-to-end

1. User types `/roundtable Should we adopt feature flags?`
2. Verify: tmb_roundtable skill invokes with topic
3. Skill runs Phase 1-7 per the deterministic flow
4. Verify all 5 DB capture surfaces populated
5. Verify carrier issue closes (one-shot pattern)

## S-25b: /roundtable (no args) — prompts for topic

1. User types `/roundtable` with no arguments
2. Verify: Claude Code prompts for the topic via AskUserQuestion
3. User provides topic; skill invokes with the supplied topic
4. Skill runs Phase 1-7 per the deterministic flow
5. Verify all 5 DB capture surfaces populated

---

## S-26: /monitor end-to-end — 5 mocked comments → 3 tasks → 1 arch-impact → SWE dispatch → arch regen → push gate

**Setup:**
1. Fresh scratch project with TMB plugin active.
2. Create a carrier issue: `@bro let's work on feature X`.
3. Create a task and branch off it so `tasks.branch_id` maps to the current branch.
4. Patch `PATH` to inject mock `gh` and `glab` binaries that return a fixed 5-comment payload:
   - Comment A (human): "This function should be extracted into a helper." (file: `src/utils.ts:42`)
   - Comment B (human): "src/utils.ts line 55 also has the same issue." (file: `src/utils.ts:55`)
   - Comment C (human): "The schema needs a new index for performance." (file: `mcp/trajectory-server/src/schema.sql`)
   - Comment D (bot, dependabot[bot]): "Bump lodash to 4.17.21."
   - Comment E (human): "LGTM overall, nice work!"

**Run:**
```
/monitor 42
```
(or `/monitor` with the current branch having an open PR)

**Expect — Phase 3 (fetch):**
- `pr_comments_get` returns all 5 comments.
- `remote_kind` matches the backend (gh or glab).

**Expect — Phase 5 (classify):**
- Comment D filtered as `author_kind='bot'`.
- Comment E filtered as informational (`LGTM` pattern).
- 3 comments remain task-worthy: A, B, C.

**Expect — Phase 6 (group):**
- Comments A + B grouped into one task (same file: `src/utils.ts`).
- Comment C becomes a separate task.
- 2 tasks total (or 3 if the model didn't group A+B).

**Expect — Phase 7 (arch-impact):**
- The `schema.sql` task is flagged `(arch-impact)`.

**Expect — Phase 8 (AUQ):**
- AskUserQuestion renders with `multiSelect:true`.
- Options include the 2 (or 3) tasks; the schema task has `(arch-impact)` suffix.
- Select all tasks.

**Expect — Phase 9 (dispatch):**
- `task_create_batch` called once per task.
- SWE spawned for each.
- After SWE completes the arch-impact task: `tmb_refresh-architecture` is invoked before moving to the next task or push gate.

**Expect — Phase 10 (state update):**
```sql
SELECT pr_number, comments_processed, tasks_created, last_comment_id
FROM pr_review_runs
WHERE pr_number = 42;
```
- `comments_processed` = 5 (all fetched, including bot and informational).
- `tasks_created` = 2 or 3 (matching dispatched count).
- `last_comment_id` is non-null.

**DB verification:**
```sql
-- pr_review_runs state
SELECT * FROM pr_review_runs WHERE pr_number = 42;

-- discussion entries from Phase 4
SELECT author, kind, body FROM discussions
WHERE kind = 'note' AND body LIKE '[PR #42%'
ORDER BY id;

-- tasks created
SELECT title, status FROM tasks ORDER BY id DESC LIMIT 5;
```

**Push gate:**
After all SWE tasks close, run `git push` — verify push gate requires pr-reviewer sign-off per the normal `tmb_push-gate` flow.

✅ Pass criteria:
- 5 comments fetched, 3 remain after bot + informational filter.
- Tasks grouped by file (A+B merged if grouping works).
- AUQ shows tasks with `(arch-impact)` suffix on the schema task.
- `tmb_refresh-architecture` invoked after the arch-impact task's SWE returns.
- `pr_review_runs` row has correct counts.
- Discussion entries created for all 5 fetched comments.

---

## S-27: Onboarding issue-sync opt-in end-to-end

Validates the `tmb_reonboard` issue-sync opt-in phase added in #147.

**Setup:**
1. Fresh scratch project with TMB plugin active.
2. Authenticate `glab` only (`gh auth logout` if needed), so the phase detects exactly one backend.
3. Ensure `config_get('issue_sync')` returns `'off'` (the default).

**Run:**
- Trigger `tmb_reonboard` (e.g. `@bro re-onboard`).

**Expect — Issue-sync opt-in phase:**
- Skill runs `gh auth status` (exits non-zero) and `glab auth status` (exits 0).
- Because only GitLab is authenticated, exactly two options appear:
  - "Mirror to GitLab"
  - "Skip — keep local-only"
- Header is "Issue sync"; text mentions "Detected: glab".
- User picks **"Mirror to GitLab"**.
- `config_set('issue_sync', 'glab')` is called.

**Verify state after:**
```bash
# config_get via MCP or sqlite3:
sqlite3 .claude/tmb/trajectory.db "SELECT value FROM config WHERE key='issue_sync';"
# → glab
```

**Verify log entries after issue_create:**
1. Create a new issue: `@bro create issue: test blast-radius`.
2. Inspect the log:
```bash
tail -5 ~/.claude/tmb/logs/issue-sync.log | jq 'select(.kind == "issue_sync_active")'
```
Expected: an entry with `kind=issue_sync_active`, `backend=glab`, and the new issue's id + title.

**Headless variant:** with `TMB_HEADLESS=1`, skip the AUQ; `issue_sync` remains `'off'` — no config write occurs.

✅ Pass criteria:
- `tmb_reonboard` detects `glab` authenticated; shows two-option AUQ (Mirror to GitLab / Skip).
- After picking "Mirror to GitLab": `config_get('issue_sync')` returns `'glab'`.
- Subsequent `issue_create` triggers `syncIssueCreate`; `issue_sync_active` entry appears in `~/.claude/tmb/logs/issue-sync.log`.
- Headless mode leaves `issue_sync='off'` unchanged.

---

## How to sign off

Once every checkbox passes for the version you're about to release:

```bash
export MANUAL_DOGFOOD_PASSED=v0.2.0
bash scripts/release.sh
```

`release.sh` checks `$MANUAL_DOGFOOD_PASSED` matches `plugin.json` version. If not set or mismatched, it refuses to tag.

If something fails, **do not tag**. File an issue, fix it, re-run the affected checklist item, then sign off.

## Why this is the only manual layer

L0–L4 cover everything that can be verified without Claude Code in the loop:

- **L0** Docker: install-smoke (cold-start MCP boot).
- **L1** lint: structural integrity of every shipped artifact.
- **L2** unit: per-handler / per-hook behavior.
- **L3** integration: real MCP server + real DB + real hooks cooperating.
- **L4** workflow-sim: every FLOWS.md flow as a scripted MCP-tool sequence.

What L5 catches is the *Claude-side* behavior — trigger detection, AskUserQuestion rendering, agent spawn isolation, subagent prompt precedence, tone, real worktree creation. None of those have an MCP surface to test.

Keep this checklist tight. If you find yourself adding a 30-line scenario, ask: can it be moved to L4 by simulating the MCP-tool sequence? Almost always yes.
