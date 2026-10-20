#!/usr/bin/env bash
# Tests for tmb_repo_remotes (scripts/hooks/lib/resolve-repo.sh) against the
# real schema.sql: the repo_remotes rows of the repos row matching <git_root>
# (else the sole registered repo) as a JSON array of {name,provider,url},
# primary first; "[]" for a registered repo with no rows; empty when no repo
# resolves or the DB predates repo_remotes.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=scripts/hooks/lib/resolve-repo.sh
. "$PLUGIN_ROOT/scripts/hooks/lib/resolve-repo.sh"

TMP=$(_t=${TMPDIR:-/tmp}; mktemp -d "${_t%/}/tmb-resolve-repo-remotes.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

DB="$TMP/trajectory.db"
sqlite3 "$DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
sqlite3 "$DB" "
  INSERT INTO repos (name, path) VALUES ('app', '/ws/app'), ('lib', '/ws/lib'), ('bare', '/ws/bare');
  INSERT INTO repo_remotes (repo, name, provider, url, is_primary) VALUES
    ('app', 'upstream', 'github', 'https://github.com/up/app.git', 0),
    ('app', 'origin', 'gitlab', 'git@gitlab.com:me/app.git', 1),
    ('lib', 'origin', 'github', 'https://github.com/me/lib.git', 1);
"

test_case "matching repo: JSON array of {name,provider,url}, primary first"
assert_eq '[{"name":"origin","provider":"gitlab","url":"git@gitlab.com:me/app.git"},{"name":"upstream","provider":"github","url":"https://github.com/up/app.git"}]' \
  "$(tmb_repo_remotes "$DB" /ws/app)" "app remotes"

test_case "each repo reads only its own rows"
assert_eq '[{"name":"origin","provider":"github","url":"https://github.com/me/lib.git"}]' "$(tmb_repo_remotes "$DB" /ws/lib)" "lib remotes"

test_case "registered repo with no rows prints []"
assert_eq '[]' "$(tmb_repo_remotes "$DB" /ws/bare)" "bare remotes"

test_case "unmatched root with several repos registered prints nothing"
assert_eq '' "$(tmb_repo_remotes "$DB" /ws/other)" "no fallback in a multi-repo DB"

test_case "unmatched root falls back to the sole registered repo"
SOLE="$TMP/sole.db"
sqlite3 "$SOLE" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
sqlite3 "$SOLE" "INSERT INTO repos (name, path) VALUES ('only', '/ws/only');
  INSERT INTO repo_remotes (repo, name, provider, url, is_primary) VALUES ('only', 'origin', 'github', 'https://github.com/me/only.git', 1);"
assert_eq '[{"name":"origin","provider":"github","url":"https://github.com/me/only.git"}]' "$(tmb_repo_remotes "$SOLE" '')" "sole-repo fallback"

test_case "a DB without repo_remotes prints nothing"
OLD="$TMP/old.db"
sqlite3 "$OLD" "CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL, remotes TEXT);
  INSERT INTO repos VALUES ('app', '/ws/app', '[]');"
assert_eq '' "$(tmb_repo_remotes "$OLD" /ws/app)" "pre-v35 DB"

test_case "a missing DB prints nothing"
assert_eq '' "$(tmb_repo_remotes "$TMP/missing.db" /ws/app)" "missing DB"

summarize
