#!/usr/bin/env bash
# L6 chain runner — drives ALL 13 journey rows sequentially through ONE
# cumulative trajectory DB. Rows live in tests/l5-l6/rows/ (canonical tree).
# State carries across rows via DB; see tests/EVALUATION.md for the journey spec
# and tests/l5-l6/l6-chain/chain-manifest.json for the step manifest.
# Row dirs are resolved as $HERE/<manifest.row_dir> where row_dir = "rows/...".
#
# Usage:
#   bash tests/l5-l6/run-l6-chain.sh                         # auto-resume (or fresh if nothing to resume)
#   bash tests/l5-l6/run-l6-chain.sh --fresh                 # force fresh full chain from row 1
#   bash tests/l5-l6/run-l6-chain.sh --from 7                # explicit resume from row 7
#   bash tests/l5-l6/run-l6-chain.sh --halt-on-fail 0        # don't halt on first fail
#
# Auto-resume: with no flag, the runner scans the most recent prior run's
# _results.jsonl for the first non-passing step and resumes from there,
# restoring its per-row immutable checkpoint (step-NN/checkpoint.db).
# Pass `--fresh` to override.
#
# Per-step logs land under ~/.claude/tmb/l6-chain-runs/<run-id>/
# (or $L6C_RUNS_DIR if set). Each step writes:
#   step-NN-name/
#     pre-state.sql      — DB snapshot before this row fired
#     user-input.txt     — the user prompt sent
#     bro-response.txt   — bro's text reply (last text block)
#     tool-uses.jsonl    — bro's tool_use entries this turn
#     post-state.sql     — DB snapshot after the row's turn
#     post-state.diff    — pre→post text diff
#     scorers.json       — per-scorer pass/fail
#     checkpoint.db      — immutable DB snapshot (passing rows only)
#     seed-applied.sql   — between-row seed (post-AUQ pseudo-data), if any

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
export PLUGIN_ROOT
export TMB_HEADLESS=1

MANIFEST="$HERE/l6-chain/chain-manifest.json"

START_FROM=""
HALT_ON_FAIL=1
FRESH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --from)         START_FROM="$2"; shift 2 ;;
    --halt-on-fail) HALT_ON_FAIL="$2"; shift 2 ;;
    --fresh)        FRESH=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  printf "❌ CLAUDE_CODE_OAUTH_TOKEN not set.\n" >&2
  exit 1
fi
for cmd in claude sqlite3 jq git diff; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf "❌ %s not found in PATH.\n" "$cmd" >&2
    exit 1
  fi
done
[ -f "$MANIFEST" ] || { printf "❌ manifest not found: %s\n" "$MANIFEST" >&2; exit 1; }

# shellcheck source=tests/l5-l6/lib/smoke-helpers.sh
. "$HERE/lib/smoke-helpers.sh"
l5_pre_flight_or_abort "$PLUGIN_ROOT"

# shellcheck source=tests/l5-l6/lib/l6-chain-helpers.sh
. "$HERE/lib/l6-chain-helpers.sh"

# shellcheck source=tests/l5-l6/lib/sandbox.sh
. "$HERE/lib/sandbox.sh"

RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
RUNS_ROOT="${L6C_RUNS_DIR:-$HOME/.claude/tmb/l6-chain-runs}"
RUN_DIR="$RUNS_ROOT/$RUN_ID"
mkdir -p "$RUN_DIR"
RESULTS_JSONL="$RUN_DIR/_results.jsonl"
: > "$RESULTS_JSONL"

printf '=== L6 chain run %s ===\n' "$RUN_ID"
printf '  manifest: %s\n' "$MANIFEST"
printf '  logs:     %s\n' "$RUN_DIR"

# Avoid sentinel pollution from prior CC sessions — per-step DBs use walk-up.
if [ -f "$HOME/.claude/tmb-active-workspace" ]; then
  cp "$HOME/.claude/tmb-active-workspace" "$HOME/.claude/tmb-active-workspace.l6-bak-$$" 2>/dev/null
  rm -f "$HOME/.claude/tmb-active-workspace"
fi

trap 'if [ -f "$HOME/.claude/tmb-active-workspace.l6-bak-$$" ]; then mv "$HOME/.claude/tmb-active-workspace.l6-bak-$$" "$HOME/.claude/tmb-active-workspace"; fi' EXIT

