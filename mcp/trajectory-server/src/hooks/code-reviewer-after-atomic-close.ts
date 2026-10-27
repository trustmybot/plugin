/**
 * PreToolUse(Agent) gate (GH 1692), the port of
 * scripts/hooks/code-reviewer-after-atomic-close.sh, run by
 * agent-spawn-dispatch.sh: a code-reviewer spawn naming task_id=<N> is
 * allowed only once tasks.status of <N> is 'closed', so bro_atomic_close
 * precedes the push gate. No task_id, no resolvable DB or no tasks row
 * allows; a DB read error denies with the DB-unavailable reason.
 *
 * task_id is the first `task_id[[:space:]]*=[[:space:]]*[0-9]+` of the
 * prompt, line by line as macOS grep reads it (`[:space:]` adds Unicode
 * spaces under a UTF-8 locale). Unlike the .sh, it needs neither jq nor the
 * sqlite3 CLI, so it denies an unclosed task on a machine without them where
 * the .sh let the spawn through (decision 703).
 * Bypass: TMB_SKIP_CODE_REVIEWER_CLOSE_GATE=1.
 */
import { ALLOW, type GateResult, type SyncGate } from './gate.js';
import { isCodeReviewerSpawn, spawnDeny, spawnField } from './code-reviewer-no-worktree.js';
import { dbPath, denyDbUnavailable, GATE_READ_ERROR, gateRead, haveSqlite, sqlInt } from './lib/db.js';
import { grepMultibyte, grepSpace } from './lib/lint-shell.js';

export const GATE_NAME = 'code-reviewer-after-atomic-close';
export const BYPASS_ENV = 'TMB_SKIP_CODE_REVIEWER_CLOSE_GATE';

export function notClosedReason(taskId: string, status: string): string {
  return `BLOCKED: code-reviewer spawn requires task ${taskId} status=closed but actual status=${status}.

Per tmb_planning Step 5 (verify + close, then code-reviewer per tmb_push-gate), the order is:
  1. SWE returns status=completed (lifecycle answer, NOT a DB closure).
  2. bro runs V1 (task_get + git diff), V2 (3 checks), V3 (bro_atomic_close).
  3. ONLY THEN: spawn code-reviewer for the push gate.

SWE returning completed does not close the trajectory task — that is bro_atomic_close.

Fix: call bro_atomic_close(agent='bro', task_id=${taskId}, commit_sha=<sha>, verification_summary='...') first, then retry this spawn.`;
}

/** `printf '%s' "$PROMPT" | grep -Eo 'task_id[[:space:]]*=[[:space:]]*[0-9]+' | head -1 | grep -Eo '[0-9]+' | head -1`. */
export function promptTaskId(prompt: string, multibyte: boolean): string {
  const space = grepSpace(multibyte);
  const re = new RegExp(`task_id[${space}]*=[${space}]*([0-9]+)`, multibyte ? 'u' : '');
  const text = multibyte ? prompt : Buffer.from(prompt, 'utf8').toString('latin1');
  for (const line of text.split('\n')) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return '';
}

export const codeReviewerAfterAtomicClose: SyncGate = (payload, env): GateResult => {
  if (env[BYPASS_ENV] === '1') return ALLOW;
  if (!isCodeReviewerSpawn(payload)) return ALLOW;
  const taskId = sqlInt(promptTaskId(spawnField(payload, 'tool_input', 'prompt'), grepMultibyte(env)));
  if (taskId === '') return ALLOW;
  const db = dbPath(env);
  if (db === null || !haveSqlite(env)) return ALLOW;
  const status = gateRead(db, `SELECT status FROM tasks WHERE id = ${taskId};`, env);
  if (status === GATE_READ_ERROR) return { stdout: `${denyDbUnavailable(GATE_NAME, env)}\n`, code: 0 };
  if (status === '' || status === 'closed') return ALLOW;
  return spawnDeny(notClosedReason(taskId, status));
};
