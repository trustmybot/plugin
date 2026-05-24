---
paths:
  - "mcp/**/*.ts"
---

# MCP server (TypeScript)

- Prefer the **hardest enforcement layer that fits** (`docs/architecture/ENFORCEMENT.md`): server `requireRoles` / schema `CHECK` > hook > prompt. Never rely on prompt compliance for a load-bearing invariant.
- Every tool validates its inputs and returns `is_error: true` on violation; add an `tests/mcp-integration/` test for a new gate.
- Keep each tool's `description` accurate to its implementation — a description that drifts from the code silently misroutes the agent.
- Match the surrounding code. Mechanical patterns (bare catch, missing timeout, f-string/template SQL, mutable defaults) are caught by `code-quality-lint.sh` — don't reintroduce them.
