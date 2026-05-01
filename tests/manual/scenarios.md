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
