---
name: seed-project-agents
description: Copy the plugin's project-placeholder agent templates (ceo, cto, architect, swe, pr-reviewer) into the current project's .claude/agents/ directory, and copy the docs/trustmybot/ workflow scaffold into docs/trustmybot/. Run once per project.
disable-model-invocation: true
allowed-tools: Read, Glob, Write, Bash
argument-hint: "[--overwrite] [--dry-run]"
---

# seed-project-agents

## A. Purpose

Seed placeholder agent templates into the current project on first activation. Run this once per project to bootstrap the standard agent roster so each team member can customize per-project behavior. After seeding, review and edit each file to match your project domain.

## B. Preconditions

1. `$CLAUDE_PLUGIN_ROOT` must be set to the plugin install directory (e.g. `/path/to/plugin`). If unset or empty, escalate — this skill cannot run without it.
2. The current working directory must be a project root. Heuristic: presence of `.git`, `package.json`, `pyproject.toml`, or `Cargo.toml`. If none are found, prompt the user to confirm the directory is the project root before continuing.
3. CWD must NOT be inside `$CLAUDE_PLUGIN_ROOT`. Seeding into the plugin itself is always wrong — refuse and escalate if this condition is detected.

## C. Source and Destination

**Agent templates:**
- **Source:** `${CLAUDE_PLUGIN_ROOT}/templates/agents/{ceo,cto,architect,swe,pr-reviewer}.md`
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

## G. Post-Seed Advice

After seeding completes, suggest the user:

1. Review each seeded file in `.claude/agents/` — they are placeholder templates, not production-ready agents.
2. Edit each file to match the project domain: update role descriptions, permissions, reporting lines, and model preferences.
3. Remove the `[PLACEHOLDER]` banner from the frontmatter of each file once it has been customized for the project.
4. Delete any templates the project does not need — for example, delete `cto.md` if the architect already absorbs CTO duties, or delete `ceo.md` for a solo-developer project.
