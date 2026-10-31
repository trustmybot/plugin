#!/usr/bin/env bash
# Tests for tests/l1-lint/enums-stable-extract.pl and the lint on top of it
# (GH 2043): comments and prefix tests emit nothing, a constant passed to
# insertAudit emits its value, and real drift still fails the lint.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
LINT="$PLUGIN_ROOT/tests/l1-lint/enums-stable.sh"
EXTRACT="$PLUGIN_ROOT/tests/l1-lint/enums-stable-extract.pl"
LINT_FIXTURES="$PLUGIN_ROOT/tests/l1-lint/fixtures/enums-stable"
SOURCES="$HERE/fixtures/enums-stable-extract"

WORK="$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-enums-stable-extract.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

extract() {
  local enum="$1" source="$2"
  perl "$EXTRACT" "$enum" /dev/null "$SOURCES/$source" | cut -f1 | sort | tr '\n' ' '
}

# new_tree <name> [overlay]: the lint's passing base tree, with a fixture overlay.
new_tree() {
  cp -R "$LINT_FIXTURES/base" "$WORK/$1"
  [ -z "${2:-}" ] || cp -R "$LINT_FIXTURES/$2/." "$WORK/$1/"
}

# run_lint <name>: sets lint_exit and lint_output.
run_lint() {
  lint_exit=0
  lint_output=$(bash "$LINT" "$WORK/$1" 2>&1) || lint_exit=$?
}

test_case "a comment mention emits no event"
assert_eq "" "$(extract audit.event_type comment.ts)" "events from comments"

test_case "a comment mention emits no from_node"
assert_eq "" "$(extract audit.from_node comment.ts)" "from_node from comments"

test_case "a hook: prefix operation emits no from_node"
assert_eq "" "$(extract audit.from_node prefix.ts)" "from_node from prefixes"

test_case "constants passed to insertAudit emit their values, unresolved ones nothing"
assert_eq "aliased_event barrel_event imported_event local_event " "$(extract audit.event_type constant.ts)" "resolved events"

test_case "comment markers inside strings, regexes and templates are text"
assert_eq "after_glob_event after_regex_event after_url_event " "$(extract audit.event_type markers-in-text.ts)" "events after markers"

test_case "the lint passes its base tree"
new_tree base
run_lint base
assert_exit_code 0 "$lint_exit" "base tree: $lint_output"

test_case "the lint rejects an undocumented event"
new_tree undocumented undocumented
run_lint undocumented
assert_exit_code 1 "$lint_exit" "undocumented event"
assert_contains "$lint_output" "audit.event_type 'ghost_event' used in scripts/hooks/extra.sh but missing from ENUMS.md"

test_case "the lint rejects an undocumented event behind a constant"
new_tree ghost-constant
cat > "$WORK/ghost-constant/mcp/trajectory-server/src/tools/ghost.ts" <<'TS'
const GHOST_EVENT = 'ghost_constant_event';
export const write = (db: unknown) => insertAudit(db, { event_type: GHOST_EVENT, summary: 's' });
TS
run_lint ghost-constant
assert_exit_code 1 "$lint_exit" "undocumented constant"
assert_contains "$lint_output" "audit.event_type 'ghost_constant_event' used in mcp/trajectory-server/src/tools/ghost.ts"

test_case "the lint rejects a documented value with no use"
new_tree unused unused
run_lint unused
assert_exit_code 1 "$lint_exit" "unused value"
assert_contains "$lint_output" "audit.event_type 'phantom_event' documented in ENUMS.md but not found"

test_case "a comment mention does not count as a use"
new_tree unused-comment unused
printf "// event_type: 'phantom_event'\n" > "$WORK/unused-comment/mcp/trajectory-server/src/tools/note.ts"
run_lint unused-comment
assert_exit_code 1 "$lint_exit" "comment-only value"
assert_contains "$lint_output" "audit.event_type 'phantom_event' documented in ENUMS.md but not found"

test_case "an imported constant passed to insertAudit counts as a use"
new_tree used-constant unused
cat > "$WORK/used-constant/mcp/trajectory-server/src/tools/names.ts" <<'TS'
export const PHANTOM_EVENT = 'phantom_event';
TS
cat > "$WORK/used-constant/mcp/trajectory-server/src/tools/writer.ts" <<'TS'
import { PHANTOM_EVENT } from './names.js';
export const write = (db: unknown) => insertAudit(db, { event_type: PHANTOM_EVENT, summary: 's' });
TS
run_lint used-constant
assert_exit_code 0 "$lint_exit" "constant use: $lint_output"

test_case "the lint rejects a malformed complete hook: identifier"
new_tree malformed
printf "export const from = 'hook:Bad_Name';\n" > "$WORK/malformed/mcp/trajectory-server/src/tools/bad.ts"
run_lint malformed
assert_exit_code 1 "$lint_exit" "malformed identifier"
assert_contains "$lint_output" "from_node 'hook:Bad_Name' in mcp/trajectory-server/src/tools/bad.ts does not match hook:[a-z0-9-]+"

test_case "the lint rejects a bare hook: literal outside a prefix operation"
new_tree bare
printf "export const from = 'hook:';\n" > "$WORK/bare/mcp/trajectory-server/src/tools/bare.ts"
run_lint bare
assert_exit_code 1 "$lint_exit" "bare prefix"
assert_contains "$lint_output" "from_node 'hook:' in mcp/trajectory-server/src/tools/bare.ts does not match"

test_case "a prefix operation and a comment leave the lint passing"
new_tree prefix
cp "$SOURCES/prefix.ts" "$SOURCES/comment.ts" "$WORK/prefix/mcp/trajectory-server/src/tools/"
run_lint prefix
assert_exit_code 0 "$lint_exit" "prefix and comment: $lint_output"

summarize