# Scratch project lives INSIDE the run dir so subsequent invocations can
# reuse the prior run's cumulative trajectory DB natively (the trajectory
# DB IS the resume mechanism — no special flag).
#
# Resume strategy (priority order):
# 1. Explicit `--fresh` → start from row 1, no inheritance.
# 2. Explicit `--from N` → inherit prior state for row N.
# 3. Default (no flag) → auto-detect: scan the most recent prior run's
#    _results.jsonl, find the first non-passing step, start from there.
#    If everything passed, start fresh from row 1.
#
# For any non-fresh start we prefer the prior run's per-row immutable
# checkpoint (step-(N-1)/checkpoint.db) over its live project — the
# checkpoint is the known-good post-row-(N-1) state, whereas the live
# project may carry partial writes from a crashed later row.
PROJECT="$RUN_DIR/project"

# Most recent prior run dir (excluding $RUN_DIR), sorted by mtime desc.
# Dual-platform stat: GNU stat -c on Linux, BSD stat -f on macOS.
l6c_find_recent_prior_runs() {
  while IFS= read -r d; do
    [ "$d" = "$RUN_DIR" ] && continue
    [ -d "$d" ] && echo "$d"
  done < <(find "$RUNS_ROOT" -mindepth 1 -maxdepth 1 -type d -print0 \
            | xargs -0 sh -c 'stat -c "%Y %n" "$@" 2>/dev/null || stat -f "%m %N" "$@" 2>/dev/null' -- \
            | sort -rn \
            | awk '{$1=""; sub(/^ /,""); print}')
}

l6c_first_nonpassing_step() {
  # Return the id of the first step that needs re-running. Two cases:
  # 1. A logged step has status != "✅ pass" → that id.
  # 2. The log is shorter than the manifest (setup.sh failed before
  #    the row could log, OR the runner was killed) → the first manifest
  #    id NOT present in the log.
  # Empty output means every manifest step is logged + passed.
  local results_file="$1"
  [ -f "$results_file" ] || return 0
  local scorer_fail
  scorer_fail=$(jq -r 'select(.status != "✅ pass") | .id' "$results_file" 2>/dev/null | head -1)
  if [ -n "$scorer_fail" ]; then
    echo "$scorer_fail"
    return 0
  fi
  # No scorer fail → compare manifest ids to logged ids.
  local manifest_ids logged_ids missing
  manifest_ids=$(jq -r '.steps[].id' "$MANIFEST" 2>/dev/null)
  logged_ids=$(jq -r '.id' "$results_file" 2>/dev/null | sort -n)
  missing=$(comm -23 <(echo "$manifest_ids" | sort -n) <(echo "$logged_ids") | head -1)
  echo "$missing"
}

# Auto-detect default --from N if not explicitly set.
if [ "$FRESH" = "1" ]; then
  START_FROM=1
elif [ -z "$START_FROM" ]; then
  AUTO_RESUME=""
  while IFS= read -r prior; do
    [ -z "$prior" ] && continue
    [ -f "$prior/_results.jsonl" ] || continue
    FIRST_FAIL=$(l6c_first_nonpassing_step "$prior/_results.jsonl")
    if [ -n "$FIRST_FAIL" ]; then
      AUTO_RESUME="$prior:$FIRST_FAIL"
    fi
    break
  done < <(l6c_find_recent_prior_runs)

  if [ -n "$AUTO_RESUME" ]; then
    PRIOR_DIR="${AUTO_RESUME%:*}"
    AUTO_FROM="${AUTO_RESUME##*:}"
    printf '  auto-resume: prior run %s halted at step %s; resuming from there\n' \
      "$(basename "$PRIOR_DIR")" "$AUTO_FROM"
    START_FROM="$AUTO_FROM"
  else
    START_FROM=1
  fi
fi

