#!/usr/bin/env bash
# UserPromptSubmit hook — dispatcher for all intent-hint pattern classes.
#
# Reads stdin once, lowercases once, then walks a pattern-to-handler table.
# Each pattern class can emit one additionalContext block; the first class
# that fires wins (patterns are checked in priority order).
#
# Pattern classes handled:
#   cheatcode-install — install of a named plugin/skill/mcp/cheatcode (or 'in <scope> scope')
#   consultant-spawn — domain-expert keyword + question/advisory shape required
#   search-grounding — decision-retrieval questions (decision-anchored only)
#   concerns-protocol — doubt-class / weaken-gate phrases
#   push-intent      — push/ship phrases (DB query on match)
#   reonboard-intent — remote-setup / host-on phrases (DB query on match)
#   headless-intent  — claude -p / headless / CI-run phrases (DB query on match)
#   resume-intent    — keep-going / pick-up / continue phrases (DB query on match)
#   adr-required     — architectural intent (phrases + word-proximity checks)
#   audit-intent     — audit / verify / check / double-check / architecture as whole words
#
# Bypass env vars forwarded: TMB_DISABLE_CHEATCODE_INSTALL_HINT,
# TMB_DISABLE_CONSULTANT_HINT, TMB_DISABLE_SEARCH_HINT, TMB_DISABLE_CONCERNS_HINT,
# TMB_DISABLE_PUSH_INTENT_HINT, TMB_DISABLE_REONBOARD_HINT, TMB_DISABLE_HEADLESS_HINT,
# TMB_DISABLE_RESUME_HINT, TMB_DISABLE_ADR_HINT, TMB_DISABLE_AUDIT_HINT.
#
# Silent on failure; advisory hooks never exit non-zero.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh disable=SC1091
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/db-write.sh disable=SC1091
. "$SCRIPT_DIR/lib/db-write.sh"
# shellcheck source=scripts/hooks/lib/cmd-analysis.sh disable=SC1091
. "$SCRIPT_DIR/lib/cmd-analysis.sh"

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0

PROMPT_RAW=$(printf '%s' "$INPUT" | jq -r '.prompt // ""' 2>/dev/null)
[ -n "$PROMPT_RAW" ] || exit 0

# A `!` shell turn arrives as <bash-input>/<bash-stdout>/<bash-stderr> spans;
# words in the command or its captured output are not Human intent (GH 1598).
PROMPT_RAW=$(printf '%s' "$PROMPT_RAW" \
  | perl -0777 -pe 's{<bash-(input|stdout|stderr)>.*?</bash-\1>}{}gs' 2>/dev/null) || exit 0
case "$PROMPT_RAW" in *[![:space:]]*) ;; *) exit 0 ;; esac

# Harness-turn early-exit — task/system notifications, subagent hand-backs,
# agent and cross-session messages (tmb_is_harness_turn) carry embedded
# content that trips the matchers, but every hint class describes HUMAN
# intent. Exit before any matcher.
tmb_is_harness_turn "$PROMPT_RAW" && exit 0

tmb_db_path_advisory prompt-intent-hints >/dev/null || true

# strip_injected_blocks <text> — prints <text> without the harness-injected
# <system-reminder…>, <pasted_content…> and <agent-message…> blocks, each cut
# from its opening tag to the first matching close tag; an unclosed block stays.
strip_injected_blocks() {
  printf '%s\n' "${1:-}" | awk '
    function opening(s, tag,   k, c) {
      k = index(s, "<" tag)
      while (k > 0) {
        c = substr(s, k + length(tag) + 1, 1)
        if (c == ">" || c == " " || c == "\t" || c == "\n") return k
        c = index(substr(s, k + 1), "<" tag)
        k = (c > 0) ? k + c : 0
      }
      return 0
    }
    { buf = (NR == 1) ? $0 : buf "\n" $0 }
    END {
      ntags = split("system-reminder pasted_content agent-message", tags, " ")
      out = ""
      while (1) {
        first = 0; ft = ""
        for (t = 1; t <= ntags; t++) {
          k = opening(buf, tags[t])
          if (k > 0 && (first == 0 || k < first)) { first = k; ft = tags[t] }
        }
        if (first == 0) break
        close_tag = "</" ft ">"
        e = index(substr(buf, first), close_tag)
        if (e == 0) { out = out substr(buf, 1, first); buf = substr(buf, first + 1); continue }
        out = out substr(buf, 1, first - 1) " "
        buf = substr(buf, first + e - 1 + length(close_tag))
      }
      print out buf
    }
  '
}

