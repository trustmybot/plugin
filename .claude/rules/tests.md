---
paths:
  - "tests/**"
---

# Tests

- **Do not edit `tests/dogfood/rows/*/prompt.txt` or the A/B arm prompts without explicit Human approval.** They simulate real user language; editing them to chase a passing chain drifts the L5/L6 suite. When a test fails, fix the assertion, `setup-l5`, a hook, or the doctrine — not the prompt.
- New enforcement ships with its test: a hook → `tests/hooks/<name>.test.sh`; an MCP gate → `tests/mcp-integration/`.
- Tests run against `:memory:` / no live services, with zero external mutations.
