#!/usr/bin/env bash
# PreToolUse lint on Edit/Write/MultiEdit. Catches the small set of
# code-quality patterns that are mechanically detectable from the new
# content alone (no AST). Everything qualitative — design judgment,
# correctness reasoning — stays in tmb_code-quality skill prose.
#
# Mechanical checks:
#   Python                               TS/JS
#   ───────────────────────────────────  ─────────────────────────────────
#   bare `except:` / `except Exception`  `} catch (e: any) {` (any-typed)
#   `subprocess.run` w/o `timeout=`      `setTimeout` w/ string code arg
#   f-string SQL (e.g. f"SELECT … {x}")  template-string SQL with ${}
#   `datetime.utcnow()`                  `new Date().toLocaleString()` ←skip,
#   mutable default arg `def f(x=[])`     too noisy
#   `TODO`/`FIXME`/`HACK` in src/        same
#
# Soft-warn via `additionalContext`. Bypass: TMB_SKIP_CQ_LINT=1.

set -uo pipefail

INPUT=$(cat)

if [ "${TMB_SKIP_CQ_LINT:-0}" = "1" ]; then exit 0; fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
case "$TOOL_NAME" in
  Edit|Write|MultiEdit) ;;
  *) exit 0 ;;
esac

TARGET=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null)
[ -n "$TARGET" ] || exit 0

# Only fire on source files; docs / configs don't get the same treatment.
case "$TARGET" in
  *.py|*.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs) ;;
  *) exit 0 ;;
esac

case "$TARGET" in
  */node_modules/*|*/dist/*|*/build/*|*/__pycache__/*|*/target/*) exit 0 ;;
  */fixtures/*|*/__fixtures__/*) exit 0 ;;
esac

# Pull the proposed content. Edit gives us new_string; Write gives content;
# MultiEdit batches multiple edits — concatenate their new_strings.
CONTENT=$(echo "$INPUT" | jq -r '
  .tool_input.content //
  .tool_input.new_string //
  ([.tool_input.edits[]?.new_string] | join("\n")) //
  ""
' 2>/dev/null)
[ -n "$CONTENT" ] || exit 0

EXT="${TARGET##*.}"
FINDINGS=""

push() { FINDINGS="${FINDINGS}\n - $1"; }

case "$EXT" in
  py)
    # Bare except or `except Exception` (catches SystemExit/KeyboardInterrupt).
    if echo "$CONTENT" | grep -qE '^[[:space:]]*except[[:space:]]*:'; then
      push "bare 'except:' — catch a specific exception or re-raise"
    fi
    if echo "$CONTENT" | grep -qE '^[[:space:]]*except[[:space:]]+Exception[[:space:]]*[:as ]'; then
      push "'except Exception' is too broad — catches SystemExit/KeyboardInterrupt"
    fi
    # subprocess.run without timeout=
    if echo "$CONTENT" | grep -qE 'subprocess\.run\(' \
       && echo "$CONTENT" | grep -E 'subprocess\.run\([^)]*\)' | grep -qvE 'timeout[[:space:]]*='; then
      push "subprocess.run without timeout= — risk of indefinite hang"
    fi
    # f-string SQL
    if echo "$CONTENT" | grep -qE "f['\"](SELECT|INSERT|UPDATE|DELETE|MERGE)[[:space:]]"; then
      push "f-string SQL — use parameterized queries to prevent injection"
    fi
    # datetime.utcnow()
    if echo "$CONTENT" | grep -qE 'datetime\.utcnow\(\)'; then
      push "datetime.utcnow() returns naive datetime — use datetime.now(timezone.utc)"
    fi
    # Mutable default args
    if echo "$CONTENT" | grep -qE 'def[[:space:]]+[A-Za-z_][A-Za-z0-9_]*\([^)]*=\[\]'; then
      push "mutable default argument [] — use None and assign in body"
    fi
    if echo "$CONTENT" | grep -qE 'def[[:space:]]+[A-Za-z_][A-Za-z0-9_]*\([^)]*=\{\}'; then
      push "mutable default argument {} — use None and assign in body"
    fi
    ;;
  ts|tsx|js|jsx|mjs|cjs)
    # any-typed catch
    if echo "$CONTENT" | grep -qE 'catch[[:space:]]*\([[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*:[[:space:]]*any[[:space:]]*\)'; then
      push "catch (e: any) — use 'unknown' and narrow with instanceof"
    fi
    # template-string SQL with interpolation
    if echo "$CONTENT" | grep -qE '\`(SELECT|INSERT|UPDATE|DELETE|MERGE)[^`]*[$][{]'; then
      push "template-string SQL with \${...} — use parameterized queries"
    fi
    # setTimeout with string
    if echo "$CONTENT" | grep -qE "setTimeout\([[:space:]]*['\"]"; then
      push "setTimeout with string argument — use a function reference"
    fi
    ;;
esac

# TODO/FIXME/HACK in any source language. Allowed in tests/__fixtures__,
# already filtered above.
if echo "$CONTENT" | grep -qE '(TODO|FIXME|HACK|XXX)([[:space:]]|:|$)'; then
  push "TODO/FIXME/HACK — finish the work or escalate; don't ship the marker"
fi

[ -z "$FINDINGS" ] && exit 0

CTX=$(printf "code-quality-lint: %s%b\nSet TMB_SKIP_CQ_LINT=1 to bypass." "$TARGET" "$FINDINGS")

jq -nc --arg ctx "$CTX" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: $ctx
  }
}'
exit 0
