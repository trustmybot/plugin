/**
 * The verification-run record of swe-verification-gate (GH 1692): the SQL
 * that starts a run (after
 * finishing every unfinished run past its own budget_s + 60 s as exit 137),
 * records one command with its output tail capped, finishes a run, and finds a
 * reusable passing run. The gate and `cli.js integrate` (GH 1405) write each
 * through dbWrite; these builders are the only verification_runs writer.
 */
import { nowIso, type SqlResult } from './audit.js';
import { sqliteRo, sqlQuote } from './db.js';
import { ctypeUtf8 } from './project-env.js';

export const DEFAULT_TAIL_CHARS = 4000;

/** bash's `${#s}`: code points under a UTF-8 LC_CTYPE, bytes under C. */
export function shellLength(s: string, env: NodeJS.ProcessEnv): number {
  return ctypeUtf8(env) ? [...s].length : Buffer.byteLength(s);
}

/** bash's `${s: -n}` for n > 0, in the units shellLength counts. */
export function shellTail(s: string, n: number, env: NodeJS.ProcessEnv): string {
  if (ctypeUtf8(env)) return [...s].slice(-n).join('');
  const bytes = Buffer.from(s);
  return bytes.subarray(Math.max(0, bytes.length - n)).toString('utf8');
}

/** <output> cut to its last TMB_VERIFICATION_TAIL_CHARS characters (DEFAULT_TAIL_CHARS when unset or not a number; 0 keeps it whole). */
export function capTail(output: string, env: NodeJS.ProcessEnv): string {
  const rawCap = env.TMB_VERIFICATION_TAIL_CHARS || String(DEFAULT_TAIL_CHARS);
  const cap = /^[0-9]+$/.test(rawCap) ? Number(rawCap) : DEFAULT_TAIL_CHARS;
  return cap > 0 && shellLength(output, env) > cap ? shellTail(output, cap, env) : output;
}

function invalid(caller: string, message: string): SqlResult {
  return { code: 2, sql: '', error: `tmb_verification_run: ${caller}: ${message}` };
}

/** Who started a run: the swe-verification-gate hook or `cli.js integrate`. */
export type VerificationRunSource = 'gate' | 'manual';

/** tmb_verification_run_start: the stale sweep, the run's INSERT, and the SELECT of its id. */
export function runStartSql(taskId: string, sha: string, budgetS: number, source: VerificationRunSource, now: string = nowIso()): string {
  return `UPDATE verification_runs SET finished_at = '${now}', exit_code = 137, timed_out = 0
 WHERE finished_at IS NULL
   AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at) < strftime('%Y-%m-%dT%H:%M:%fZ', '${now}', '-' || (budget_s + 60) || ' seconds');
INSERT INTO verification_runs (task_id, commit_sha, source, started_at, budget_s) VALUES (${taskId}, '${sqlQuote(sha)}', '${source}', '${now}', ${budgetS});
SELECT last_insert_rowid();`;
}

/** tmb_verification_run_command: one command row, its output cut to the last TMB_VERIFICATION_TAIL_CHARS characters. */
export function runCommandSql(
  caller: string,
  runId: string,
  ordinal: number,
  command: string,
  rc: number,
  elapsed: string,
  output: string,
  env: NodeJS.ProcessEnv,
): SqlResult {
  if (!/^[0-9]+$/.test(runId)) return invalid(caller, `invalid run_id '${runId}'`);
  const tail = capTail(output, env);
  return {
    code: 0,
    sql: `INSERT INTO verification_run_commands (run_id, ordinal, command, exit_code, elapsed_s, output_tail) VALUES (${runId}, ${ordinal}, '${sqlQuote(command)}', ${rc}, ${elapsed}, '${sqlQuote(tail)}');`,
    error: '',
  };
}

/** tmb_verification_run_finish: stamps finished_at, exit_code and timed_out on the run. */
export function runFinishSql(caller: string, runId: string, rc: number, timedOut: 0 | 1, now: string = nowIso()): SqlResult {
  if (!/^[0-9]+$/.test(runId)) return invalid(caller, `invalid run_id '${runId}'`);
  return {
    code: 0,
    sql: `UPDATE verification_runs SET finished_at = '${now}', exit_code = ${rc}, timed_out = ${timedOut} WHERE id = ${runId};`,
    error: '',
  };
}

/**
 * tmb_verification_run_reusable: `<run_id>|<finished_at>` of the newest passing
 * run of (task, sha) from the last hour whose command rows equal
 * <commandsJson> in order; "" when none or the read fails.
 */
export function reusableRun(db: string, taskId: string, sha: string, commandsJson: string, env: NodeJS.ProcessEnv): string {
  const cmds = sqlQuote(commandsJson);
  return sqliteRo(
    db,
    `SELECT r.id || '|' || r.finished_at FROM verification_runs r
     WHERE r.task_id = ${taskId} AND r.commit_sha = '${sqlQuote(sha)}'
       AND r.exit_code = 0 AND r.timed_out = 0 AND r.finished_at IS NOT NULL
       AND r.finished_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3600 seconds')
       AND json_valid('${cmds}')
       AND (SELECT COUNT(*) FROM verification_run_commands c WHERE c.run_id = r.id) = json_array_length('${cmds}')
       AND NOT EXISTS (SELECT 1 FROM json_each('${cmds}') e
             LEFT JOIN verification_run_commands c ON c.run_id = r.id AND c.ordinal = e.key + 1
            WHERE c.command IS NOT e.value)
     ORDER BY r.finished_at DESC, r.id DESC LIMIT 1;`,
    env,
  );
}
