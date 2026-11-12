# Prompt engineering

TMB splits every rule an agent follows into two layers:

- **Deterministic:** code decides. The MCP server, hooks, frontmatter, schema constraints and skill `paths:` enforce the rule whatever the prompt says.
- **Judgment:** a model reads prose (`CLAUDE.md`, agent prompts, skills, commands) and decides.

A rule goes deterministic whenever a check can decide it: a sequence, a default, a constraint or a measurement against a stable spec. Only what needs judgment stays in a prompt, such as classifying, composing, or weighing new context. A rule a prompt states is also caught by a harder layer where one fits, so a dropped prompt line fails loudly instead of silently.

## Index

- [DETERMINISTIC_LAYER.md](DETERMINISTIC_LAYER.md) — The rules for the deterministic layer: the six enforcement layers and what each guarantees, the boundary test for moving a rule out of a prompt, the coverage matrix, how to add an enforcement, and the prompt cache zones.
- [JUDGMENT_LAYER.md](JUDGMENT_LAYER.md) — The rules for the judgment layer: yes/no criteria in the order a prompt is written, the grading rubric, real examples, and the eval set a prompt needs.
- [PROMPT_ENGINEERING.md](PROMPT_ENGINEERING.md) — The research reference: each rule with how strong its evidence is and where that evidence comes from. Writing or checking a prompt does not require it.
