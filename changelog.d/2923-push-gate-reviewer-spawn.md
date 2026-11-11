### Fixed
- **The push gate spawns code-reviewer the way the spawn gates expect** (GH 2923): the push-gate skill told bro to spawn each reviewer as `code-reviewer` at the configured reviewer effort, which the spawn gates reject. It now spawns each reviewer with the prompt, effort and agent type that the task's close returned, in parallel.
