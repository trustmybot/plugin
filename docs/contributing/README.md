# Contributing

Conventions for developing TMB itself. These rules govern this repository and do not ship to users' projects.

## Index

- [NAMING.md](NAMING.md) — One canonical name stem per feature, carried across every skill, tool, file, test and env var that implements it.
- [FILE_HEADERS.md](FILE_HEADERS.md) — Every new source file opens with a one-line comment saying what it is for, which the world model reads as the file's purpose.
- [ENUMS.md](ENUMS.md) — The controlled vocabularies of the trajectory DB that a lint holds against the code. Values follow established conventions where they exist and are invented only where none apply.
- [LABELS.md](LABELS.md) — The issue label taxonomy for the GitHub board: one type, one priority and one area per issue. Generated from `.github/labels.json`.
- [CHANGELOG_AND_REBASES.md](CHANGELOG_AND_REBASES.md) — How a branch avoids merge conflicts with changelog fragments instead of `CHANGELOG.md` edits, and how generated files are handled.
