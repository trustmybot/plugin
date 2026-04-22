---
name: seed-project-agents
description: Copy the plugin's domain-role templates (ceo, cto) into the current project's .claude/agents/ directory, and copy the docs/trustmybot/ workflow scaffold into docs/trustmybot/. Run once per project. (Workflow agents — gatekeeper, prompt-engineer, architect, swe, pr-reviewer — ship in plugin/agents/ and do not need seeding.)
disable-model-invocation: true
allowed-tools: Read, Glob, Write, Bash
argument-hint: "[--overwrite] [--dry-run]"
---

# seed-project-agents

## A. Purpose

Seed **domain-role** agent templates into the current project on first activation. Workflow agents (gatekeeper, prompt-engineer, architect, swe, pr-reviewer) ship with the plugin and don't need seeding — they live in the plugin's own `agents/` directory and are always active. Only `ceo` and `cto` are seeded here, because every project has different product direction and tech stack; users are expected to edit them heavily. After seeding, review and edit each file to match your project domain. You can always override a workflow agent by creating same-named `.claude/agents/<name>.md` in your project (local takes precedence over plugin).

## B. Preconditions

1. `$CLAUDE_PLUGIN_ROOT` must be set to the plugin install directory (e.g. `/path/to/plugin`). If unset or empty, escalate — this skill cannot run without it.
2. The current working directory must be a project root. Heuristic: presence of `.git`, `package.json`, `pyproject.toml`, or `Cargo.toml`. If none are found, prompt the user to confirm the directory is the project root before continuing.
3. CWD must NOT be inside `$CLAUDE_PLUGIN_ROOT`. Seeding into the plugin itself is always wrong — refuse and escalate if this condition is detected.

## C. Source and Destination

**Agent templates (domain roles only):**
- **Source:** `${CLAUDE_PLUGIN_ROOT}/templates/agents/{ceo,cto}.md`
- **Destination:** `<cwd>/.claude/agents/<name>.md`

**Workflow scaffold:**
- **Source:** `${CLAUDE_PLUGIN_ROOT}/templates/docs-trustmybot/` (entire directory tree)
- **Destination:** `<cwd>/docs/trustmybot/`

The plugin install directory is read-only from this skill's perspective. Never modify any file under `$CLAUDE_PLUGIN_ROOT`.

## D. Execution Steps

1. **Resolve plugin root.**
   ```bash
   echo "$CLAUDE_PLUGIN_ROOT"
   ```
   If the output is empty, stop and escalate: "CLAUDE_PLUGIN_ROOT is not set. Cannot locate agent templates."

2. **Verify source directory exists.**
   Glob `${CLAUDE_PLUGIN_ROOT}/templates/agents/*.md`. If no files are found, report and abort:
   "Source directory `${CLAUDE_PLUGIN_ROOT}/templates/agents/` is missing or empty. Run the template-seeding tasks first."

3. **Safety check: CWD vs plugin root.**
   If `$PWD` starts with `$CLAUDE_PLUGIN_ROOT`, refuse and escalate:
   "Refusing to seed into the plugin install directory. Change to your project root first."

4. **Ensure destination directory exists.**
   ```bash
   mkdir -p .claude/agents/
   ```
   Do this once before the first Write, only when not in `--dry-run` mode.

5. **For each template file found in step 2:**
   a. Compute destination: `.claude/agents/<basename>` where `<basename>` is the filename only (e.g. `ceo.md`).
   b. Check if destination exists:
      - Destination **exists** + `--overwrite` flag: Write the file, log `overwrote: .claude/agents/<basename>`.
      - Destination **exists** + `--dry-run` flag: log `would overwrite: .claude/agents/<basename>` (no write).
      - Destination **exists**, neither flag: log `skipped (exists): .claude/agents/<basename>` (no write).
      - Destination **does not exist** + `--dry-run` flag: log `would create: .claude/agents/<basename>` (no write).
      - Destination **does not exist**, no dry-run: Write the file, log `created: .claude/agents/<basename>`.

