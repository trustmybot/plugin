# TMB Plugin Tests

Plugin-level tests and contributor testing guide. The bundled MCP server's TypeScript unit tests live at [`mcp/trajectory-server/src/test/`](../mcp/trajectory-server/src/test/).

## Quick start — run everything

```bash
# From plugin/ root:
bash tests/run-all.sh
```

Runs, in order:
1. **MCP server suite** — TypeScript unit tests for schema, tools, migrations (242+ cases).
2. **Hook script suite** — bash unit tests for `scripts/hooks/*.sh`.

Exit code is non-zero if any suite fails.

## Individual suites

### MCP server

```bash
cd mcp/trajectory-server
bun run build
node --test dist/test/*.test.js
```

**Adding a test:** drop `src/test/<name>.test.ts` following existing patterns (e.g., `src/test/file-registry.test.ts`). Helpers at `src/test/helpers.ts`. Each file imports `node:test` + `node:assert/strict` and uses `describe` / `it`.

Key helper: `tempDB()` creates an ephemeral SQLite DB preloaded with the current schema.

### Hook scripts

```bash
bash tests/hooks/run.sh
```

Runs every `tests/hooks/*.test.sh`.

**Adding a test:**

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/<your-hook>.sh"

test_case "describe the scenario"
out=$(echo '{"tool_input":{"command":"..."}}' | bash "$HOOK" 2>&1 || true)
assert_contains "$out" "expected-substring"

summarize
```

Assertion helpers in `tests/lib/assert.sh`:

- `assert_eq <expected> <actual> [label]`
- `assert_contains <haystack> <needle> [label]`
- `assert_not_contains <haystack> <needle> [label]`
- `assert_exit_code <expected> <actual> [label]`
- `summarize` — prints pass/fail summary; returns non-zero if any assertion failed.

## Local dogfood testing (end-to-end)

The real correctness check is running the plugin against a project and watching for workflow friction. Every bug hit here is a bug downstream users will hit identically.

### Fastest smoke test (~5 min, disposable scratch dir)

```bash
mkdir -p /tmp/tmb-test && cd /tmp/tmb-test
git init && git commit --allow-empty -m "init"

claude                                # launch Claude Code here
```

Inside the session:

```
/plugin marketplace add $PLUGIN_PATH
/plugin install tmb@trustmybot
```

**Expected:** gatekeeper greets you, first-run onboarding asks branching model + PR target + identity. Verify answers persisted:

```bash
sqlite3 ~/.config/claude-code/plugin-data/tmb/trajectory.db \
  "SELECT * FROM plugin_config; SELECT * FROM identity;"
```

### Hot-reload during a session

```
/reload-plugins
```

Or for tight dev iteration, launch with `--plugin-dir` (skips install/caching):

```bash
claude --plugin-dir $PLUGIN_PATH
```

Edits picked up by `/reload-plugins`.

### Reset between tests

```bash
# Inside Claude Code:
/plugin marketplace remove trustmybot
# Outside:
rm ~/.config/claude-code/plugin-data/tmb/trajectory.db
```

## End-to-end dogfood checklist

Manual checks before shipping. Tick each after a change:

| # | Scenario | Expected |
|---|---|---|
| 1 | Fresh install in empty project | Gatekeeper introduces itself; onboarding triggers |
| 2 | Read-only question ("list files in src/") | Gatekeeper answers inline; no agent spawn |
| 3 | Simple code change | Gatekeeper triages `simple` → architect double-checks → task row created via `task_create_batch(spec_body=...)` → SWE in worktree reads via `task_get` |
| 4 | Architecture-affecting change | Gatekeeper triages `difficult` → architect updates `architecture/manual/` ADR → task row (standard template) |
| 5 | `/tmb reonboard` phrase | Skill re-prompts branching + identity |
| 6 | Identity rename ("call yourself alex") | `identity_set` persists; subsequent responses use new name |
| 7 | Architecture regen ("refresh architecture docs") | 4 files regenerated at `docs/trustmybot/architecture/auto/` with generated-header |
| 8 | Commit on protected branch | `git-guards.sh` blocks |
| 9 | Push to `feature/*` branch | Always allowed (issue #13) |
| 10 | Push to dev/main with unsigned completed tasks | `require-review-sign.sh` blocks until pr-reviewer records `validation_record(verdict='pass')` |

## Gaps not covered by this suite (worth filing)

- **Agent-prompt validity** — no linter checks frontmatter fields or tool names referenced in prompts. A typo in an agent prompt won't be caught by CI.
- **Skill frontmatter** — same.
- **Snapshot rendering** — no smoke check that the 4 architecture-auto renderers produce non-empty output with generated-headers.
- **Plugin-load simulation** — CI can't easily emulate Claude Code's plugin loader. The manual dogfood checklist is the substitute.

File any testing gap as an issue tagged `testing`.

## CI

`.github/workflows/test.yml` runs both suites on every PR against `dev`. Green required before merge.

## Related

- `scripts/hooks/diagnostic/README.md` — opt-in probe-bash harness for investigating [issue #14](https://github.com/trustmybot/plugin/issues/14) (subagent Bash bypass suspicion).
