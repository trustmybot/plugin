# Generic prompt rubric

The rubric `tmb_doc-review` grades against when the project's path-classes file declares no rubric of its own. Each criterion is a yes/no question about a prompt file: an agent, skill or command file, a `CLAUDE.md`, or any file the project treats as a prompt. Grade each one `pass`, `fail` or `n/a` and cite it by its id. The ids are stable: a retired criterion keeps its id, and a new one takes the next number.

| Id | Criterion |
|---|---|
| R1 | The reader's role and objective are in the first lines. |
| R2 | The rules are few, and the most important come first. |
| R3 | The prompt uses one structure style throughout (headings, numbered steps, bullets or tables), the same style for the same kind of content. |
| R4 | There is no expert persona, "think step by step", tip, threat, flattery or urgency boilerplate. |
| R5 | Each prohibition names what to do instead. |
| R6 | Where the reader produces output, its shape is stated: a schema, a section layout, a table or a return line. |
| R7 | No rule contradicts another rule in the same file, another prompt file, or a hook or gate that enforces it; where two can collide, the prompt states which wins. |
| R8 | Each rule is stated once; any other place that needs it points to it. |
| R9 | Each description of a tool, skill, CLI command or hook matches the code: its name, its parameters, the values it accepts and what it enforces. |
| R10 | Emphasis words (CRITICAL, MUST, ALWAYS, NEVER, all-caps phrases) appear only on true invariants. |
| R11 | Each non-obvious rule gives its reason. |
| R12 | Where the project keeps an eval set for the prompt, it was re-run after the last wording change; `n/a` when there is none. |
