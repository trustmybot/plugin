#!/usr/bin/env bash
# Cheatcode-uninstall-plugins L5 isolation: pre-seed the INSTALLED state for two
# plugins (feature-dev → swe, code-review → pr-reviewer) directly into the
# trajectory DB so the uninstall has something concrete to reverse, then point
# cheatcode_uninstall at a deterministic teardown fixture via
# TMB_CHEATCODE_UNINSTALL_FIXTURE so no live web / real marketplace call is ever
# made. The fixture lives in the project dir; the env export covers runners that
# source this setup.
#
# The seed mirrors exactly what a prior cheatcode_install would have written: a
# cheatcodes row (kind='plugin', scope='project-local', status='installed') + its
# per-agent attachment row, plus the cheatcode_install / cheatcode_installed
# audit rows that carry each cheatcode_id (so bro can discover the ids to tear
# down). cheatcode_uninstall then deletes the cheatcodes + cheatcode_attachments
# rows in one transaction and emits a cheatcode_uninstalled audit row.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

DB="$PROJECT/.claude/tmb/trajectory.db"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# In the L6 chain, row 44 already installed feature-dev/code-review. Re-seeding
# here would fail the cheatcodes UNIQUE(name) insert while the separate
# attachments insert succeeds (FK off), leaving orphan attachment rows. Only
# seed the installed state when it is not already present.
EXISTING="$(sqlite3 "$DB" "SELECT COUNT(*) FROM cheatcodes WHERE name IN ('feature-dev','code-review');")"

if [ "$EXISTING" -eq 0 ]; then
  sqlite3 "$DB" <<SQL
INSERT INTO cheatcodes (id, name, kind, source_url, version, trust_tier, scope, status, installed_at)
VALUES
  (101, 'feature-dev', 'plugin', 'https://example.test/feature-dev', '1.0.0', 'trusted', 'project-local', 'installed', '$NOW'),
  (102, 'code-review', 'plugin', 'https://example.test/code-review', '1.0.0', 'trusted', 'project-local', 'installed', '$NOW');

INSERT INTO cheatcode_attachments (cheatcode_id, target, artifact, created_at)
VALUES
  (101, 'swe', 'marketplace-plugin:feature-dev', '$NOW'),
  (102, 'pr-reviewer', 'marketplace-plugin:code-review', '$NOW');

INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
VALUES
  (-1, NULL, 'bro', 'cheatcode_install', 'Cheatcode install: ''feature-dev'' (kind=plugin, method=marketplace)', '{"name":"feature-dev","kind":"plugin","source_url":"https://example.test/feature-dev","method":"marketplace"}', '$NOW'),
  (-1, NULL, 'bro', 'cheatcode_installed', 'Cheatcode installed: ''feature-dev'' → cheatcode_id=101', '{"cheatcode_id":101,"name":"feature-dev","kind":"plugin","source_url":"https://example.test/feature-dev","installed":true,"attachments":[{"target":"swe","artifact":"marketplace-plugin:feature-dev"}]}', '$NOW'),
  (-1, NULL, 'bro', 'cheatcode_install', 'Cheatcode install: ''code-review'' (kind=plugin, method=marketplace)', '{"name":"code-review","kind":"plugin","source_url":"https://example.test/code-review","method":"marketplace"}', '$NOW'),
  (-1, NULL, 'bro', 'cheatcode_installed', 'Cheatcode installed: ''code-review'' → cheatcode_id=102', '{"cheatcode_id":102,"name":"code-review","kind":"plugin","source_url":"https://example.test/code-review","installed":true,"attachments":[{"target":"pr-reviewer","artifact":"marketplace-plugin:code-review"}]}', '$NOW');
SQL
fi

FIXTURE="$PROJECT/.tmb-cheatcode-uninstall-fixture.json"
cat > "$FIXTURE" <<'JSON'
{ "removed": true, "error": null }
JSON

export TMB_CHEATCODE_UNINSTALL_FIXTURE="$FIXTURE"
