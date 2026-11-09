# docs/contributing/

Controlled-vocabulary registries — the source-of-truth names that hooks branch on, skills assert on, and bro routes by — and the dev rules for changing them. Consult these before adding or renaming an enum value, a label, or a feature stem; a silent rename here breaks downstream code without a compile error.

| File | Purpose |
|---|---|
| [`ENUMS.md`](./ENUMS.md) | The lint-guarded controlled vocabularies of the trajectory DB, with a pointer to `schema.sql` for the rest |
| [`LABELS.md`](./LABELS.md) | The issue-label taxonomy for TMB development (one type, one priority, one area), generated from `.github/labels.json` |
| [`CHANGELOG_AND_REBASES.md`](./CHANGELOG_AND_REBASES.md) | How a branch records its change (`changelog.d/` fragments) and which generated files stay untracked so a rebase never conflicts on them |
| [`NAMING.md`](./NAMING.md) | The one-stem-per-feature rule — every surface implementing/testing/documenting a feature uses the same name |
| [`FILE_HEADERS.md`](./FILE_HEADERS.md) | The purpose-header rule — a new `ts`, `tsx` or `sh` source file opens with a one-line comment saying what it is for |
| [`CODEX_PORT.md`](./CODEX_PORT.md) | Porting TMB to the Codex host |

## Writing docs

Hand-written docs stay at architecture level: a component's purpose, its boundaries, and why it is built that way. A low-level fact the code owns — a version number, a column list, an enum value, a file pattern — is not copied into prose; the doc points once to the source of truth instead. A generated section guarded by a freshness test (such as the `audit.event_type` table in `ENUMS.md`) may carry such detail, because the test fails when it drifts. When a doc drifts from the code, fix it by deleting the detail, not by re-copying it.