# Hints match the Human's own words: text the harness injected into the prompt
# (reminders quoting other sessions, pasted content) is never intent (GH 1764).
PROMPT_RAW=$(strip_injected_blocks "$PROMPT_RAW")
case "$PROMPT_RAW" in *[![:space:]]*) ;; *) exit 0 ;; esac

LOWER=$(printf '%s' "$PROMPT_RAW" | tr '[:upper:]' '[:lower:]')
# The prompt with backticked and quoted spans removed: concerns, push, resume,
# architectural and audit hints match only what the Human wrote, not text they quote.
LOWER_OPEN=$(tmb_strip_quoted_spans "$PROMPT_RAW" | tr '[:upper:]' '[:lower:]')

emit_context() {
  local ctx="$1"
  jq -nc --arg ctx "$ctx" '{
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: $ctx
    }
  }'
  exit 0
}

# Write a deterministic audit row recording that the consultant-spawn nudge
# fired. Gates the 10-consultant L6 row on the enforcement mechanism (this row)
# rather than bro's non-deterministic compliance with the advisory nudge.
# Fail-open: DB/sqlite3 absent → silent skip; a failed write is reported on
# stderr and never blocks the hook.
audit_consultant_spawn_nudged() {
  local detail="$1"
  command -v sqlite3 >/dev/null 2>&1 || return 0
  local db
  db=$(tmb_db_path 2>/dev/null || true)
  [ -n "$db" ] || return 0
  [ -f "$db" ] || return 0
  tmb_audit_append "$db" -1 '' "hook:prompt-intent-hints" "consultant_spawn_nudged" \
    "Consultant-spawn nudge emitted: $(printf '%s' "$detail" | head -c 200)" '{}' \
    || return 0
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Word-boundary check: is word $1 present in string $2 as a standalone word?
has_word() {
  local word="$1"
  local text="$2"
  case "$text" in
    *[!a-z]"${word}"[!a-z]*) return 0 ;;
    "${word}"[!a-z]*)        return 0 ;;
    *[!a-z]"${word}")        return 0 ;;
    "${word}")               return 0 ;;
  esac
  return 1
}

# ---------------------------------------------------------------------------
# 0. cheatcode-install — installing a NAMED external capability.
#    Fires when the prompt installs a plugin/skill/mcp/cheatcode (the capability
#    noun appears with 'install'), OR requests 'in (local|global) scope', OR
#    installs/adds a capability TARGETED AT a known agent ("install <X> for swe",
#    "add <X> to bro"). A capability ON an agent is the cheatcode-reuse path, so
#    that target form routes to tmb_cheatcode (not tmb_planning, the build flow).
#    Anchored on the capability noun / agent target so dependency installs
#    (npm/pip/bun install, 'install dependencies') never match. Checked before
#    consultant-spawn so an install directive routes to the cheatcode pipeline,
#    NOT agent-create — while a bare role name (no install verb) still falls
#    through to consultant-spawn.
# ---------------------------------------------------------------------------
if [ "${TMB_DISABLE_CHEATCODE_INSTALL_HINT:-0}" != "1" ]; then
  cheatcode_install_match=""

  # capability-on-agent: the whole word install/add, followed in the same clause
  # (no . ; ? ! or newline between) by "for|to|onto <agent>" as whole words, where
  # agent ∈ {swe, code-reviewer, bro} plus any active consultant role from the
  # registry. This is the cheatcode-reuse path — a capability attached to an
  # agent — so it loads tmb_cheatcode. Dependency installs never match: "for the
  # build" / "to get the deps" carry no agent name.
  capability_on_agent=""
  if printf '%s' "$LOWER" | grep -E '(^|[^a-z0-9_])(install|add)([^a-z0-9_]|$)' >/dev/null; then
    AGENT_TARGETS="swe code-reviewer bro"
    DB=$(tmb_db_path 2>/dev/null || true)
    if [ -n "$DB" ] && command -v sqlite3 >/dev/null 2>&1; then
      CONSULTANT_ROLES=$(tmb_sqlite_ro "$DB" "SELECT name FROM agents WHERE kind='consultant';")
      while IFS= read -r role; do
        [ -n "$role" ] || continue
        AGENT_TARGETS="$AGENT_TARGETS $(printf '%s' "$role" | tr '[:upper:]' '[:lower:]')"
      done <<EOF
