---
paths:
  - "CLAUDE.md"
  - "agents/**/*.md"
  - "skills/**/*.md"
  - "commands/**/*.md"
  - "templates/agents/*.md"
---

# Authoring prompts (CLAUDE.md, agents, skills, commands)

Run the pre-ship checklist in `docs/prompt-engineering/PROMPT_ENGINEERING.md` before saving. The essentials:

- Role + objective in the first lines. Instructions specific and **positive** — state what to do, not "never X" (pink-elephant).
- Structure with sections/tables; the most important rule appears early.
- **No conflicting instructions** — within the file, across files, or against a hook/schema. One source of truth per rule; don't duplicate.
- **Pointer, not procedure** — day-to-day behavior inline; occasional procedures live in a skill/command, named not inlined.
- The prompt you're editing **ships into user projects** where `docs/` does not exist — keep it self-contained and never route bro to `docs/`. bro grounds via the world model + `discussion_search`/`audit_search` + reading code.
- Skills stay **under ~200 LOC** and pass the boundary test (`docs/prompt-engineering/DETERMINISM.md`): anything that could fail because the model forgot, misordered, or misunderstood it belongs in a deterministic layer, not prose.
