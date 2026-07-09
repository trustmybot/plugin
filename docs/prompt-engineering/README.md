# docs/prompt-engineering/

How TMB writes and enforces the prompts that drive its agents. The central rule: anything load-bearing belongs on a deterministic layer (hook, tool, schema), not in prose; prompts carry only the irreducibly judgment-bound parts.

| File | Purpose |
|---|---|
| [`DETERMINISM.md`](./DETERMINISM.md) | The determinism-vs-judgment layering rules — what migrates out of a prompt into a deterministic layer |
| [`ENFORCEMENT.md`](./ENFORCEMENT.md) | The 6 enforcement layers (hardest → softest) and which mechanism covers which interaction |
| [`PROMPT_ENGINEERING.md`](./PROMPT_ENGINEERING.md) | How we author agent personas, skills, and commands — mainstream prompt-engineering technique adapted for tool-using agents |
