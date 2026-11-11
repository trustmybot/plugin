### Changed
- **Prompt-surface guard covers CLAUDE.md only** (GH 2893): the hooks that fence prompt-surface writes treat `CLAUDE.md` as the only root prompt file; `CODEX.md`, `CURSOR.md` and `GEMINI.md` are ordinary files again. The `agents/`, `skills/`, `commands/` and `templates/` rules are unchanged.
