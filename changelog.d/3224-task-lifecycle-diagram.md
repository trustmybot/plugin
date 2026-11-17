### Changed
- **The planned task lifecycle in the architecture docs now matches the settled design** (GH 3224): escalated is final, closing an issue escalates its live tasks while queued work closes with its feature branch, and a branch merged outside the flow closes its task as a recorded bypass. The code that enforces this ships later.
