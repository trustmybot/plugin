---
name: tmb_agent-creator
description: Resolve a consultant ask: list the registry via agent_list, then either spawn an existing agent via Agent, copy a template + register + spawn, or create from-scratch + register + spawn. Loads on any named-role consult — e.g. "get the architect's read on X", "what does the cto think", "have the legal-reviewer check Y". Also fires on un-named expertise asks — "I need a tech-strategy review on X", "what's the right architecture trade-off here", "who should weigh in on this decision", "we're hitting [problem] — should we [option-A] or [option-B]".
allowed-tools: Read, Write, Glob, Grep, AskUserQuestion, mcp__plugin_tmb_trajectory-server__audit_log, mcp__plugin_tmb_trajectory-server__agent_list, mcp__plugin_tmb_trajectory-server__agent_register
---

# Agent Creator

Resolve a consultant ask by querying the registry, then routing to one of three branches. User-created agents default to **consultant** scope (server-rejected for non-bro/non-swe/non-pr-reviewer callers: `task_create_batch`, `task_update_status`, `validation_record`, `issue_create`, `issue_close`).

The bundled `scripts/prompt-author-lint.sh` (regex scan for negations + noise citations) runs as a Bash step in Branch C step 4 — bro doesn't read it directly.

## Resolution algorithm

1. Call `agent_list()` to get all known agents from the registry.
2. Resolve the target agent name from the user's phrasing.
3. **Branch A — Local file exists:** if `<project>/.claude/agents/<name>.md` exists → ensure an open issue exists for the consult (if none, `issue_create(agent='bro', objective='<role> consult: <one-line context>', description='<the user question>')`); spawn via `Agent` with the spawn prompt INCLUDING `issue_id=<N>` and a specific question. DONE.
4. **Branch B — Template in registry:** else if the registry shows `scope='template'` for the resolved name → the agent exists only as a plugin template, not yet instantiated for this project. REQUIRED sequence: (a) `Read` the template at `${CLAUDE_PLUGIN_ROOT}/templates/agents/<name>.md` and `Write` it to `<project>/.claude/agents/<name>.md` verbatim; (b) call `agent_register(agent='bro', name, kind='consultant', scope='project-local', file_path='.claude/agents/<name>.md')`; (c) call `audit_log(agent='bro', from_node='bro', event_type='tmb_agent_created', ...)`; (d) if the user's prompt is a consultant *question* (not just `/tmb:agent-create`), scope an issue per Branch A then spawn via `Agent` with `issue_id=<N>` + the question. If the prompt was bare `/tmb:agent-create <name>` (no follow-on question), skip the spawn — agent is ready for next-turn use. Steps (a)–(c) are mandatory. DONE.
5. **Branch C — From-scratch:** else → run the from-scratch ceremony below; call `agent_register(...)` after writing; same Branch A/B conditional spawn rule based on whether a question was provided. DONE.

**Spawn-prompt template (Branches A/B/C when spawning):**
```
consultant: analysis-only
issue_id: <N>
question: <verbatim user question>
```
Consultants are server-rejected from `issue_create` so bro must always own issue scoping.

`tmb_owner` lives only in the `.md` frontmatter; the agents table carries no copy.

### Branch B — Template-copy detail

In headless mode (`TMB_HEADLESS=1`): **skip the AUQ and write the file directly**. Template content is deterministic — reviewed at plugin release — so the auto-approve is safe. Render the AUQ only when a Human is in the loop.

1. **Show + ask** (interactive only). `Read` the template at `${CLAUDE_PLUGIN_ROOT}/templates/agents/<name>.md` (present it verbatim). Present in a fenced code block, ask:
   > Copy `${CLAUDE_PLUGIN_ROOT}/templates/agents/<name>.md` to `<project>/.claude/agents/<name>.md` verbatim? Project-specific behavior gets attached later via `tmb_skill-creator`. (yes/no)