6. **Copy workflow scaffold.**
   a. Glob `${CLAUDE_PLUGIN_ROOT}/templates/docs-trustmybot/**`. If no files are found, report and abort:
      "Source directory `${CLAUDE_PLUGIN_ROOT}/templates/docs-trustmybot/` is missing or empty."
   b. For each file found:
      - Compute destination by replacing the source prefix with `<cwd>/docs/trustmybot/`.
      - Apply the same `--overwrite` / `--dry-run` / skip logic as step 5.
      - Log with prefix `docs/trustmybot/` instead of `.claude/agents/`.
   c. When not in `--dry-run` mode, ensure destination directories exist before writing:
      ```bash
      mkdir -p docs/trustmybot/tasks/
      mkdir -p docs/trustmybot/architecture/auto/
      mkdir -p docs/trustmybot/architecture/manual/decisions/
      ```

7. **Print summary.**
   ```
   seed-project-agents summary:
     created:    N files
     skipped:    M files (already existed)
     overwrote:  K files
   ```

## E. Flags

- `--overwrite` — Replace existing destination files with the template version. Use when you want to reset a file to the plugin default.
- `--dry-run` — Log all intended actions without writing any files. Use to preview what would happen.

When both `--dry-run` and `--overwrite` are passed simultaneously, `--dry-run` takes precedence. Log a notice: "Note: --dry-run takes precedence over --overwrite. No files will be written." Then log `would overwrite` for existing files and `would create` for new files.

## F. Safety Rules

- All Write calls must resolve to a path within `<cwd>/.claude/agents/` or `<cwd>/docs/trustmybot/`. Never write outside these two directories.
- Never modify any file under `$CLAUDE_PLUGIN_ROOT`. The plugin is read-only at runtime.
- If CWD is inside `$CLAUDE_PLUGIN_ROOT`, refuse immediately and escalate (see Preconditions).
- Agent destination paths are always computed as `<basename>` only — never allow path traversal (reject any template filename containing `/` or `..`).
- Workflow scaffold destination paths preserve subdirectory structure relative to `templates/docs-trustmybot/` but must not escape `<cwd>/docs/trustmybot/`.

## G. Verification Checklist

Before reporting success, confirm all of the following are true in the seeded project:

- [ ] `.claude/agents/` contains `ceo.md` and `cto.md` (domain-role templates).
- [ ] `docs/trustmybot/` root files were seeded (e.g. `SPEC-FORMAT.md`, `bro/` scaffold).
- [ ] `docs/trustmybot/architecture/README.md` exists.
- [ ] `docs/trustmybot/architecture/auto/` contains `codebase-tree.md`, `erd.md`, `module-graph.md`, `changelog.md`.
- [ ] `docs/trustmybot/architecture/manual/` contains `data-flow.md`, `infrastructure.md`, `security-model.md`.
- [ ] `docs/trustmybot/architecture/manual/decisions/0001-example.md` exists.

## H. Post-Seed Advice

After seeding completes, suggest the user:

1. Review `.claude/agents/ceo.md` and `.claude/agents/cto.md` — they are placeholder templates, not production-ready agents.
2. Edit each file to match the project domain: update role descriptions, permissions, model preferences, and any domain-specific responsibilities (e.g., medical-device CTO knows IEC 62304, fintech CEO knows SOC 2 deadlines).
3. Remove the placeholder banner from each file once customized.
4. Delete either template the project does not need — for example, delete `cto.md` on a solo-developer project, or delete `ceo.md` when the team has no formal product-direction role.
5. To override any workflow agent (architect, swe, pr-reviewer, gatekeeper, prompt-engineer) for this specific project, create `.claude/agents/<name>.md` in the project root. The local file takes precedence over the plugin-shipped version.
6. Populate `docs/trustmybot/architecture/manual/` with project-specific ADRs and narrative docs. The `auto/` files are regenerated by the TMB engine and should not be edited by hand.
