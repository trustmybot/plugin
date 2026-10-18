### Changed
- **`/tmb:onboard` documents the persona step and its opt-out** (GH 1339): `commands/onboard.md` now says that the apply writes the bro persona into the project's `CLAUDE.md` between managed `tmb:persona` markers and re-applies it on upgrade, that `persona: false` on `onboard_apply` removes the block, and that a symlinked or read-only `CLAUDE.md` is skipped with a reason.
