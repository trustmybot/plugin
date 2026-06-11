#!/usr/bin/env bash
# UserPromptSubmit hook — dispatcher for all intent-hint pattern classes.
#
# Reads stdin once, lowercases once, then walks a pattern-to-handler table.
# Each pattern class can emit one additionalContext block; the first class
# that fires wins (patterns are checked in priority order).
#
# Pattern classes handled:
#   consultant-spawn — domain-expert keyword + question/advisory shape required
#   search-grounding — decision-retrieval questions (decision-anchored only)
#   concerns-protocol — doubt-class / weaken-gate phrases
#   push-intent      — push/ship phrases (DB query on match)
#   reonboard-intent — remote-setup / host-on phrases (DB query on match)
#   resume-intent    — keep-going / pick-up / continue phrases (DB query on match)
#   adr-required     — architectural intent (two-token checks)
#
# Bypass env vars forwarded: TMB_DISABLE_SEARCH_HINT, TMB_DISABLE_CONCERNS_HINT,
# TMB_DISABLE_PUSH_INTENT_HINT, TMB_DISABLE_REONBOARD_HINT, TMB_DISABLE_RESUME_HINT,
# TMB_DISABLE_ADR_HINT.
#
# Silent on failure; advisory hooks never exit non-zero.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0

PROMPT_RAW=$(printf '%s' "$INPUT" | jq -r '.prompt // ""' 2>/dev/null)
[ -n "$PROMPT_RAW" ] || exit 0

LOWER=$(printf '%s' "$PROMPT_RAW" | tr '[:upper:]' '[:lower:]')

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
    CONSULTANT_NAMES=$(sqlite3 "$DB" \
      "SELECT name FROM agents WHERE kind='consultant' AND status='active';" \
      2>/dev/null || true)
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
    CTX="[tmb consultant-spawn enforcement] The user's prompt names the \`${NAMED_ROLE}\` role. Invoke \`/tmb:agent-create ${NAMED_ROLE} <one-line restatement of the user question>\` — the command runs the full agent_list + Branch A/B/C ceremony AND spawns the consultant in the same call. Bare \`Agent(subagent_type='${NAMED_ROLE}')\` without the command bypasses the registry; do NOT take that shortcut."
    emit_context "$CTX"
  elif [ -n "$DOMAIN" ]; then
    CTX="[tmb consultant-spawn enforcement] The user's prompt looks like a \`${DOMAIN}\` judgment call. Invoke \`/tmb:agent-create <role> <one-line restatement>\` with the role that fits this domain (architect / cto / pm / legal-reviewer / a custom from-scratch role). The slash command handles the full ceremony — agent_list lookup, Branch A/B/C routing, audit, spawn — deterministically. Answering directly from general knowledge bypasses the consultant gate."
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
    case "$LOWER" in
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
      PENDING=$(sqlite3 "$DB" "
        SELECT t.id || '|' || t.branch_id || '|' || substr(COALESCE(t.title, ''), 1, 60)
          FROM tasks t
         WHERE t.status IN ('needs_validation', 'completed', 'closed')
           AND t.commit_sha IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM validation_attempts v
              WHERE v.task_id = t.id
                AND v.verdict = 'pass'
           );
      " 2>/dev/null || true)

      if [ -n "$PENDING" ]; then
        PENDING_COUNT=$(printf '%s\n' "$PENDING" | wc -l | tr -d ' ')
        LIST=$(printf '%s\n' "$PENDING" | awk -F'|' '{ printf "  - task_id=%s  branch=%s  (%s)\n", $1, $2, $3 }')
        CTX="🚦 push-intent hint: the user's prompt contains '${matched}'. ${PENDING_COUNT} task(s) await pr-reviewer signoff before push:

${LIST}

Before \`git push\`, spawn pr-reviewer for each pending task via \`Agent(subagent_type='pr-reviewer', isolation=)\` (no worktree — pr-reviewer reviews from the main checkout). On all-pass verdicts the push will clear the git-push-guard. If you skip this, the guard will deny the push and you'll have to redo the work anyway."
        emit_context "$CTX"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 5. reonboard-intent — remote-setup phrases; DB query on match
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
        'change my issue tracker' 'switch issue tracker'; do
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
          ONBOARDED=$(sqlite3 "$DB" "SELECT 1 FROM plugin_config WHERE key='onboarded' AND value_json='true' LIMIT 1;" 2>/dev/null || true)
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
# 6. resume-intent — keep-going / pick-up / continue phrases; DB query on match
# ---------------------------------------------------------------------------
if [ "${TMB_DISABLE_RESUME_HINT:-0}" != "1" ]; then
  matched=""
  for pat in \
    'keep going' 'pick it up' 'pick that up' 'pick this up' 'pick up' \
    "let's continue" 'continue the work' 'continue with' 'resume' \
    'finish that' 'finish the' 'finish it' 'wrap that up' 'wrap up' \
    'still pending' 'still open' 'still waiting'; do
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
      RESUME=$(sqlite3 -separator $'\x1f' "$DB" "
        SELECT
          t.id,
          t.issue_id,
          t.branch_id,
          substr(COALESCE(t.title, ''), 1, 60),
          substr(COALESCE(i.objective, ''), 1, 80)
        FROM tasks t
        JOIN issues i ON i.id = t.issue_id
        JOIN audit a ON a.issue_id = i.id AND a.event_type = 'planning_complete'
        WHERE t.status = 'pending'
          AND i.status = 'open'
        ORDER BY a.id DESC
        LIMIT 1;
      " 2>/dev/null || true)

      if [ -n "$RESUME" ]; then
        IFS=$'\x1f' read -r task_id issue_id branch_id title objective <<< "$RESUME"
        CTX="↩️  resume-intent hint: the user's prompt contains '${matched}'. There's a pending task that already has \`planning_complete\` audit — resume that, do NOT create new tasks or replan.

  task_id=${task_id}
  issue_id=${issue_id}
  branch_id=${branch_id}
  title='${title}'
  issue.objective='${objective}'

Required workflow:
1. Call \`task_get(task_id=${task_id})\` to load the spec.
2. \`git switch ${branch_id}\` (or create from main if missing) and spawn SWE via \`Agent(subagent_type='swe')\` with the existing task_id.
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
    case "$LOWER" in
      *"$pat"*)
        matched="$pat"
        break
        ;;
    esac
  done

  # Two-token checks (replacing dead 'rewrite ... in' / 'port ... to' literal globs).
  # Match "rewrite" anywhere AND " in " or " in" at end of string.
  # Match "port " (noun-form, not "report") AND " to " or " to" at end.
  if [ -z "$matched" ]; then
    case "$LOWER" in
      *"rewrite"*)
        case "$LOWER" in
          *" in "*|*" in") matched="rewrite ... in" ;;
        esac
        ;;
    esac
    if [ -z "$matched" ]; then
      case "$LOWER" in
        *"port "*)
          case "$LOWER" in
            *" to "*|*" to") matched="port ... to" ;;
          esac
          ;;
      esac
    fi
  fi

  if [ -n "$matched" ]; then
    CTX="🏛️  architectural-change hint: the user's prompt contains '${matched}'. This change crosses TMB's architectural threshold — load \`tmb_planning\` and follow §\"Architectural changes\" before speccing the work."
    emit_context "$CTX"
  fi
fi

exit 0
