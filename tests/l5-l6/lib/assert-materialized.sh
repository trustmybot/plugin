#!/usr/bin/env bash
# On-disk consuming-agent materialization check for L5/L6 (issue #95).
#
# When bro installs a cheatcode FOR a specific agent, cheatcode_install (#115)
# materializes that agent's prompt surface into the USER PROJECT's .claude/:
#   - a non-bro target → copies the global agent md to
#     <project>/.claude/agents/<agent>.md and adds the skill to its
#     skills: [...] frontmatter
#   - target=bro → writes/edits <project>/.claude/CLAUDE.md to reference the skill
#
# L6 row 44 previously asserted only the DB attachment rows, so a materialization
# that never touched disk still "passed". This helper reads the filesystem so the
# row proves the copy + header edit actually happened.

set -uo pipefail

# tmb_materialized_on_disk <project_dir> <agent> <skill>
# Returns 0 iff the consuming agent's prompt surface was materialized for <skill>:
#   - agent=bro → <project>/.claude/CLAUDE.md exists and references <skill>
#   - other     → <project>/.claude/agents/<agent>.md exists AND lists <skill>
#                 in its skills: [...] frontmatter
# <skill> matches bare or plugin-prefixed; the bare form is compared.
tmb_materialized_on_disk() {
  local project="$1" agent="$2" skill="$3"
  [ -n "$project" ] || return 1
  [ -n "$agent" ] || return 1
  [ -n "$skill" ] || return 1

  # Bare skill name (strip any plugin prefix) for prefix-agnostic matching.
  local bare="${skill#*:}"

  if [ "$agent" = "bro" ]; then
    # bro's surface is the project-local CLAUDE.md, not an agent md.
    local claude_md="$project/.claude/CLAUDE.md"
    [ -f "$claude_md" ] || return 1
    grep -Fq "$bare" "$claude_md" 2>/dev/null && return 0
    return 1
  fi

  local agent_md="$project/.claude/agents/${agent}.md"
  [ -f "$agent_md" ] || return 1

  # Pull the skills: [...] entries from the leading frontmatter block and test
  # for an exact (bare) skill entry — substring of a longer name must not match.
  local skills_line
  skills_line=$(grep -E '^skills:[[:space:]]*\[.*\][[:space:]]*$' "$agent_md" 2>/dev/null | head -1)
  [ -n "$skills_line" ] || return 1

  local inner="${skills_line#*[}"
  inner="${inner%]*}"
  local IFS=','
  local entry
  for entry in $inner; do
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry%"${entry##*[![:space:]]}"}"
    [ "$entry" = "$bare" ] && return 0
  done
  return 1
}