if [ "$START_FROM" -gt 1 ]; then
  # Resume: find the most recent prior run's checkpoint for step-(N-1).
  PRIOR_RUN=""
  while IFS= read -r prior; do
    [ -z "$prior" ] && continue
    PRIOR_RUN="$prior/"
    break
  done < <(l6c_find_recent_prior_runs)

  CHECKPOINT_DB=""
  CHECKPOINT_DIR=""
  if [ -n "${PRIOR_RUN:-}" ]; then
    PREV_STEP=$((START_FROM - 1))
    CHECKPOINT_DIR=$(find "$PRIOR_RUN" -mindepth 1 -maxdepth 1 -type d \
      -name "step-$(printf '%02d' "$PREV_STEP")-*" 2>/dev/null | head -1)
    if [ -n "$CHECKPOINT_DIR" ] && [ -f "$CHECKPOINT_DIR/checkpoint.db" ]; then
      CHECKPOINT_DB="$CHECKPOINT_DIR/checkpoint.db"
    fi
  fi

  CHECKPOINT_TAR=""
  if [ -n "$CHECKPOINT_DIR" ] && [ -f "$CHECKPOINT_DIR/checkpoint-project.tar" ]; then
    CHECKPOINT_TAR="$CHECKPOINT_DIR/checkpoint-project.tar"
  fi

  if [ -n "$CHECKPOINT_DB" ] && [ -n "$CHECKPOINT_TAR" ]; then
    printf '  resume:   --from %d restoring step-%02d checkpoint (db + project tree) from %s\n' \
      "$START_FROM" "$PREV_STEP" "$(basename "$PRIOR_RUN")"
    mkdir -p "$(dirname "$PROJECT")"
    tar -C "$(dirname "$PROJECT")" -xf "$CHECKPOINT_TAR"
    cp "$CHECKPOINT_DB" "$PROJECT/.claude/tmb/trajectory.db"
  elif [ -n "$CHECKPOINT_DB" ]; then
    printf '  resume:   --from %d restoring step-%02d checkpoint (db only — no project tar; git-dependent steps may fail) from %s\n' \
      "$START_FROM" "$PREV_STEP" "$(basename "$PRIOR_RUN")"
    mkdir -p "$PROJECT/.claude/tmb"
    (
      cd "$PROJECT" || exit 1
      git init -q -b main
      git config user.email l6@l6.test
      git config user.name "L6 Test"
      echo "init" > README.md
      printf '.claude/\n' > .gitignore
      git add . && git commit -qm init
    )
    cp "$CHECKPOINT_DB" "$PROJECT/.claude/tmb/trajectory.db"
  elif [ -n "${PRIOR_RUN:-}" ] && [ -d "${PRIOR_RUN}project" ]; then
    printf '  resume:   --from %d no checkpoint for step-%02d; falling back to live project from %s\n' \
      "$START_FROM" "$((START_FROM - 1))" "$(basename "$PRIOR_RUN")"
    cp -R "${PRIOR_RUN}project" "$PROJECT"
  else
    printf '  ⚠ --from %d but no prior run with checkpoint or project found; starting from empty state (standalone-row mode)\n' "$START_FROM" >&2
    SCRATCH=$(l5_setup_scratch_project)
    mv "$SCRATCH" "$PROJECT"
  fi
else
  # Full run: fresh project. Mirror l5_setup_scratch_project's init steps
  # but put the project inside RUN_DIR so it survives for later resumes.
  mkdir -p "$PROJECT"
  (
    cd "$PROJECT" || exit 1
    git init -q -b main
    git config user.email l6@l6.test
    git config user.name "L6 Test"
    echo "init" > README.md
    printf '.claude/\n' > .gitignore
    git add . && git commit -qm init
    mkdir -p .claude/tmb
  )
fi

INITIAL_FIXTURE=$(jq -r '.initial_fixture' "$MANIFEST")
printf '  fixture:  %s\n' "$INITIAL_FIXTURE"
if [ "$START_FROM" -eq 1 ]; then
  l5_seed_db "$PROJECT" "$INITIAL_FIXTURE" || { printf "❌ fixture seed failed\n" >&2; exit 1; }
fi

printf '  mode:     fresh `claude -p` per row (DB-driven resume)\n'
printf '\n'

CHAIN_TRAJECTORY="$RUN_DIR/chain-trajectory.jsonl"
: > "$CHAIN_TRAJECTORY"

STEP_COUNT=$(jq -r '.steps | length' "$MANIFEST")
CHAIN_PASS=0
CHAIN_FAIL=0