2. **Copy on approval** (or unconditionally in headless). `Write` the template content unmodified to `<project>/.claude/agents/<name>.md`. If the destination exists, switch to the collision flow (§"Collision dialog" below).
3. **Register + log.** Call `agent_register(name, kind='consultant', scope='project-local', file_path='.claude/agents/<name>.md')`. If there's no open issue, first run `issue_create(agent='bro', objective='<role-name> agent created', description='Free-floating consult triggered creation of the <role> agent for <one-line context>.')` to scope the audit. Then `audit_log(agent='bro', from_node='bro', issue_id=<that_id>, event_type='tmb_agent_created', content_json='{"name":"<name>","mode":"template-copy"}')`. Tell the Human the file landed at `<path>`. See §"Post-create reminder" for the conditional reload hint.

### Branch C — From-scratch detail

1. **Discover the gap** — AskUserQuestion at most 3 questions in one batch:
   1. What role/title should this agent have?
   2. What are its core responsibilities?
   3. Which existing agent is closest, and what gap does the new agent fill?

2. **Read context.** Glob `.claude/agents/` for existing project agents, check for name collision. Glob top-level files (`package.json`, `pyproject.toml`, etc.) for stack/domain.

3. **Draft** by scaffolding from the base template. `Read` the file at `${CLAUDE_PLUGIN_ROOT}/templates/agents/template.md`. Substitute the three placeholders with role-specific values: `<kebab-case>` → the agent name, `<one sentence>` → a one-sentence description of the role and primary capability, `<Role Name>` → the human-readable title. Optionally extend the body with 1–3 role-specific lines after the first paragraph (body cap: 15 lines after frontmatter). Keep all TMB integration contract prose from the base template verbatim — it is not role flavor.

   Field guidance:
   - `name`: kebab-case (e.g. `legal-reviewer`).
   - `tools`: minimum viable. Default is read-only + MCP. Add `Bash` only if the consultant verifies by running commands. Add `Write`/`Edit` only if the consultant produces output files (rare).
   - `skills: []` — empty by default. Bro extends via `tmb_skill-creator` after creation.
   - Body cap enforced by `tests/lint/agent-line-budget.sh` (Lego model: 15 body lines for role templates).

   In headless mode (`TMB_HEADLESS=1`): skip AUQ steps 1 and 5 when a role description is already known from the slash-command argument or prior context. Default to "Consultant. Analysis-only domain expert for `<name>`." with no role-specific body extension. Proceed directly to pre-write lint (step 4) and write.

4. **Pre-write lint.** Run `${CLAUDE_PLUGIN_ROOT}/skills/tmb_agent-creator/scripts/prompt-author-lint.sh <draft-path>`. The script flags two pattern classes:

   **Pink-elephant negations**: start-of-line `Don't`, `Never`, `Do not`; mid-sentence `MUST NOT`, `do not`, `don't`, `never`. Rewrite each as positive (`Don't include emojis` → `Use plain text only`). For load-bearing safety, add `<!-- LOAD-BEARING-SAFETY: <reason> -->` inline.

   **Noise citations**: issue numbers (`#\d+`), memory file paths (`feedback_*.md`, `~/.claude/projects/...`), origin attributions (`caught in`, `prior incident`), decaying dates, PR/MR URLs, migration tombstones (phrases that frame a past state rather than the current one). Strip or rewrite each. Allowed: rule stated inline, cross-refs to other prompt surfaces (`see CLAUDE.md ## <Section>`), MCP-DB references via tool name.

   Surface findings via the approval AUQ; the user picks accept/decline per finding.

5. **Show + ask.** Present the full drafted file in a fenced code block. Ask:
   > Do you want me to create this agent? It will be written to `.claude/agents/<name>.md` and available in future sessions. (yes/no)

6. **Write on approval** with `tmb_owner: bro` in frontmatter.
7. **Register + log.** Call `agent_register(name, kind='consultant', scope='project-local', file_path='.claude/agents/<name>.md')`. Same issue-scoping rule as Branch B step 3 — `issue_create` first if no active issue. Then `audit_log(agent='bro', from_node='bro', issue_id=<I>, event_type='tmb_agent_created', content_json='{"name":"<name>","mode":"from-scratch"}')`. See §"Post-create reminder" for the conditional reload hint.

## Reserved names (refuse)

- `bro` — plugin protocol persona.

