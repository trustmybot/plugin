---
paths:
  - "tests/**"
---

# Tests

- **Do not edit `tests/l5-l6/rows/*/prompt.txt` without explicit Human approval.** They simulate real user language; editing them to chase a passing chain drifts the L5/L6 suite. When a test fails, fix the assertion, `setup-l5`, a hook, or the doctrine — not the prompt.
- New enforcement ships with its test: a hook → `tests/l3-integration/hooks/<name>.test.sh`; an MCP gate → `tests/l3-integration/mcp/`.
- Tests run against `:memory:` / no live services, with zero external mutations.
