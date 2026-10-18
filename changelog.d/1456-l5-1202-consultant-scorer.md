### Fixed
- **L5 12.02-consultant-ad-hoc no longer fails on a call no doctrine asks for** (GH 1456): the row's `tools-required.json` demanded `agent_list`, but bro finds the consultant by globbing `.claude/agents/` and spawns it via `Agent`, so the row now requires only `Agent`, and the FLOWS.md consultant passage names `agent_resolve` instead of `agent_list`.
