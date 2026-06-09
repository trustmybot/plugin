#!/usr/bin/env bash
# Parameterized SWE-bench Lite setup + verify runner.
#
# Per-task scaffolding is task.json + test_patch.diff + prompt.txt.
# Per-task setup.sh and verify.sh are thin wrappers that exec this lib:
#
#   setup.sh:  exec "$PLUGIN_ROOT/tests/l7/lib/swebench-runner.sh" setup "$@"
#   verify.sh: exec "$PLUGIN_ROOT/tests/l7/lib/swebench-runner.sh" verify "$@"
#
# task.json fields (all string unless noted):
#   id                 — SWE-bench Lite instance_id (e.g. "pallets__flask-4045")
#   repo               — GitHub slug ("pallets/flask")
#   base_commit        — buggy SHA the agent edits
#   python_version     — Python pin for uv venv (default "3.9", matches SWE-bench
#                        eval config). Required for fair comparison with the
#                        published Sonnet leaderboard — they use per-task
#                        Docker images with this exact Python.
#   fail_to_pass[]     — array of "tests/path::test_name" — load-bearing
#   pass_to_pass_sample[] — array of regression checks (3-5 is plenty)
#   env_install_cmd    — optional bash command (default: "pip install -e . --quiet")
#   pythonpath         — optional, e.g. "src" for Flask's src layout
#   test_patch_file    — defaults to "test_patch.diff" relative to task dir
set -uo pipefail

MODE="${1:?usage: swebench-runner.sh setup|verify <project> <task-dir>}"
PROJECT="${2:?project dir required}"
TASK_DIR="${3:?task dir required}"

TASK_JSON="$TASK_DIR/task.json"
if [ ! -f "$TASK_JSON" ]; then
  echo "swebench-runner: $TASK_JSON not found" >&2
  exit 2
fi

field() { jq -r --arg k "$1" '.[$k] // ""' "$TASK_JSON"; }
field_array() { jq -r --arg k "$1" '.[$k][]?' "$TASK_JSON"; }

REPO=$(field repo)
BASE_COMMIT=$(field base_commit)
PYTHON_VERSION=$(field python_version)
[ -z "$PYTHON_VERSION" ] && PYTHON_VERSION="3.9"
ENV_INSTALL_CMD=$(field env_install_cmd)
[ -z "$ENV_INSTALL_CMD" ] && ENV_INSTALL_CMD="pip install -e . --quiet"
PYPATH=$(field pythonpath)
PATCH_FILE=$(field test_patch_file)
[ -z "$PATCH_FILE" ] && PATCH_FILE="test_patch.diff"

