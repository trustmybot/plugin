### Changed

- The architecture docs open with a reading guide and the three-layer rule (docs hold design, the world model holds relationships, code holds logic); repo resolution moved into the git page, and every page is slimmed to design level (GH 3139).
- The install, upgrade, trajectory DB location and config key reference pages moved into the architecture docs, and the health check and upgrade messages link there; `docs/reference/` is gone (GH 3139).
- The quality layers moved from the flow index into the task handling page, and the doc review now has one author layer (bro or swe) before code-reviewer (GH 3139).
- The task flows are now the code task (architectural changes folded in) and the non-code task bro writes itself, each with one table of steps, owners and methods; both share the push gate, and the quality-layer rules follow the task flows (GH 3139).
- bro's prompt and planning skill call the implement / fix / refactor flow the code task flow, matching the architecture docs (GH 3139).
