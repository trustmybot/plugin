---
name: tmb_bootstrap
description: First-time TMB setup in a project — copy plugin templates (swe + pr-reviewer + default skills) into the project's .claude/agents/ and .claude/skills/. Triggered from bro's first-action chain when .claude/agents/swe.md is absent. Always asks Human approval first.
agent: bro
allowed-tools: Read, Write, Bash, AskUserQuestion, mcp__plugin_tmb_trajectory-server__ledger_log
---

# tmb_bootstrap

## When invoked

Bro's first-action chain detects that `<project>/.claude/agents/swe.md` does not exist. The plugin needs swe + pr-reviewer (at minimum) to do any code work. This skill copies the templates with explicit Human approval.

Onboarding (`tmb_first-run-onboarding`) must have already completed before this skill runs — bootstrap reads `${CLAUDE_PLUGIN_ROOT}` to find templates and writes to the project's `.claude/`. Both pre-conditions: the project DB exists, the bootstrap directory writes won't collide.

If the project already has `.claude/agents/swe.md`, this skill is a no-op — bro skips it.

## Hold-and-resume

Any code-touching ask received during bootstrap is **held**. Onboarding's hold-and-resume pattern repeats here. Read-only asks are answered inline; bootstrap resumes immediately after.

## Step 0 — confirm scope

Read the templates list (deterministic, no Bash needed):

```
templates/agents/swe.md
templates/agents/pr-reviewer.md
templates/skills/swe-checklist/SKILL.md
templates/skills/review-protocol/SKILL.md
templates/skills/review-findings/SKILL.md
templates/skills/code-quality/SKILL.md
templates/skills/docs-conventions/SKILL.md
templates/skills/git-conventions/SKILL.md
templates/skills/naming-conventions/SKILL.md
```

Template root is `${CLAUDE_PLUGIN_ROOT}/templates/`. Resolve via `Read` (not Bash) once you know the path; plugin contents are read-only.

## Step 1 — Ask Human approval

Render exactly this AskUserQuestion. Do NOT add improvised options.

```
AskUserQuestion({
  questions: [{
    question: "TMB needs swe + pr-reviewer in this project to do any code work. Copy the default templates now?",
    header: "Setup",
    multiSelect: false,
    options: [
      {
        label: "Yes, copy defaults (Recommended)",
        description: "Copies templates/agents/{swe,pr-reviewer}.md to .claude/agents/ and templates/skills/* to .claude/skills/. Verbatim copy — never edits the body of any file.",
      },
      {
        label: "Skip — I'll author my own",
        description: "Plugin proceeds. Code-touching asks will block until you author .claude/agents/swe.md and .claude/agents/pr-reviewer.md yourself.",
      },
      // No synonym-of-Other placeholder. AskUserQuestion auto-renders Other for free-text reply (e.g. "copy only swe, not pr-reviewer").
    ]
  }]
})
```

## Step 2 — Handle answer

| Selection | Action |
|---|---|
| "Yes, copy defaults (Recommended)" | Proceed to Step 3 (copy all templates). |
| "Skip — I'll author my own" | Log the decision via `ledger_log(event_type='tmb_bootstrap_skipped')`. Inform the Human that code-touching asks will block until they author the files. End the skill. |
| Other free-text (custom selection, e.g. "skip pr-reviewer for now") | Parse the request. If interpretable, proceed with a partial copy. If ambiguous, re-ask the form with the partial spec laid out. |

## Step 3 — Copy templates

Verbatim copy. Use `Read` to read each template, then `Write` to land it at the project path. **Do not transform, normalize, or edit the body.** That includes line endings, trailing newlines, frontmatter — pass through exactly.

```
Source: ${CLAUDE_PLUGIN_ROOT}/templates/agents/swe.md
Dest:   <project>/.claude/agents/swe.md

Source: ${CLAUDE_PLUGIN_ROOT}/templates/agents/pr-reviewer.md
Dest:   <project>/.claude/agents/pr-reviewer.md

Source: ${CLAUDE_PLUGIN_ROOT}/templates/skills/<name>/SKILL.md
Dest:   <project>/.claude/skills/<name>/SKILL.md
```

(Repeat for each template skill: swe-checklist, review-protocol, review-findings, code-quality, docs-conventions, git-conventions, naming-conventions.)

If a destination file already exists for any of them, **do not overwrite**. Report which files were skipped due to pre-existing content. The Human resolves: keep existing, or delete and re-bootstrap.

## Step 4 — Log + report

After all writes succeed:

```
ledger_log(
  agent='bro',
  event_type='tmb_bootstrap_complete',
  summary='Copied 2 agent templates + 7 skill templates from plugin to <project>/.claude/.',
  content_json='{"agents": ["swe", "pr-reviewer"], "skills": [...]}',
)
```

Tell the Human in one line which files landed, then return control. Bro proceeds with the held code-touching ask (if any).

## Hard rules

- **Verbatim copy only.** Never edit the body of a copied template. Project customization happens via `tmb_skill-creator` extending the agent's `skills:` array, never by editing the agent body.
- **Never overwrite existing project files.** If `<project>/.claude/agents/swe.md` exists, skip + report. Human owns conflict resolution.
- **Plugin is read-only at runtime.** Never write into `${CLAUDE_PLUGIN_ROOT}/templates/`.
- **Approval is non-negotiable.** Bootstrap copies nothing without an explicit Yes from the AskUserQuestion form.
- **Scope is fixed.** Bootstrap copies swe + pr-reviewer + the default skills bag. Consultants (architect/cto/ceo/pm) are NOT copied here — those copy on first request via `tmb_agent-creator`.
