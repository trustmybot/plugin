### Changed
- **The trajectory-gates chain members have TypeScript versions** (GH 1692): three PreToolUse trajectory-server gates are ported from `scripts/hooks/<gate>.sh` to `mcp/trajectory-server/src/hooks/` and listed in `dist/hooks-gates.txt`. Their policy, audit rows and messages are unchanged:
  - `agent-arg-matches-caller` denies a trajectory-server call whose `agent` argument is not the caller, and records an `agent_arg_mismatch` audit row.
  - `reviewer-identity-observe` records a `reviewer_identity_observed` audit row when a code-reviewer subagent calls `validation_record`.
  - `cheatcode-install-approval` denies a `cheatcode_install` whose `source_url` has no `cheatcode_approved` audit row.

  A 56-payload corpus in `tests/fixtures/hook-corpus/` runs each gate through both versions in the C and `en_US.UTF-8` locales. Each payload runs against a freshly rebuilt sandbox. Both versions exit the same way, print byte-identical stdout and stderr, and leave identical audit rows behind. The corpus covers:
  - every allow and deny branch
  - namespaced agent types, agent names in any case, and non-ASCII names whose lowercasing depends on the locale
  - stdin that is not one JSON object, and non-string or numeric fields
  - known, unknown and missing tasks, quoted source URLs, and missing, corrupt, old-schema and schema-only DBs

  The `agent-arg-matches-caller` and `reviewer-identity-observe` l3 suites pass against both versions; `TMB_HOOK_TEST_IMPL=ts` picks the TypeScript one.

  The TypeScript gates differ from the .sh only where they no longer need a CLI tool (decision 703). Each difference has a payload in the corpus marked `corpus_divergent`:
  - **No jq needed.** Without jq, `agent-arg-matches-caller.sh` exited 1 and the call went through, `reviewer-identity-observe.sh` recorded nothing, and `cheatcode-install-approval.sh` let every install through. The TypeScript gates still deny a mismatched agent, record the reviewer and check the install's approval.
  - **No `sqlite3` CLI needed.** The TypeScript gates read and write the trajectory DB through Node's built-in `node:sqlite`. Without `sqlite3`, `agent-arg-matches-caller.sh` denied but wrote no audit row, `reviewer-identity-observe.sh` recorded nothing, and `cheatcode-install-approval.sh` denied every install as unverifiable. The TypeScript gates write the row, record the reviewer and allow an approved install.
