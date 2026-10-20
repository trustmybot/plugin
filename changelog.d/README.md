# changelog.d/

One file per change. A branch adds its fragment here and leaves `CHANGELOG.md` alone; `scripts/maintenance/bump-version.sh` assembles every fragment into the release's `## vX.Y.Z — YYYY-MM-DD` section and deletes them. Parallel branches never touch the same lines, so CHANGELOG conflicts stop.

## Format

File name: `<gh-issue>-<slug>.md` — the GitHub issue number, a hyphen, a lowercase hyphenated slug (`1277-changelog-fragments.md`).

```markdown
### Fixed
- **What the user sees now** (GH 1277): what was wrong, what changed, and what it means for them.
```

- Line 1 is the section, exactly one of `### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Security`.
- The rest is the entry: one bullet starting with `- `, citing `GH <n>` for the issue in the file name (more issues may be cited alongside). Cite issues as `GH <n>`, never `#<n>`.
- A change that spans two sections adds two fragments (`1277-fragments.md`, `1277-fragments-removed.md`).

## Checks

`tests/l1-lint/changelog-current.sh` validates every fragment, fails a feature branch that both edits `CHANGELOG.md` and adds a fragment, fails a direct `CHANGELOG.md` edit on a feature branch after the cut-over date, and requires each `GH <n>` cited in the branch's commit subjects to have a fragment or an existing `CHANGELOG.md` entry.

## Release

`bash scripts/maintenance/bump-version.sh --dry-run <version>` prints the section the release would get: the `## Unreleased` entries (if any) followed by the fragments, grouped by section in the order above, fragments sorted by issue number. Without `--dry-run` it writes that section in place of `## Unreleased` and deletes the fragments; a malformed fragment stops it with every file unchanged.