$CONSULTANT_ROLES
EOF
    fi
    capability_on_agent=$(printf '%s\n' "$LOWER" | awk -v agents="$AGENT_TARGETS" '
      function word(c) { return c ~ /[a-z0-9_]/ }
      function has_target(t, a,   np, preps, p, needle, k, off, before, after) {
        np = split("for to onto", preps, " ")
        for (p = 1; p <= np; p++) {
          needle = preps[p] " " a
          off = 0
          while ((k = index(substr(t, off + 1), needle)) > 0) {
            k += off
            before = (k == 1) ? "" : substr(t, k - 1, 1)
            after = substr(t, k + length(needle), 1)
            if (!word(before) && !word(after) && after != "-") return 1
            off = k
          }
        }
        return 0
      }
      BEGIN { na = split(agents, ag, " ") }
      {
        nc = split($0, clauses, /[.;?!]/)
        for (c = 1; c <= nc; c++) {
          s = clauses[c]
          gsub(/[ \t]+/, " ", s)
          pos = 1
          while (match(substr(s, pos), /install|add/)) {
            v = pos + RSTART - 1
            e = v + RLENGTH
            if ((v == 1 || !word(substr(s, v - 1, 1))) && !word(substr(s, e, 1))) {
              tail = substr(s, e)
              for (i = 1; i <= na; i++) if (has_target(tail, ag[i])) { print ag[i]; exit }
            }
            pos = v + 1
          }
        }
      }
    ')
  fi

  if [ -n "$capability_on_agent" ]; then
    CTX="[tmb cheatcode-routing] This installs a capability ONTO the \`${capability_on_agent}\` agent — that is the cheatcode-reuse path. Load \`tmb_cheatcode\`: search/vet/approve the capability (cheatcode_search → cheatcode_approve) then materialize it onto the agent. This is capability reuse, so it routes through the cheatcode pipeline rather than the build flow."
    emit_context "$CTX"
  fi

  case "$LOWER" in
    *"in local scope"*|*"in global scope"*)
      cheatcode_install_match="in scope"
      ;;
    *install*)
      # Word-bounded install intent: an `install`/`installing` token AND a
      # capability object noun, EXCLUDING package-manager installs
      # (npm/bun/pip/... install → dependencies, never a cheatcode).
      if printf '%s' "$LOWER" | grep -E '\b(install|installing)\b' >/dev/null \
        && printf '%s' "$LOWER" | grep -E '\b(plugin|plugins|skill|skills|mcp|cheatcode|cheatcodes)\b' >/dev/null \
        && ! printf '%s' "$LOWER" | grep -E '\b(npm|npx|bun|yarn|pnpm|pip|pipx|brew|apt|apt-get|cargo|gem)[[:space:]]+install(ing)?\b' >/dev/null; then
        cheatcode_install_match="install capability"
      fi
      ;;
  esac

  if [ -n "$cheatcode_install_match" ]; then
    CTX="[tmb cheatcode-install routing] This is a cheatcode install, NOT agent/consultant creation. Record the per-candidate approval (cheatcode_approve) then call cheatcode_install with the requested scope (default local). Do NOT call agent_resolve / /tmb:agent-create for these names."
    emit_context "$CTX"
  fi
fi

