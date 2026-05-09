---
name: tmb_agent-creator
description: Resolve a consultant ask: list the registry via agent_list, then either spawn an existing agent via Agent, copy a template + register + spawn, or create from-scratch + register + spawn. Loads on any named-role consult — e.g. "get the architect's read on X", "what does the cto think", "have the legal-reviewer check Y".
allowed-tools: Read, Write, Glob, Grep, AskUserQuestion, mcp__plugin_tmb_trajectory-server__audit_log, mcp__plugin_tmb_trajectory-server__agent_list, mcp__plugin_tmb_trajectory-server__agent_register
---

# Agent Creator

Resolve a consultant ask by querying the registry, then routing to one of three branches. User-created agents default to **consultant** scope (server-rejected for non-bro/non-swe/non-pr-reviewer callers: `task_create_batch`, `task_update_status`, `validation_record`, `issue_create`, `issue_close`).

The bundled `scripts/prompt-author-lint.sh` (regex scan for negations + noise citations) runs as a Bash step in Branch C step 4 — bro doesn't read it directly.

## Resolution algorithm

1. Call `agent_list()` to get all known agents from the registry.
2. Resolve the target agent name from the user's phrasing.
3. **Branch A — Local file exists:** if `<project>/.claude/agents/<name>.md` exists → spawn via `Agent`. DONE.
4. **Branch B — Template in registry:** else if the registry shows `scope='template'` for the resolved name → copy `plugin/templates/agents/<name>.md` to `<project>/.claude/agents/<name>.md`; call `agent_register(name, kind='consultant', scope='project-local', file_path='.claude/agents/<name>.md', tmb_owner='bro')`; spawn via `Agent`. DONE.
5. **Branch C — From-scratch:** else → run the from-scratch ceremony below; call `agent_register(...)` after writing; spawn via `Agent`. DONE.

### Branch B — Template-copy detail

In headless mode (`TMB_HEADLESS=1`): **skip the AUQ and write the file directly**. Template content is deterministic — reviewed at plugin release — so the auto-approve is safe. Render the AUQ only when a Human is in the loop.

1. **Show + ask** (interactive only). Read the template via `Read` (do not transform). Present in a fenced code block, ask:
   > Copy `templates/agents/<name>.md` to `.claude/agents/<name>.md` verbatim? Project-specific behavior gets attached later via `tmb_skill-creator`. (yes/no)
2. **Copy on approval** (or unconditionally in headless). Write the template content unmodified. If the destination exists, switch to the collision flow (§"Collision dialog" below).
3. **Register + log.** Call `agent_register(name, kind='consultant', scope='project-local', file_path='.claude/agents/<name>.md', tmb_owner='bro')`. If there's no open issue, first run `issue_create(agent='bro', objective='<role-name> agent created', description='Free-floating consult triggered creation of the <role> agent for <one-line context>.')` to scope the audit. Then `audit_log(issue_id=<that_id>, event_type='tmb_agent_created', content_json='{"name":"<name>","mode":"template-copy"}')`. Tell the Human the file landed at `<path>`.

### Branch C — From-scratch detail

1. **Discover the gap** — AskUserQuestion at most 3 questions in one batch:
   1. What role/title should this agent have?
   2. What are its core responsibilities?
   3. Which existing agent is closest, and what gap does the new agent fill?

2. **Read context.** Glob `.claude/agents/` for existing project agents, check for name collision. Glob top-level files (`package.json`, `pyproject.toml`, etc.) for stack/domain.

3. **Draft** using this frontmatter template (body ≤25 lines; stack-specific content comes from skills attached later via `tmb_skill-creator`):

   ```yaml
   ---
   name: <kebab-case>
   description: <one sentence: role and primary capability>
   tmb_owner: bro
   model: opus                   # default for consultants; sonnet only when role is mechanical / cost-sensitive
   tools: Read, Glob, Grep, Bash, mcp__plugin_tmb_trajectory-server
   skills: []
   ---

   # <Title — Human-Readable Name>

   Your spawn includes `consultant: analysis-only` and a specific question. Reject any spawn missing the marker.

   [2-3 sentences: what this consultant focuses on, what kind of analysis it returns, how it differs from other consultants in the roster.]

   Persist key points via `discussion_append(agent='<name>', kind='analysis')` or `kind='concern'`.

   You decide nothing. Bro summarizes for the Human; the Human decides.

   Server-rejected for you: `task_create_batch`, `task_update_status`, `validation_record`, `issue_create`, `issue_close`.

   Project-specific context comes from skills the project attaches to this agent's `skills:` list. Never edit this file.
   ```

   Field guidance:
   - `name`: kebab-case (e.g. `legal-reviewer`).
   - `tools`: minimum viable. Default is read-only + MCP. Add `Bash` only if the consultant verifies by running commands. Add `Write`/`Edit` only if the consultant produces output files (rare).
   - `skills: []` — empty by default. Bro extends via `tmb_skill-creator` after creation.
   - 30-line cap enforced by `tests/lint/agent-line-budget.sh`.

