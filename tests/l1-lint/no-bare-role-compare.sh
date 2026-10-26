#!/usr/bin/env bash
# Regression guard for how hooks decide an agent's role.
#
# Rule 1 — normalized compare: any hook that compares a bare role string
#   (= "swe", = "code-reviewer", != "swe", etc.) MUST source normalize-role.sh,
#   directly or through lib/cmd-analysis.sh (tmb_agent_role). Without
#   normalization, CC may deliver "tmb:swe" where the hook expects "swe",
#   silently disabling safety gates.
#
# Rule 2 — role from identity only: no hook or hook lib may decide a role from
#   a path. Flagged:
#     - a function whose name names a role (role, swe_context, swe_ctx, is_swe,
#       is_bro, agent_type) that reads $PWD / $CWD / .cwd / a worktrees path;
#     - a role variable (AGENT_TYPE, AGENT_ROLE, ROLE, SWE_CTX, IS_SWE)
#       assigned on a line that reads $PWD / $CWD / .cwd / a worktrees path;
#     - inside `case "$PWD"` / `case "$CWD"` (or another *CWD / *PWD variable),
#       an arm that assigns a role variable or echoes yes / a role name.
#
# Scans: scripts/hooks/*.sh and scripts/hooks/lib/*.sh (rule 2), and
# scripts/hooks/*.sh (rule 1).
#
# --self-test: both fixtures under fixtures/bare-role-compare/ must be caught.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

ROLE_COMPARE_REGEX='(=|!=)[[:space:]]+"(swe|code-reviewer|architect|consultant)"'
NORMALIZE_MARKER='(source|\.) +.*(normalize-role|cmd-analysis)\.sh'

# role_from_path <file> — prints one `<file>:<line>: <reason>` per violation.
role_from_path() {
  awk -v f="$1" '
    function report(msg) { printf "%s:%d: %s\n", f, NR, msg }
    {
      line = $0
      sub(/^[[:space:]]*#.*/, "", line)
      if (line ~ /^[[:space:]]*(function[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*\(\)[[:space:]]*\{/) {
        name = line
        sub(/^[[:space:]]*(function[[:space:]]+)?/, "", name)
        sub(/[[:space:]]*\(.*/, "", name)
        infn = (tolower(name) ~ /(role|swe_context|swe_ctx|is_swe|is_bro|agent_type)/) ? name : ""
        depth = 0
      }
      if (infn != "") {
        if (line ~ /(\$\{?PWD|\$\{?[A-Z_]*CWD|\.cwd|worktrees)/) report("function " infn " decides a role from a path")
        n = gsub(/\{/, "{", line); m = gsub(/\}/, "}", line)
        depth += n - m
        if (depth <= 0 && line ~ /\}/) infn = ""
      }
      if (line ~ /(^|[^A-Za-z0-9_])(AGENT_TYPE|AGENT_ROLE|ROLE|SWE_CTX|IS_SWE)=/ && line ~ /(\$\{?PWD|\$\{?[A-Z_]*CWD|\.cwd|worktrees)/)
        report("role variable assigned from a path")
      if (line ~ /case[[:space:]]+"?\$\{?[A-Z_]*(PWD|CWD)\}?"?[[:space:]]+in/) incase = 1
      else if (incase && line ~ /(^|[[:space:];])esac([[:space:];]|$)/) incase = 0
      else if (incase && (line ~ /(AGENT_TYPE|AGENT_ROLE|ROLE|SWE_CTX|IS_SWE)=/ || line ~ /echo[[:space:]]+"?(yes|swe|bro|code-reviewer)"?/))
        report("case on a path decides a role")
    }
  ' "$1"
}

run_self_test() {
  local fixture="$HERE/fixtures/bare-role-compare/has-bare-compare.sh"
  local path_fixture="$HERE/fixtures/bare-role-compare/role-from-path.sh"
  local ok=1 has_compare has_normalize hits
  for f in "$fixture" "$path_fixture"; do
    if [ ! -f "$f" ]; then
      printf 'no-bare-role-compare --self-test: fixture missing: %s\n' "$f" >&2
      exit 1
    fi
  done

  has_compare=$(grep -cE "$ROLE_COMPARE_REGEX" "$fixture" || true)
  has_normalize=$(grep -cE "$NORMALIZE_MARKER" "$fixture" || true)
  if [ "$has_compare" -gt 0 ] && [ "$has_normalize" -eq 0 ]; then
    printf 'no-bare-role-compare --self-test: PASS (bare compare without normalize caught)\n'
  else
    printf 'no-bare-role-compare --self-test: FAIL (bare compare fixture not caught)\n' >&2
    ok=0
  fi

  hits=$(role_from_path "$path_fixture" | wc -l | tr -d ' ')
  if [ "$hits" -ge 3 ]; then
    printf 'no-bare-role-compare --self-test: PASS (role-from-path fixture caught, %s hits)\n' "$hits"
  else
    printf 'no-bare-role-compare --self-test: FAIL (role-from-path fixture: %s hits, want >= 3)\n' "$hits" >&2
    ok=0
  fi
  [ "$ok" = 1 ] && exit 0
  exit 1
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
fi

HOOKS_DIR="$PLUGIN_ROOT/scripts/hooks"
FAIL=0

while IFS= read -r -d '' hook; do
  rel="${hook#"$PLUGIN_ROOT/"}"

  has_compare=$(grep -cE "$ROLE_COMPARE_REGEX" "$hook" || true)
  [ "$has_compare" -eq 0 ] && continue

  has_normalize=$(grep -cE "$NORMALIZE_MARKER" "$hook" || true)
  if [ "$has_normalize" -eq 0 ]; then
    printf '%s: compares bare role string without sourcing normalize-role.sh\n' "$rel"
    FAIL=1
  fi
done < <(find "$HOOKS_DIR" -maxdepth 1 -name '*.sh' -print0)

while IFS= read -r -d '' hook; do
  out=$(role_from_path "$hook")
  if [ -n "$out" ]; then
    printf '%s\n' "${out//"$PLUGIN_ROOT/"/}"
    FAIL=1
  fi
done < <(find "$HOOKS_DIR" "$HOOKS_DIR/lib" -maxdepth 1 -name '*.sh' -print0)

if [ "$FAIL" -ne 0 ]; then
  printf '\nno-bare-role-compare: FAIL\n' >&2
  exit 1
fi

printf 'no-bare-role-compare: PASS\n'