case "$MODE" in
  setup)
    if [ -z "$REPO" ] || [ -z "$BASE_COMMIT" ]; then
      echo "swebench-runner: task.json missing repo or base_commit" >&2
      exit 2
    fi

    # Per runner contract we own $PROJECT — wipe so git clone can populate.
    # Do NOT mkdir afterward: git refuses to clone into a non-empty dir, and
    # bash 3.2 + macOS sometimes lands stray .DS_Store files in newly-created
    # mktemp dirs that look "non-empty" to git.
    rm -rf "$PROJECT"

    REPO_URL="https://github.com/${REPO}"
    if ! git clone --quiet --depth=1 "$REPO_URL" "$PROJECT" 2>/tmp/swebench-clone.err; then
      echo "swebench-runner: clone of $REPO_URL failed" >&2
      cat /tmp/swebench-clone.err >&2 2>/dev/null || true
      exit 1
    fi

    (
      cd "$PROJECT" || exit 1
      git fetch --depth=1 origin "$BASE_COMMIT" 2>&1
      git checkout -q "$BASE_COMMIT"
    ) || {
      echo "swebench-runner: checkout of $BASE_COMMIT failed" >&2
      exit 1
    }

    if [ -f "$TASK_DIR/$PATCH_FILE" ]; then
      (
        cd "$PROJECT" || exit 1
        if ! git apply --whitespace=nowarn "$TASK_DIR/$PATCH_FILE" 2>&1; then
          echo "swebench-runner: git apply of $PATCH_FILE failed — trying patch -p1" >&2
          patch -p1 < "$TASK_DIR/$PATCH_FILE" || {
            echo "swebench-runner: patch -p1 also failed" >&2
            exit 1
          }
        fi
      ) || exit 1
    fi

    # Per-task venv at $PROJECT/.bench-venv with Python pinned via uv.
    # This matches SWE-bench's per-task Docker images — same Python version,
    # same isolation — without needing Docker. uv auto-downloads the pinned
    # Python if it's not present on the host.
    if ! command -v uv >/dev/null 2>&1; then
      echo "swebench-runner: uv not found — install via 'brew install uv' or 'pip install uv'" >&2
      exit 1
    fi
    (
      cd "$PROJECT" || exit 1
      if ! uv venv .bench-venv --python "$PYTHON_VERSION" --quiet 2>&1 | tail -3 >&2; then
        echo "swebench-runner: uv venv (python $PYTHON_VERSION) failed" >&2
        exit 1
      fi
      # Make the venv's bin first in PATH so env_install_cmd resolves to
      # the venv's pip + python.
      export PATH="$PROJECT/.bench-venv/bin:$PATH"
      export VIRTUAL_ENV="$PROJECT/.bench-venv"
      uv pip install --quiet --upgrade pip setuptools wheel 2>&1 | tail -3 >&2 || true

      # Run the task's env_install_cmd. Task.json may include env-var
      # prefixes (e.g. SETUPTOOLS_SCM_PRETEND_VERSION_FOR_PYTEST=7.0.0)
      # to coax setuptools-scm into reporting a sensible version for
      # editable installs without git tags.
      if ! bash -c "$ENV_INSTALL_CMD" 2>&1 | tail -10 >&2; then
        echo "swebench-runner: env_install_cmd had issues — verify may fail" >&2
      fi

      # Always ensure pytest is in the venv (some repos don't pin it).
      uv pip install --quiet pytest 2>&1 | tail -3 >&2 || true
    ) || exit 1

    # Reset git so apply-scorer has a clean baseline. The venv lives
    # outside .git via .gitignore (it'd be huge).
    (
      cd "$PROJECT" || exit 1
      rm -rf .git
      git init -q -b main
      git config user.email bench@bench.test
      git config user.name "TMB Bench"
      cat > .gitignore <<EOF
.claude/
.bench-venv/
__pycache__/
*.pyc
.pytest_cache/
*.egg-info/
.venv/
EOF
      mkdir -p .claude/tmb
      git add -A
      git commit -qm "test: seed $(jq -r .id "$TASK_JSON") (base + test patch + venv)"
    ) >/dev/null

    echo "swebench-runner: seeded $REPO @ ${BASE_COMMIT:0:8} + test_patch + .bench-venv"
    ;;

  verify)
    cd "$PROJECT" || exit 2

    # Prefer the per-task venv's python (matches what the agent used).
    # Critically: invoke via `python -m pytest` (not the pytest binary) so
    # sys.path[0] = $PROJECT, matching how an agent inside $PROJECT would
    # naturally run tests. The bare `pytest` binary's shebang puts
    # .bench-venv/bin at sys.path[0], which breaks plugin discovery for
    # repos that ship their own importable plugins (e.g. pylint reporters).
    # This was a real false-negative source pre-fix.
    if [ -x "$PROJECT/.bench-venv/bin/python" ]; then
      export PATH="$PROJECT/.bench-venv/bin:$PATH"
      PYTEST_CMD="$PROJECT/.bench-venv/bin/python -m pytest"
    else
      PYTEST_CMD="python3 -m pytest"
    fi
    if ! $PYTEST_CMD --version >/dev/null 2>&1; then
      echo "verify: pytest not invokable via '$PYTEST_CMD'" >&2
      exit 2
    fi

    [ -n "$PYPATH" ] && export PYTHONPATH="$PROJECT/$PYPATH${PYTHONPATH:+:$PYTHONPATH}"

    # Portable array fill — macOS /bin/bash is 3.2 and has no mapfile.
    FTP=()
    while IFS= read -r line; do
      [ -n "$line" ] && FTP+=("$line")
    done < <(field_array fail_to_pass)
    PTP=()
    while IFS= read -r line; do
      [ -n "$line" ] && PTP+=("$line")
    done < <(field_array pass_to_pass_sample)

    if [ "${#FTP[@]}" -eq 0 ]; then
      echo "verify: task.json fail_to_pass is empty" >&2
      exit 2
    fi

    run_pytest() { $PYTEST_CMD -q --no-header "$@" 2>&1; }

    # First attempt — straight pytest. If imports fail, run env_install_cmd
    # and retry. Keeps the install side-effect lazy: tasks that don't need
    # it don't pay for it.
    OUTPUT=$(run_pytest "${FTP[@]}")
    EC=$?
    if [ $EC -ne 0 ] && echo "$OUTPUT" | grep -qE "ModuleNotFoundError|ImportError|file or directory not found"; then
      echo "verify: pytest failed with import/file error — running env_install_cmd: $ENV_INSTALL_CMD" >&2
      bash -c "$ENV_INSTALL_CMD" >&2 2>&1 || true
      OUTPUT=$(run_pytest "${FTP[@]}")
      EC=$?
    fi

    if [ $EC -ne 0 ]; then
      echo "verify: FAIL_TO_PASS did not all pass" >&2
      echo "$OUTPUT" >&2
      exit 1
    fi

    # PASS_TO_PASS regression spot-check. Soft on missing tests (layout may
    # have shifted); hard on regressions.
    if [ "${#PTP[@]}" -gt 0 ]; then
      for t in "${PTP[@]}"; do
        if $PYTEST_CMD --collect-only -q "$t" >/dev/null 2>&1; then
          if ! $PYTEST_CMD -q --no-header "$t" >/dev/null 2>&1; then
            echo "verify: PASS_TO_PASS regression at $t" >&2
            exit 1
          fi
        fi
      done
    fi

    echo "verify: $(jq -r .id "$TASK_JSON") — FAIL_TO_PASS + PASS_TO_PASS sample all green"
    ;;

  *)
    echo "swebench-runner: unknown mode '$MODE' (want setup|verify)" >&2
    exit 2
    ;;
esac
