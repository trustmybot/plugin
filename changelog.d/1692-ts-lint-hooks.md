### Changed
- **The lint hooks run in TypeScript** (GH 1692): `commit-msg-lint`, `naming-lint`, `code-quality-lint` and `attribution-footer` are now `mcp/trajectory-server/src/hooks/<gate>.ts`. Their warnings match the `.sh` byte for byte, and attribution-footer makes the same `gh` and `glab` calls with the same bodies. This holds over a corpus of 68 payloads in `tests/fixtures/hook-corpus/`, run in the C, `en_US.UTF-8` and `UTF-8` locales. The corpus covers heredoc and `-F` commits, `-am` and `--message=` forms, nested `bash -c`, non-ASCII subjects, file names and bodies, no-break and ideographic spaces, missing payload fields, and stubbed `gh`/`glab` replies. The four l3 suites pass against both versions. `TMB_HOOKS_IMPL=bash` runs the `.sh` again. The TypeScript hooks differ from the `.sh` in three ways:
  - commit-msg-lint denies a commit command the bash parser cannot read, with the same message git-guards uses, unless the command holds `$(` or a backtick. The `.sh` linted whatever message it misread. A command that builds its message with `$(` or a backtick stays silent, as it does in the `.sh`.
  - All four hooks lint with no `jq` on PATH. The `.sh` exited silently there.
  - attribution-footer reads `[:alnum:]` in a UTF-8 locale as Node's Unicode letters and decimal digits. macOS's locale tables lack about 9,700 letters added in recent Unicode versions, such as U+105C0. The `.sh` read `gh pr create` right after one of them as a separate word and rewrote the body. The TypeScript hook does not. Every character the macOS tables count as a letter or digit, Node counts too.

  Wall time is the median of 25 runs of a `commit-msg-lint` payload through `scripts/hooks/dispatch.sh`, measured on macOS with node 24.15. The TypeScript hook is faster on both payloads.

  | Payload | `commit-msg-lint.sh` | TypeScript |
  |---|---:|---:|
  | Well-formed subject (silent) | 282 ms | 200 ms |
  | Subject with no emoji or type (warns) | 283 ms | 196 ms |