# ---------------------------------------------------------------------------
# 1. consultant-spawn
#    Fires when: a word-bounded domain keyword AND a question/advisory shape
#    are both present, OR a known named-role is mentioned.
# ---------------------------------------------------------------------------
if [ "${TMB_DISABLE_CONSULTANT_HINT:-0}" != "1" ]; then

  DOMAIN=""
  NAMED_ROLE=""

  # Named-role check requires DB (consultant registry). Only run if DB exists.
  DB=$(tmb_db_path 2>/dev/null || true)
  if [ -n "$DB" ] && command -v sqlite3 >/dev/null 2>&1; then
    CONSULTANT_NAMES=$(tmb_sqlite_ro "$DB" "SELECT name FROM agents WHERE kind='consultant';")
    while IFS= read -r role; do
      [ -n "$role" ] || continue
      role_lc=$(printf '%s' "$role" | tr '[:upper:]' '[:lower:]')
      case "$LOWER" in
        *"${role_lc}'s read"*|*"${role_lc}'s view"*|*"${role_lc}'s take"*|\
        *"${role_lc} agent"*|*"the ${role_lc} "*|*"the ${role_lc}."*|*"the ${role_lc},"*)
          NAMED_ROLE="$role_lc"
          break
          ;;
      esac
    done <<EOF
$CONSULTANT_NAMES
EOF
  fi

  if [ -z "$NAMED_ROLE" ]; then
    # Advisory shape detector — must be present alongside a domain keyword.
    # More-specific patterns listed before their prefixes to avoid SC2221/SC2222.
    _has_advisory_shape() {
      case "$LOWER" in
        *"?"*) return 0 ;;
        *"should we use"*|*"should we keep"*|*"should we move"*|\
        *"should we commit to"*|*"should we"*|*"should i"*) return 0 ;;
        *"recommend"*) return 0 ;;
        *"trade-off"*|*"tradeoff"*) return 0 ;;
        *"your take"*|*"your view"*|*"your read"*) return 0 ;;
        *"which one"*|*"which of"*) return 0 ;;
        *"is it safe"*|*"is it ok"*|*"is it better"*) return 0 ;;
        *"implication"*) return 0 ;;
        *"better to use"*) return 0 ;;
      esac
      return 1
    }

    # Domain keyword check using word-boundary for substring-prone words.
    # security: substring-safe — "security" is already specific
    # performance/latency/etc: require word boundary on short stems
    # legal, architecture: no stemming issue
    _detect_domain() {
      case "$LOWER" in
        *"security"*|*"vulnerability"*|*"injection"*|*"xss"*|*"csrf"*|*"auth bypass"*)
          DOMAIN="security"; return 0 ;;
        *"latency"*|*"throughput"*|*"bottleneck"*|*"scaling"*|*" scale"*|*"benchmark"*)
          DOMAIN="perf"; return 0 ;;
        *"legal"*|*"licensing"*|*"compliance"*|*"gdpr"*|*"pii"*|*"copyright"*)
          DOMAIN="legal"; return 0 ;;
        *"architecture decision"*|*"design choice"*|*"adr"*|\
        *"architecture trade"*|*"architectural trade"*)
          DOMAIN="architect"; return 0 ;;
        *"json or sqlite"*|*"sqlite or postgres"*|*"postgres or sqlite"*|\
        *"sqlite vs postgres"*|*"sql or nosql"*)
          DOMAIN="architect"; return 0 ;;
      esac
      # Word-bounded check for short stems that appear inside longer words:
      #   "perf" inside "performance/perfect/performed"
      if has_word "perf" "$LOWER"; then
        DOMAIN="perf"; return 0
      fi
      return 1
    }

    if _detect_domain && _has_advisory_shape; then
      : # DOMAIN already set
    else
      DOMAIN=""
    fi
  fi

  if [ -n "$NAMED_ROLE" ]; then
    audit_consultant_spawn_nudged "named-role ${NAMED_ROLE}"
    CTX="[tmb consultant-spawn enforcement] The user's prompt names the \`${NAMED_ROLE}\` role. Invoke \`/tmb:agent-create ${NAMED_ROLE} <one-line restatement of the user question>\` — the command resolves the creation mode with agent_resolve, writes the agent file, registers it (the server audits the creation), and spawns the consultant in the same call. Bare \`Agent(subagent_type='${NAMED_ROLE}')\` without the command bypasses the registry; do NOT take that shortcut."
    emit_context "$CTX"
  elif [ -n "$DOMAIN" ]; then
    audit_consultant_spawn_nudged "domain ${DOMAIN}"
    CTX="[tmb consultant-spawn enforcement] The user's prompt looks like a \`${DOMAIN}\` judgment call. Invoke \`/tmb:agent-create <role> <one-line restatement>\` with the role that fits this domain (architect / cto / pm / legal-reviewer / a custom from-scratch role). The slash command resolves the creation mode with agent_resolve, writes the agent file, registers it (the server audits the creation), and spawns the consultant. Answering directly from general knowledge bypasses the consultant gate."
    emit_context "$CTX"
  fi