Other names — `architect`, `cto`, `ceo`, `pm`, `swe`, `pr-reviewer`, `legal-reviewer`, anything else — are allowed.

## Collision dialog (existing target file)

<!-- LOAD-BEARING-SAFETY: collision dialog is mandatory — silently overwriting user agent files is a hard doctrine violation -->
When `.claude/agents/<name>.md` already exists, show the collision dialog below. Read the existing file and check the `tmb_owner` field:

- `tmb_owner: bro` (plugin-managed) → refuse overwrite by default; show unified diff, ask yes/no.
- `tmb_owner: user-adopted` → same as `bro`; show diff, ask.
- No `tmb_owner` field (user-authored, untouched) → AskUserQuestion with options:
  - **Skip (Recommended)** — keep your file unchanged; abort the skill. Audit `tmb_agent_collision_skipped`.
  - **Adopt + manage** — preserve user's content; insert `tmb_owner: user-adopted` into the frontmatter. Audit `tmb_agent_adopted`.
  - **Overwrite** — replace with the proposed content; `tmb_owner: bro`. Audit `tmb_agent_overwritten`.

In headless mode (AskUserQuestion errors / `TMB_HEADLESS=1`): HALT per the headless-mode section below. All three collision options require explicit Human choice.

## Edge case — code-writing consultant

If the user wants a consultant that writes source code (e.g. `data-pipeline-swe`), warn first:
> This agent will write source code. The plugin's `swe` role already exists for that. Are you sure you want a parallel code-writing consultant? It will need `isolation: worktree` and `Write`/`Edit` tools, which means it bypasses bro's task-spec gating.

If they confirm, add `isolation: worktree` to frontmatter and `Write, Edit` to tools. Otherwise, propose a skill via `tmb_skill-creator` so the existing `swe` gains the new behavior.

## Hard rules

- **Verbatim copy in template-copy mode.** Customization happens via skills, not by editing the agent body.
<!-- LOAD-BEARING-SAFETY: plugin/agents/ is a read-only install path — writes there corrupt the plugin package -->
- **Plugin install is read-only.** Writes go to `<project>/.claude/agents/` only; `plugin/agents/` is off-limits.
- **Approval is non-negotiable** in both modes.
- **Reserved names refused** — `bro` is reserved.
- **Existing files require collision dialog** — see Collision dialog above.

## Post-create reminder

After Branch B or C completes successfully, emit the reload hint **only if** running interactively (REPL — i.e. not `claude -p`). MCP `agent_list` reads from the `agents` DB table (no reload needed) and the new file is on disk for `Agent` to read at spawn time, so the reminder is a contingency, not a required step:

> *Agent landed at `.claude/agents/<name>.md` and registered. If your next `Agent` spawn can't find it, run `/plugin-reload`.*

Skip the reminder entirely in headless / `claude -p` runs — there's no second turn to act on it.

## Headless mode

- **Branch A (local file exists)** → spawn directly, no approval needed.
- **Branch B (template-copy)** → auto-approve the AUQ. Content is deterministic and reviewed at plugin release. Full ceremony still required in this order: (1) write the template file, (2) call `agent_register(...)`, (3) call `audit_log(agent='bro', from_node='bro', event_type='tmb_agent_created', content_json='{"name":"<name>","mode":"template-copy","headless_auto_approved":true}')`, (4) spawn via `Agent`. Skipping steps 2–3 leaves the project-local agent unregistered and unaudited.
- **Branch C (from-scratch)** → auto-proceed when invoked via the slash command (`/tmb:agent-create <name>`) — the slash invocation is itself explicit Human authorization. Skip AUQs (steps 1 + 5), use the default body per Branch C step 3 ("Consultant. Analysis-only domain expert for `<name>`."), run pre-write lint, write, register, audit, spawn. HALT only when invoked via implicit autoload (NL prompt) without sufficient context — that path needs Human disambiguation. On halt: scope an issue via `issue_create`, then `audit_log(agent='bro', from_node='bro', issue_id=<I>, event_type='headless_creator_blocked', ...)`, surface "Cannot create agent from scratch in headless mode without slash command — novel content requires Human review."
