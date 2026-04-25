---
name: tmb_bootstrap
description: Recovery skill — copies plugin templates (swe + pr-reviewer + default skills) into a project that has identity set but is missing the agent files. Normal first-run case is handled inline by `tmb_first-run-onboarding`; this skill exists for the rare edge case (e.g. user hand-deleted .claude/agents/ between sessions).
agent: bro
allowed-tools: Read, Write, Bash, AskUserQuestion, mcp__plugin_tmb_trajectory-server__ledger_log
---

# tmb_bootstrap (recovery skill)

## When invoked

Bro detects: identity is set (onboarding ran in a prior session) BUT `<project>/.claude/agents/swe.md` is missing. This means the project's templates were deleted, never copied, or the project moved location. Bootstrap restores them.

**Normal first-run does NOT use this skill** — `tmb_first-run-onboarding` handles the template copy inline as part of its Step 5. This recovery skill exists so bro doesn't silently fail when the templates vanish post-onboarding.

If `<project>/.claude/agents/swe.md` exists, this skill is a no-op.

## Hold-and-resume

Any code-touching ask received during recovery is **held** until templates are restored.

## Step 1 — Confirm with Human

```
AskUserQuestion({
  questions: [{
    question: "TMB workflow agents (swe, pr-reviewer) are missing from this project's .claude/agents/. Restore them from plugin templates?",
    header: "Recover",
    multiSelect: false,
    options: [
      { label: "Yes, restore (Recommended)", description: "Copies templates/agents/{swe,pr-reviewer}.md and templates/skills/* into the project verbatim. Skips files that already exist." },
      { label: "Skip — I'll author my own", description: "Plugin proceeds. Code-touching asks will block until you author the missing files yourself." },
    ]
  }]
})
```

## Step 2 — Handle answer

| Selection | Action |
|---|---|
| "Yes, restore" | Copy templates as in Step 3. |
| "Skip" | `ledger_log(event_type='tmb_bootstrap_skipped', summary='Recovery declined')`. End. |
| Other (free-text) | Parse and partial-copy if interpretable; re-ask if not. |

## Step 3 — Copy templates verbatim

Same source/dest list as `tmb_first-run-onboarding` Step 5:

```
${CLAUDE_PLUGIN_ROOT}/templates/agents/swe.md          → <project>/.claude/agents/swe.md
${CLAUDE_PLUGIN_ROOT}/templates/agents/pr-reviewer.md  → <project>/.claude/agents/pr-reviewer.md

${CLAUDE_PLUGIN_ROOT}/templates/skills/<name>/SKILL.md → <project>/.claude/skills/<name>/SKILL.md
   (for: swe-checklist, review-protocol, review-findings, code-quality,
         docs-conventions, git-conventions, naming-conventions)
```

**Verbatim copy** — do not transform body, frontmatter, line endings.

**Skip any file that already exists** — recovery is additive only; never overwrites a project's customized file.

## Step 4 — Log + report

```
ledger_log(
  agent='bro',
  event_type='tmb_bootstrap_complete',
  summary='Recovery: restored N missing agent + skill templates.',
)
```

Tell the Human in one line which files landed, then return control. Bro proceeds with the held ask.

## Hard rules

- **Verbatim copy only.** No body edits.
- **Never overwrite.** Pre-existing files are skipped; recovery is additive.
- **Plugin is read-only at runtime.** Never write into `${CLAUDE_PLUGIN_ROOT}/`.
- **Approval is non-negotiable.** Recovery copies nothing without an explicit Yes.