for idx in $(seq 0 $((STEP_COUNT - 1))); do
  step_id=$(jq -r ".steps[$idx].id"   "$MANIFEST")
  step_name=$(jq -r ".steps[$idx].name" "$MANIFEST")
  row_rel=$(jq -r ".steps[$idx].row_dir" "$MANIFEST")
  seed_before=$(jq -r ".steps[$idx].seed_before // empty" "$MANIFEST")
  seed_after=$(jq -r  ".steps[$idx].seed_after  // empty" "$MANIFEST")
  halt_step=$(jq -r   ".steps[$idx].halt_on_fail" "$MANIFEST")
  chain_setup_cmd=$(jq -r ".steps[$idx].chain_setup_command // empty" "$MANIFEST")
  chain_post_cmd=$(jq -r  ".steps[$idx].chain_post_command  // empty" "$MANIFEST")

  if [ "$step_id" -lt "$START_FROM" ]; then
    printf -- "── step %d (%s): SKIP (before --from)\n" "$step_id" "$step_name"
    continue
  fi

  ROW_DIR="$HERE/$row_rel"
  if [ ! -d "$ROW_DIR" ]; then
    printf "  ✗ step %d: row dir missing: %s\n" "$step_id" "$ROW_DIR" >&2
    CHAIN_FAIL=$((CHAIN_FAIL + 1))
    [ "$HALT_ON_FAIL" = "1" ] && [ "$halt_step" = "true" ] && break
    continue
  fi

  STEP_DIR=$(printf "%s/step-%02d-%s" "$RUN_DIR" "$step_id" "${step_name#[0-9][0-9]-}")
  mkdir -p "$STEP_DIR"
  printf "\n── step %d (%s) ──\n" "$step_id" "$step_name"

  if [ -n "$seed_before" ] && [ "$seed_before" != "null" ]; then
    SEED_BEFORE_PATH="$HERE/l6-chain/$seed_before"
    printf "  seed_before: %s\n" "$seed_before"
    l6c_apply_seed "$PROJECT" "$SEED_BEFORE_PATH"
    cp "$SEED_BEFORE_PATH" "$STEP_DIR/seed-before.sql" 2>/dev/null || true
  fi

  # chain_setup_command — shell command run in $PROJECT before bro's turn.
  # Use for chain-only state shape that's NOT a real-world doctrine action
  # (e.g. `git checkout feat/X` to expose work-branch files when prior step
  # left them on a non-HEAD branch). L5 isolation skips this — the row's
  # setup-l5.sh constructs the same shape from scratch.
  if [ -n "$chain_setup_cmd" ] && [ "$chain_setup_cmd" != "null" ]; then
    printf "  chain_setup_command: %s\n" "$chain_setup_cmd"
    ( cd "$PROJECT" && eval "$chain_setup_cmd" ) >> "$STEP_DIR/chain-setup.log" 2>&1 \
      || printf "  ⚠ chain_setup_command exited non-zero (continuing)\n" >&2
  fi

  l6c_snapshot_db "$PROJECT" "$STEP_DIR/pre-state.sql"
  cp "$PROJECT/.claude/tmb/trajectory.db" "$PROJECT/.claude/tmb/_l6_pre_step.db" 2>/dev/null || true
  cp "$ROW_DIR/prompt.txt" "$STEP_DIR/user-input.txt"

  # If plugin_config.pr_target points at a branch that doesn't exist in
  # git, create it from main. The chain seeds flip pr_target mid-chain
  # (e.g. row 3 → gitflow → dev) but seeds are SQL-only and can't create
  # git branches. Without this, bro stalls in row 4 with a config-vs-git
  # mismatch ("dev branch demanded but doesn't exist").
  cfg_pr_target=$(sqlite3 "$PROJECT/.claude/tmb/trajectory.db" \
    "SELECT json_extract(value_json, '$') FROM plugin_config WHERE key='pr_target';" 2>/dev/null)
  cfg_pr_target="${cfg_pr_target:-main}"
  if [ -n "$cfg_pr_target" ] && ! git -C "$PROJECT" rev-parse --verify "$cfg_pr_target" >/dev/null 2>&1; then
    if git -C "$PROJECT" rev-parse --verify main >/dev/null 2>&1; then
      git -C "$PROJECT" branch "$cfg_pr_target" main 2>/dev/null || true
      printf "  ensured branch '%s' exists (from main)\n" "$cfg_pr_target"
    fi
  fi

  # Write the pre-run git snapshot the git scorer reads. Capture the
  # HEAD of pr_target (NOT current branch HEAD) so the scorer's pre/post
  # comparison is meaningful when pr_target changed mid-chain.
  if git -C "$PROJECT" rev-parse HEAD >/dev/null 2>&1; then
    pre_head=$(git -C "$PROJECT" rev-parse "$cfg_pr_target" 2>/dev/null \
              || git -C "$PROJECT" rev-parse HEAD 2>/dev/null \
              || echo "")
    pre_branch="$cfg_pr_target"
    mkdir -p "$PROJECT/.claude/tmb"
    printf '{"head":"%s","branch":"%s"}\n' "$pre_head" "$pre_branch" \
      > "$PROJECT/.claude/tmb/_l5_pre_run_git.json"
  fi

  # Run the step. Each step starts a *fresh* CC session (no --resume from
  # the prior step) — cross-row continuity is DB-driven via bro's
  # tmb_recovery + state-aware MCPs. WITHIN a step the row's script.json
  # drives a multi-turn conversation via a step-local --session-id;
  # without this rows 8/9 (which expect a follow-up user reply) can't
  # complete because bro asks for clarification and the chain would
  # otherwise move on before the answer arrives.
  TURN_JSONL="$STEP_DIR/turn.jsonl"
  printf "  step: fresh session, multi-turn within step (DB-driven across steps)\n"
  tmb_test_sandbox_init "$PROJECT"
  l6c_run_step "$PROJECT" "$ROW_DIR" "$TURN_JSONL"
  tmb_test_sandbox_teardown

  cat "$TURN_JSONL" >> "$CHAIN_TRAJECTORY"
  # Per-step scoring reads $PROJECT/trajectory.jsonl. Required/forbidden
  # tool checks should reflect THIS row's behaviour, not the cumulative
  # chain — point trajectory.jsonl at just this turn's jsonl. The full
  # chain log is preserved separately at $CHAIN_TRAJECTORY for debugging.
  cp "$TURN_JSONL" "$PROJECT/trajectory.jsonl"

  jq -r 'select(.type=="assistant") | .message.content[] | select(.type=="text") | .text' \
    "$TURN_JSONL" 2>/dev/null | tail -c 4000 > "$STEP_DIR/bro-response.txt" || true
  jq -c 'select(.type=="assistant") | .message.content[] | select(.type=="tool_use")' \
    "$TURN_JSONL" 2>/dev/null > "$STEP_DIR/tool-uses.jsonl" || true

  l6c_snapshot_db "$PROJECT" "$STEP_DIR/post-state.sql"
  diff -u "$STEP_DIR/pre-state.sql" "$STEP_DIR/post-state.sql" > "$STEP_DIR/post-state.diff" 2>/dev/null || true

  TOKENS=$(jq -s 'map(select(.type=="result") | (.usage.input_tokens // 0) + (.usage.output_tokens // 0)) | add // 0' \
    "$TURN_JSONL" 2>/dev/null || echo 0)
  DURATION_MS=$(jq -s 'map(select(.type=="result") | .duration_ms // 0) | add // 0' \
    "$TURN_JSONL" 2>/dev/null || echo 0)

  # Score this step against the cumulative DB. Export the env vars
  # explicitly so they're visible inside the subshells spawned by
  # l6c_score_step (an inline `VAR=val cmd` only seeds the immediate
  # child process; the scorer's internal subshells don't see it).
  export SCENARIO_NAME="$step_name"
  STEP_FAILS=0
  l6c_score_step "$PROJECT" "$step_name" "$ROW_DIR" "$RUN_ID" \
    > "$STEP_DIR/scorers.txt" 2>&1 || STEP_FAILS=$?

  # Minimal scorers.json for chain-summary parsing.
  jq -n --arg id "$step_id" --arg name "$step_name" --arg fails "$STEP_FAILS" \
        --arg tokens "$TOKENS" --arg duration "$DURATION_MS" \
        '{id: ($id|tonumber), name: $name, scorer_fails: ($fails|tonumber), tokens: ($tokens|tonumber), duration_ms: ($duration|tonumber)}' \
    > "$STEP_DIR/scorers.json"

  if [ "$STEP_FAILS" -eq 0 ]; then
    STATUS='✅ pass'
    CHAIN_PASS=$((CHAIN_PASS + 1))
    printf "  ✓ step %d passed (tokens=%s duration=%sms)\n" "$step_id" "$TOKENS" "$DURATION_MS"
  else
    STATUS='❌ fail'
    CHAIN_FAIL=$((CHAIN_FAIL + 1))
    printf "  ✗ step %d failed (%s scorer fails)\n" "$step_id" "$STEP_FAILS"
  fi

  jq -nc --arg id "$step_id" --arg name "$step_name" --arg status "$STATUS" \
        --arg fails "$STEP_FAILS" --arg tokens "$TOKENS" --arg duration "$DURATION_MS" \
        '{id: ($id|tonumber), name: $name, status: $status, scorer_fails: ($fails|tonumber), tokens: ($tokens|tonumber), duration_ms: ($duration|tonumber)}' \
    >> "$RESULTS_JSONL"

  if [ "$STEP_FAILS" -ne 0 ] && [ "$HALT_ON_FAIL" = "1" ] && [ "$halt_step" = "true" ]; then
    printf "  ── halting chain at first failure (per step manifest halt_on_fail) ──\n"
    break
  fi

  if [ -n "$seed_after" ] && [ "$seed_after" != "null" ]; then
    SEED_AFTER_PATH="$HERE/l6-chain/$seed_after"
    printf "  seed_after: %s\n" "$seed_after"
    l6c_apply_seed "$PROJECT" "$SEED_AFTER_PATH"
    cp "$SEED_AFTER_PATH" "$STEP_DIR/seed-applied.sql" 2>/dev/null || true
  fi

  # chain_post_command — shell command run in $PROJECT AFTER bro's turn (and
  # after seed_after if present). Use for chain-only state transitions that
  # simulate something that happens BETWEEN bro sessions in production but
  # isn't bro's responsibility. Canonical example: after step 07 push, a
  # human reviewer merges the PR — this advances `dev` to the feature branch
  # in production via the remote merge. In the test sandbox there's no
  # remote-side merge, so chain_post_command does the fast-forward locally.
  # L5 isolation skips this (each row has its own setup-l5 substrate).
  if [ -n "$chain_post_cmd" ] && [ "$chain_post_cmd" != "null" ]; then
    printf "  chain_post_command: %s\n" "$chain_post_cmd"
    ( cd "$PROJECT" && eval "$chain_post_cmd" ) >> "$STEP_DIR/chain-post.log" 2>&1 \
      || printf "  ⚠ chain_post_command exited non-zero (continuing)\n" >&2
  fi

  # Per-row immutable checkpoint: snapshot the live trajectory DB and
  # the entire project tree AFTER the row passed + any seed_after applied.
  # Resumes from row N restore step-(N-1)/checkpoint.db + checkpoint-project.tar
  # rather than copying the live project (which could be mid-write if a
  # later row crashed). Only on pass — failed rows leave no checkpoint,
  # so a resume from a failed row naturally falls back to the previous
  # row's good state.
  if [ "$STEP_FAILS" -eq 0 ]; then
    cp "$PROJECT/.claude/tmb/trajectory.db" "$STEP_DIR/checkpoint.db" 2>/dev/null || true
    tar -C "$(dirname "$PROJECT")" -cf "$STEP_DIR/checkpoint-project.tar" "$(basename "$PROJECT")" 2>/dev/null || true
  fi
done

l6c_write_chain_summary "$RUN_DIR" "$RESULTS_JSONL"

printf "\n========================================\n"
printf "L6 chain: %d passed, %d failed\n" "$CHAIN_PASS" "$CHAIN_FAIL"
printf "Logs:     %s\n" "$RUN_DIR"
printf "Summary:  %s/chain-summary.md\n" "$RUN_DIR"

[ "$CHAIN_FAIL" = "0" ] && exit 0 || exit 1