4. **Pre-write lint.** Run `${CLAUDE_PLUGIN_ROOT}/skills/tmb_agent-creator/scripts/prompt-author-lint.sh <draft-path>`. The script flags two pattern classes:

   **Pink-elephant negations**: start-of-line `Don't`, `Never`, `Do not`; mid-sentence `MUST NOT`, `do not`, `don't`, `never`. Rewrite each as positive (`Don't include emojis` → `Use plain text only`). For load-bearing safety, add `<!-- LOAD-BEARING-SAFETY: <reason> -->` inline.

   **Noise citations**: issue numbers (`#\d+`), memory file paths (`feedback_*.md`, `~/.claude/projects/...`), origin attributions (`caught in`, `prior incident`), decaying dates, PR/MR URLs, tombstones (`previously`, `no longer`, `deprecated` as migration commentary). Strip or rewrite each. Allowed: rule stated inline, cross-refs to other prompt surfaces (`see CLAUDE.md ## <Section>`), MCP-DB references via tool name.

   Surface findings via the approval AUQ; the user picks accept/decline per finding.

5. **Show + ask.** Present the full drafted file in a fenced code block. Ask:
   > Do you want me to create this agent? It will be written to `.claude/agents/<name>.md` and available in future sessions. (yes/no)

6. **Write on approval** with `tmb_owner: bro` in frontmatter.
7. **Register + log.** Call `agent_register(name, kind='consultant', scope='project-local', file_path='.claude/agents/<name>.md', tmb_owner='bro')`. Same issue-scoping rule as Branch B step 3 — `issue_create` first if no active issue. Then `audit_log(issue_id=<I>, event_type='tmb_agent_created', content_json='{"name":"<name>","mode":"from-scratch"}')`.

## Reserved names (refuse)

- `bro` — plugin protocol persona.

Other names — `architect`, `cto`, `ceo`, `pm`, `swe`, `pr-reviewer`, `legal-reviewer`, anything else — are allowed.

## Collision dialog (existing target file)

When `.claude/agents/<name>.md` already exists, never silently overwrite. Read the existing file and check the `tmb_owner` field:

- `tmb_owner: bro` (plugin-managed) → refuse overwrite by default; show unified diff, ask yes/no.
- `tmb_owner: user-adopted` → same as `bro`; show diff, ask.
- No `tmb_owner` field (user-authored, untouched) → AskUserQuestion with options:
  - **Skip (Recommended)** — keep your file unchanged; abort the skill. Audit `tmb_agent_collision_skipped`.
  - **Adopt + manage** — preserve user's content; insert `tmb_owner: user-adopted` into the frontmatter. Audit `tmb_agent_adopted`.
  - **Overwrite** — replace with the proposed content; `tmb_owner: bro`. Audit `tmb_agent_overwritten`.

In headless mode (AskUserQuestion errors / `TMB_HEADLESS=1`): HALT per the headless-mode section below. Never silently choose any of the three.

## Edge case — code-writing consultant

If the user wants a consultant that writes source code (e.g. `data-pipeline-swe`), warn first:
> This agent will write source code. The plugin's `swe` role already exists for that. Are you sure you want a parallel code-writing consultant? It will need `isolation: worktree` and `Write`/`Edit` tools, which means it bypasses bro's task-spec gating.

If they confirm, add `isolation: worktree` to frontmatter and `Write, Edit` to tools. Otherwise, propose a skill via `tmb_skill-creator` so the existing `swe` gains the new behavior.

## Hard rules

- **Verbatim copy in template-copy mode.** Customization happens via skills, not by editing the agent body.
- **Plugin install is read-only.** Never write to `plugin/agents/`.
- **Approval is non-negotiable** in both modes.
- **Reserved names refused** — `bro` is reserved.
- **Existing files never overwritten silently** — see Collision dialog above.

## Headless mode

- **Branch A (local file exists)** → spawn directly, no approval needed.
- **Branch B (template-copy)** → auto-approve. Content is deterministic and reviewed at plugin release. Write the template, register, log `tmb_agent_created` (note `headless_auto_approved` in summary).
- **Branch C (from-scratch)** → HALT. Novel content needs Human review. Scope the audit first via `issue_create` (per the §"Register + log" pattern in Branch C step 7), then `audit_log(event_type='headless_creator_blocked', ...)`. Surface: "Cannot create agent from scratch in headless mode — novel content requires Human review."
