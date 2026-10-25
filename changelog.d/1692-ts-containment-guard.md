### Changed
- **containment-guard runs in TypeScript, on the tree-sitter write-path analyzer** (GH 1692): the PreToolUse gate that keeps each agent's writes inside its run's root is now `mcp/trajectory-server/src/hooks/containment-guard.ts`. Its decisions, deny messages and `containment_denied` audit rows match `containment-guard.sh` over a 54-payload corpus in the C and UTF-8 locales. It is stricter in two cases. A command the analyzer cannot parse is always denied, and so is a path a program builds at run time, even when the raw text starts with a directory inside the root. The .sh let both through when the literal directory was in the root. `TMB_HOOKS_IMPL=bash` runs the .sh again. The shared hook libs now follow the bash ones in five more places:
  - SQL in double quotes is read as a string, and foreign keys stay off.
  - `.parameter set` values are split and quoted the way the `sqlite3` CLI does it.
  - Trailing newlines are stripped from quoted SQL values.
  - DEL is escaped as `\u007f` in deny JSON.
  - A read that runs past its budget keeps the rows it already printed.

  The askuserquestion-length-lint also counts a no-break space as a word break under a bare `UTF-8` locale.

  Cold-process wall time is the p50 of 10 runs of `dispatch.sh containment-guard`, measured on macOS with node 24.15, where `node -e 0` takes 28 ms:

  | Payload | `TMB_HOOKS_IMPL=bash` | default (TypeScript) |
  |---|---:|---:|
  | Write in-root | 351 ms | 156 ms |
  | Bash `ls -la` | 371 ms | 174 ms |
  | Bash redirect | 379 ms | 173 ms |
  | Bash `git commit -F - <<'EOF'` heredoc | 384 ms | 172 ms |
  | Write outside the root (denied, audited) | 436 ms | 169 ms |
