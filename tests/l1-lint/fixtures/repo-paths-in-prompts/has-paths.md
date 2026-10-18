# Fixture: lines that name this repository's own layout
Edit mcp/trajectory-server/src/db.ts for the schema.
Run scripts/hooks/code-quality-lint.sh before commit.
Regenerate with scripts/maintenance/bump-version.sh.
Add a fragment under changelog.d/ for each change.
Run tests/l1-lint/link-check.sh and tests/l3-integration/run.sh.
Call regen-generated after editing the schema.
The dist-fresh check compares the build output.
See docs/architecture/FLOWS.md for the flows.
