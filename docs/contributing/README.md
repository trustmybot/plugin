# Contributing

Conventions for developing TMB itself. They govern this repository and do not ship to users' projects; the workflow for a change (branches, CI, issues, release) is in the root [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

Each convention here is held one of two ways, the same split as [prompt engineering](../prompt-engineering/README.md):

- **Checked:** a lint, a generator or a workflow fails or fixes a change that breaks it, so the doc names that check and a reviewer trusts it.
- **Reviewed:** no check can decide it, so a reviewer reads the change against the doc.

A convention moves from reviewed to checked whenever a check can decide it.

## Index

In the order a change meets them:

| Doc | What it covers | Held by |
|---|---|---|
| [NAMING.md](NAMING.md) | One name stem per feature, carried across its skill, tools, files, tests and env vars. | Reviewed; two lints hold skill names |
| [FILE_HEADERS.md](FILE_HEADERS.md) | Every new source file opens with a one-line comment saying what it is for, which the world model reads as the file's purpose. | Checked |
| [ENUMS.md](ENUMS.md) | The trajectory DB vocabularies a lint holds against the code: values follow established conventions where they exist. | Checked; one table generated |
| [CHANGELOG_AND_REBASES.md](CHANGELOG_AND_REBASES.md) | Changelog fragments instead of `CHANGELOG.md` edits, and generated files kept out of git, so branches don't conflict. | Checked |
| [LABELS.md](LABELS.md) | The GitHub issue labels: one type, one priority and one area per issue. | Checked; tables generated from `.github/labels.json` |
