### Fixed
- **Creating a skill or agent no longer trips the prompt-write approval gate before you approve it** (GH 2954): the skill-creator and `/tmb:agent-create` flows now write and lint their draft under `.claude/tmb/prompt-drafts/`, and write the real file under `.claude/skills/` or `.claude/agents/` only after you approve it.