fi

# ---------------------------------------------------------------------------
# 2. search-grounding — decision-anchored patterns only
#    Drops: 'why is', 'why was', 'why are we' (bare debugging questions)
# ---------------------------------------------------------------------------
if [ "${TMB_DISABLE_SEARCH_HINT:-0}" != "1" ]; then
  matched=""
  for pat in \
    'why did we' 'why we chose' 'why we picked' 'why we decided' \
    'what was the rationale' 'what is the rationale' \
    'what did we decide' 'what was decided' 'what was our decision' \
    'how did we decide' 'when did we decide' \
    'rationale for' 'reasoning behind' \
    'past decision' 'prior decision' 'previous decision' \
    'find the discussion' 'search the discussion' 'search discussions' \
    'recall why' 'remind me why'; do
    case "$LOWER" in
      *"$pat"*)
        matched="$pat"
        break
        ;;
    esac
  done

  if [ -n "$matched" ]; then
    CTX="🔎 search-grounding hint: the user's prompt contains '${matched}' — a retrieval question over past decisions.

Prefer the *_search MCP tools over linear scans:
- \`discussion_search(query='<key terms>', mode='hybrid')\` returns ranked snippets across ALL issues (keyword + semantic). Use this first.
- \`audit_search(query='<key terms>')\` for event-history grounding.
- \`world_model_search(query='<key terms>')\` for code-context / project-structure grounding.

Only fall back to \`discussion_list(issue_id=N)\` / \`issue_get_with_discussions\` once \`discussion_search\` has narrowed the candidate set — those tools enumerate, they don't rank. Hybrid mode auto-falls-back to keyword if the embedding model is offline (\`warning: 'semantic_unavailable'\`)."
    emit_context "$CTX"
  fi
fi

# ---------------------------------------------------------------------------
# 3. concerns-protocol — doubt-class / weaken-gate phrases
# ---------------------------------------------------------------------------
if [ "${TMB_DISABLE_CONCERNS_HINT:-0}" != "1" ]; then
  matched=""
  for pat in \
    'delete the test' 'remove the test' 'skip the test' 'skip the tests' \
    'skip validation' 'skip verification' 'skip the gate' 'force push' \
    'ignore the gate' 'just do it' 'just push it' 'bypass the check' \
    'weaken the assertion' 'loosen the check' 'just delete' 'just remove' \
    'switch to approxequal' 'use approxequal' 'replace exact equality' \
    'change to approx' 'approxequal with tolerance'; do
    case "$LOWER_OPEN" in
      *"$pat"*)
        matched="$pat"
        break
        ;;
    esac
  done

  if [ -n "$matched" ]; then
    CTX="🚨 concerns-protocol hint: the user's prompt contains '${matched}'. This is a doubt-class request — load \`tmb_concerns-protocol\`. REQUIRED FIRST ACTION before any compliance, edit, or task creation: \`discussion_append(agent='bro', kind='note', body='Concern: …')\` recording what the request risks (or why it is pointless) and your recommendation. Then follow the protocol — hold for the Human's alignment; a documented decision is not a substitute for the Concern: record."
    emit_context "$CTX"
  fi
fi

# ---------------------------------------------------------------------------
# 4. push-intent — push/ship phrases; DB query on match
# ---------------------------------------------------------------------------
if [ "${TMB_DISABLE_PUSH_INTENT_HINT:-0}" != "1" ]; then
  matched=""
  for pat in \
    'git push' 'push it' 'push the work' 'push the branch' 'push the change' \
    'push up' 'push them up' 'push my work' 'ship it' 'ship the work' \
    'send it up' 'time to push'; do
    case "$LOWER_OPEN" in
      *"$pat"*)
        matched="$pat"
        break
        ;;
    esac
  done

  if [ -n "$matched" ]; then
    DB=$(tmb_db_path 2>/dev/null || true)
    if [ -n "$DB" ] && command -v sqlite3 >/dev/null 2>&1; then
      PENDING=$(tmb_sqlite_ro "$DB" "
        SELECT t.id || '|' || t.branch_id || '|' || substr(COALESCE(t.title, ''), 1, 60)
          FROM tasks t
         WHERE t.status IN ('needs_validation', 'completed', 'closed')
           AND t.commit_sha IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM validation_attempts v
              WHERE v.task_id = t.id
                AND v.verdict = 'pass'
           );
      ")

      if [ -n "$PENDING" ]; then
        PENDING_COUNT=$(printf '%s\n' "$PENDING" | wc -l | tr -d ' ')
        LIST=$(printf '%s\n' "$PENDING" | awk -F'|' '{ printf "  - task_id=%s  branch=%s  (%s)\n", $1, $2, $3 }')
        CTX="🚦 push-intent hint: the user's prompt contains '${matched}'. ${PENDING_COUNT} task(s) await code-reviewer signoff before push:

${LIST}

Before \`git push\`, spawn code-reviewer for each pending task via \`Agent(subagent_type='code-reviewer', isolation=)\` (no worktree — code-reviewer reviews from the main checkout). On all-pass verdicts the push will clear the git-push-guard. If you skip this, the guard will deny the push and you'll have to redo the work anyway."
        emit_context "$CTX"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 5. reonboard-intent — remote-setup, issue-tracker and branching-policy phrases; DB query on match
# ---------------------------------------------------------------------------
if [ "${TMB_DISABLE_REONBOARD_HINT:-0}" != "1" ]; then
  case "$LOWER" in
    */onboard*) : ;;
    *)
      matched=""
      for pat in \
        'available on github' 'available on gitlab' 'available on a remote' \
        'host on github' 'host on gitlab' 'host it on github' 'host it on gitlab' \
        'push to github' 'push to gitlab' 'put this on github' 'put this on gitlab' \
        'put it on github' 'put it on gitlab' 'publish to github' 'publish to gitlab' \
        'switch to remote' 'go remote' 'add a remote' 'set up a remote' \
        'set up the remote' 'add github remote' 'add gitlab remote' \
        'live on a remote' 'live on github' 'live on gitlab' \
        'lives on a remote' 'lives on github' 'lives on gitlab' \
        'needs to live on' 'needs a remote' \
        'change my issue tracker' 'switch issue tracker' \
        'switch to gitflow' 'switch to git-flow' 'switch to github-flow' \
        'switch to github flow' 'change branching model' \
        'change the branching model' 'switch branching model' \
        'change pr target' 'change the pr target' 'update pr target' \
        'update the pr target'; do
        case "$LOWER" in
          *"$pat"*)
            matched="$pat"
            break
            ;;
        esac
      done

      if [ -n "$matched" ]; then
        DB=$(tmb_db_path 2>/dev/null || true)
        if [ -n "$DB" ] && command -v sqlite3 >/dev/null 2>&1; then
          ONBOARDED=$(tmb_sqlite_ro "$DB" "SELECT 1 FROM plugin_config WHERE key='onboarded' AND value_json='true' LIMIT 1;")
          if [ "$ONBOARDED" = "1" ]; then
            CTX="🔁 reonboard-intent hint: the user's prompt contains '${matched}'. This signals a *reonboard* (project already onboarded — switching shape, not initial setup).

Policy/config mutations stay Human-gated. Route the Human to \`/onboard\` — do NOT call \`onboard_apply\` yourself.

REQUIRED FIRST ACTION — before any reply or git command: call \`onboard_state_get(agent='bro')\`. Your recommendation must cite the current config it returns (branching_model, pr_target, remotes); a reonboard answer composed without reading state is a workflow violation.

Then reply pointing the Human to \`/onboard\`. Do NOT spawn code work (no \`task_create_batch\`, no \`issue_create\`, no \`Agent\` for SWE) and do NOT wire remotes with raw git."
            emit_context "$CTX"
          fi
        fi
      fi
      ;;
  esac
fi

# ---------------------------------------------------------------------------
# 5b. headless-intent — claude -p / headless / CI-run phrases; DB query on match
# ---------------------------------------------------------------------------
# The number of PreToolUse entries the headless shim writes, from the shim's
# own countShimEntries; empty when node or the built server is missing.
headless_shim_entries() {
  local root="${CLAUDE_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
  local mod="$root/mcp/trajectory-server/dist/tools/onboard-hooks-shim.js"
  command -v node >/dev/null 2>&1 || return 0
  [ -f "$mod" ] || return 0
  node --input-type=module -e 'const [mod, root] = process.argv.slice(1); const { countShimEntries } = await import(mod); process.stdout.write(String(countShimEntries(root)));' "$mod" "$root" 2>/dev/null || true
}

if [ "${TMB_DISABLE_HEADLESS_HINT:-0}" != "1" ]; then
  case "$LOWER" in
    */onboard*) : ;;
    *)
      matched=""
      for pat in \
        'claude -p' 'claude --print' 'headless' 'non-interactive' 'noninteractive' \
        'in ci' 'ci run' 'ci pipeline' 'github actions' 'gitlab ci'; do
        re="(^|[^a-z0-9_])${pat}([^a-z0-9_]|\$)"
        if [[ "$LOWER" =~ $re ]]; then
          matched="$pat"
          break
        fi
      done

      if [ -n "$matched" ]; then
        DB=$(tmb_db_path 2>/dev/null || true)
        if [ -n "$DB" ] && command -v sqlite3 >/dev/null 2>&1; then
          WANTED=$(tmb_sqlite_ro "$DB" "SELECT 1 WHERE EXISTS (SELECT 1 FROM plugin_config WHERE key='onboarded' AND value_json='true') AND NOT EXISTS (SELECT 1 FROM plugin_config WHERE key='headless_enforcement' AND value_json='\"yes\"');")
          if [ "$WANTED" = "1" ]; then
            PROJECT=$(tmb_project_root)
            SETTINGS="${PROJECT:-<project>}/.claude/settings.local.json"
            ENTRIES=$(headless_shim_entries)
            WHAT="TMB's PreToolUse gate entries"
            [ -n "$ENTRIES" ] && WHAT="${ENTRIES} PreToolUse gate entries"
            CTX="🤖 headless-intent hint: the user's prompt contains '${matched}'. Plugin hooks do not fire in non-interactive \`claude -p\` runs, and headless enforcement is off for this project.

Ask ONE \`AskUserQuestion\` consent before anything else: may TMB write ${WHAT} into \`${SETTINGS}\` so its gates also run in \`claude -p\`? Name that file and the entry count in the question; if TMB creates the file in a git work tree, it is added to \`.gitignore\`.
- Yes → call \`onboard_apply(agent='bro', headless_enforcement='yes')\` and report \`applied.headless_shim\`.
- No → write nothing and carry on with the request.

Never call \`onboard_apply\` for this without the Human's answer."
            emit_context "$CTX"
          fi
        fi
      fi
      ;;
  esac
fi

# ---------------------------------------------------------------------------
# 6. resume-intent — keep-going / pick-up / continue phrases; DB query on match
# ---------------------------------------------------------------------------
if [ "${TMB_DISABLE_RESUME_HINT:-0}" != "1" ]; then
  matched=""
  for pat in \
    'keep going' 'pick it up' 'pick that up' 'pick this up' 'pick up' \
    "let's continue" 'continue the work' 'continue with' 'resume' \
    'finish that' 'finish the' 'finish it' 'wrap that up' 'wrap up' \
    'still pending' 'still open' 'still waiting'; do
    case "$LOWER_OPEN" in
      *"$pat"*)
        matched="$pat"
        break
        ;;
    esac
  done

  if [ -n "$matched" ]; then
    DB=$(tmb_db_path 2>/dev/null || true)
    if [ -n "$DB" ] && command -v sqlite3 >/dev/null 2>&1; then
      RESUME=$(tmb_sqlite_ro "$DB" "
        SELECT
          t.id,
          t.issue_id,
          COALESCE(t.branch_id, ''),
          replace(substr(COALESCE(t.title, ''), 1, 60), '|', '/'),
          substr(COALESCE(i.objective, ''), 1, 80)
        FROM tasks t
        JOIN issues i ON i.id = t.issue_id
        JOIN audit a ON a.issue_id = i.id AND a.event_type = 'planning_complete'
        WHERE t.status = 'pending'
          AND i.status = 'open'
        ORDER BY a.id DESC
        LIMIT 1;
      ")

      if [ -n "$RESUME" ]; then
        IFS='|' read -r task_id issue_id branch_id title objective <<< "$RESUME"
        CTX="↩️  resume-intent hint: the user's prompt contains '${matched}'. There's a pending task that already has \`planning_complete\` audit — resume that, do NOT create new tasks or replan.

  task_id=${task_id}
  issue_id=${issue_id}
  branch_id=${branch_id}
  title='${title}'
  issue.objective='${objective}'

Required workflow:
1. Call \`task_get(task_id=${task_id})\` to load the spec.
2. If the task has no worktree yet, call \`task_reopen(task_id=${task_id}, reason=\"resume planned task\")\`, which creates it; then spawn SWE via \`Agent(subagent_type='swe')\` with \`task_id=${task_id}\` in the prompt. Leave the main checkout on its current branch.
3. Do NOT call \`issue_create\` or \`task_create_batch\` — replanning is forbidden when planning_complete already exists for this work."
        emit_context "$CTX"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 7. adr-required — architectural intent; two-token checks (no dead globs)
# ---------------------------------------------------------------------------
if [ "${TMB_DISABLE_ADR_HINT:-0}" != "1" ]; then
  matched=""
  for pat in \
    'switch to clerk' 'switch to auth0' 'switch to okta' 'swap our auth' \
    'switch our auth' 'change our auth' 'migrate to postgres' 'migrate to mysql' \
    'migrate from postgres' 'migrate from mysql' 'switch to sqlite' \
    'switch to postgres' 'switch to mysql' 'migrate storage' 'swap our db' \
    'swap the db' 'switch our db' 'replace our db' \
    'introduce a new service' 'new service boundary' 'new module boundary' \
    'public api' 'new public api' 'change the public api' \
    'strategic stack' 'production db' 'retention policy' \
    'use react instead' 'use vue instead' 'use svelte instead' \
    'use fastapi instead' 'use django instead' 'use flask instead' \
    'replatform' \
    'extract the storage layer' 'extract the storage' 'storage interface' \
    'storage backend' 'backend interface' 'pluggable backend' \
    'pluggable storage' 'swap between' 'plugin loader' \
    'plugin architecture' 'dependency inversion'; do
    case "$LOWER_OPEN" in
      *"$pat"*)
        matched="$pat"
        break
        ;;
    esac
  done

  # Proximity checks on the unquoted prompt: the word `port` followed within
  # 6 words by `to`, the word `rewrite` followed within 6 words by `in`
  # ("report … to" and quoted text never match).
  if [ -z "$matched" ]; then
    matched=$(printf '%s' "$LOWER_OPEN" | tr '\n' ' ' | awk '
      {
        n = split($0, w, /[^a-z0-9]+/)
        for (i = 1; i <= n; i++) {
          if (w[i] == "port" || w[i] == "rewrite") {
            want = (w[i] == "port") ? "to" : "in"
            for (j = i + 1; j <= n && j <= i + 6; j++) if (w[j] == want) { print w[i] " ... " want; exit }
          }
        }
      }
    ')
  fi

  if [ -n "$matched" ]; then
    CTX="🏛️  architectural-change hint: the user's prompt contains '${matched}'. This change crosses TMB's architectural threshold — load \`tmb_planning\` and follow §\"Architectural changes\" before speccing the work."
    emit_context "$CTX"
  fi
fi

# ---------------------------------------------------------------------------
# 8. audit-intent — an ask to audit, verify, check or review an architecture;
#    whole-word match on the unquoted prompt ("verification" never matches)
# ---------------------------------------------------------------------------
if [ "${TMB_DISABLE_AUDIT_HINT:-0}" != "1" ]; then
  matched=""
  for word in audit verify double-check check architecture; do
    if has_word "$word" "$LOWER_OPEN"; then
      matched="$word"
      break
    fi
  done

  if [ -n "$matched" ]; then
    CTX="🔍 audit-intent hint: the user's prompt contains '${matched}'. Load \`tmb_audit\` and work outputs-first: name the component and the invariants its outputs must satisfy, test each against live data or a dry run before reading code, and report violations architecture-first with their evidence."
    emit_context "$CTX"
  fi
fi

exit 0
