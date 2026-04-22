# Task Specs

This directory holds per-task execution specs in markdown — see
[`../SPEC-FORMAT.md`](../SPEC-FORMAT.md) for the canonical format.

Filenames map from `branch_id` with `/` → `-`:

```
feat/user-login → docs/trustmybot/tasks/feat-user-login.md
fix/auth-crash  → docs/trustmybot/tasks/fix-auth-crash.md
```

The architect agent writes specs here when authorizing SWE work.
The SWE agent reads its assigned spec at spawn and updates state via MCP
(`task_update_status`, `validation_record`) — never edits the spec body.
