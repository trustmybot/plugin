# Layer 5 — Manual Dogfood Checklist

> **What this is:** a tight, ~10-item checklist of the things **only a human walking through Claude Code can verify**. The previous 785-line version of this file tried to enumerate every workflow path; that's now covered structurally by L0–L4 (Docker install-smoke, lint, MCP unit + integration, workflow-simulation trajectory tests). What remains here is the residue — Claude-side behaviors that have no automated test surface.
>
> **When you must run this:** before tagging any release `v0.2.0` or higher. The release script (`scripts/release.sh`) blocks tagging until you set `MANUAL_DOGFOOD_PASSED=v<X.Y.Z>` in your environment, signed off after walking the checklist below.

---

## Setup

```bash
# Fresh scratch project so no stale .claude/ contaminates the test
mkdir -p /tmp/tmb-dogfood && cd /tmp/tmb-dogfood
git init -q && git config user.email t@t.t && git config user.name T
echo "init" > README.md && git add . && git commit -qm init

# Run Claude Code with the plugin under test loaded
claude --plugin-dir "$HOME/Git/GitHub/TMB/plugin"
```

Reset between scenarios: `rm -rf /tmp/tmb-dogfood && <re-run setup>`.

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

### ③ Silent template copy after onboarding

After answering the 3 onboarding questions:

```bash
ls .claude/agents/   # should contain swe.md (and ONLY swe.md)
ls .claude/skills/   # should contain swe-checklist, code-quality, docs-conventions, git-conventions, naming-conventions
```

✅ Pass criteria: `swe.md` is present. `pr-reviewer.md` is **NOT** present (it's lazy-copied at first push gate). The 5 swe-side default skills are present.

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

### ⑦ Push gate fires + lazy pr-reviewer copy

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
- `.claude/agents/pr-reviewer.md` appears (lazy-copied).
- pr-reviewer is spawned, runs review, signs off via MCP.
- Re-running `git push` succeeds.

---

### ⑧ Direct Mode for trivial fix

Reset (`rm -rf /tmp/tmb-dogfood/.claude/`). Re-onboard. Then:

```
@bro fix typo "recieve" → "receive" in README.md
```

✅ Pass criteria:
- bro responds in **<30s** total (faster than full SWE spawn).
- bro edits the file directly using the `Edit` tool, no SWE spawn.
- A `direct_mode_used` event lands in `ledger`.

---

### ⑨ Resume after kill

Mid-task (during ④), kill Claude Code (`Ctrl-C`). Restart, re-enter the project. Type:

```
@bro
```

✅ Pass criteria: bro detects the in-progress issue/task via `issue_resume`, summarizes where it left off, and offers to continue. **Not** "what would you like me to do?" (that would mean amnesia).

---

### ⑩ Bro tone + catchphrase discipline

Across all scenarios:

✅ Pass criteria:
- Tone is terse and in-character (not corporate AI-fluff).
- "Trust me bro, it works" only appears AFTER a successful task close + push gate, never on a fail / retry / unverified state.
- No padding, no narration of what bro is about to do — bro just does it and reports.

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
