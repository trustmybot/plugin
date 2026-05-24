---
paths:
  - "scripts/hooks/**"
---

# Hooks (shell)

- Normalize role strings before comparing: source `lib/normalize-role.sh` and call `tmb_normalize_role` (CC may pass a `<plugin>:` prefix). A hook that silently skips is a gate silently disabled.
- Register every hook in `hooks/hooks.json` and add `tests/hooks/<name>.test.sh`.
- Enforce by returning `permissionDecision: deny` (PreToolUse) or injecting `additionalContext`; keep hooks fast and side-effect-light.
- Stay portable: guard for idempotency and macOS BSD tooling (no GNU-only `grep -P` / `\p{...}`).
