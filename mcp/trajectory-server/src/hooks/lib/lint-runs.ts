/**
 * The close-lint record (GH 2570), styled on verification-runs.ts: the parser
 * of a repo's .config/tmb/close-lints.json, the SQL that starts a lint run
 * (after finishing every run left unfinished past LINT_RUN_STALE_S as exit
 * 137), records one lint with its output tail capped and finishes a run, and
 * the read of a task's newest finished run for a commit. The writers apply
 * each SQL through dbWrite; a run with no lints is a row with exit_code 0 and
 * no results.
 */
import { nowIso, type SqlResult } from './audit.js';
import { sqliteRo, sqlQuote } from './db.js';
import { capTail } from './verification-runs.js';

/** An unfinished lint run older than this is taken as killed and finished as exit 137 by the next run start. */
export const LINT_RUN_STALE_S = 3600;

export const LINT_RUN_SOURCES = ['gate', 'integrate'] as const;
export type LintRunSource = (typeof LINT_RUN_SOURCES)[number];

export interface CloseLint {
  name: string;
  command: string;
}

export interface CloseLints {
  lints: CloseLint[];
  fingerprint_inputs: string[];
}

export interface LintRunResult {
  ordinal: number;
  name: string;
  exit_code: number | null;
  elapsed_s: number | null;
  output_tail: string | null;
}

export interface LintRunRecord {
  run_id: number;
  task_id: number;
  commit_sha: string;
  base_sha: string;
  fingerprint: string;
  source: string;
  started_at: string;
  finished_at: string;
  exit_code: number | null;
  results: LintRunResult[];
}

const INT_RE = /^[0-9]+$/;

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** close-lints.json {"lints":[{"name","command"}],"fingerprint_inputs":["<glob>"]} with unique lint names, or why it is not one. */
export function parseCloseLints(text: string): CloseLints | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return `not valid JSON: ${(e as Error).message}`;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'must be a JSON object {"lints":[...],"fingerprint_inputs":[...]}';
  }
  const { lints, fingerprint_inputs: inputs } = parsed as { lints?: unknown; fingerprint_inputs?: unknown };
  if (!Array.isArray(lints)) return 'lints must be an array of {"name":"<non-empty>","command":"<non-empty>"}';
  const names = new Set<string>();
  for (const [i, l] of lints.entries()) {
    if (l === null || typeof l !== 'object' || Array.isArray(l)) return `lints[${i}] must be an object {"name","command"}`;
    const { name, command } = l as { name?: unknown; command?: unknown };
    if (!nonEmpty(name)) return `lints[${i}].name must be a non-empty string`;
    if (!nonEmpty(command)) return `lints[${i}].command must be a non-empty string`;
    if (names.has(name)) return `lints[${i}].name '${name}' is a duplicate`;
    names.add(name);
  }
  if (!Array.isArray(inputs) || !inputs.every(nonEmpty)) return 'fingerprint_inputs must be an array of non-empty glob strings';
  return {
    lints: (lints as CloseLint[]).map((l) => ({ name: l.name, command: l.command })),
    fingerprint_inputs: [...inputs],
  };
}

function invalid(caller: string, message: string): SqlResult {
  return { code: 2, sql: '', error: `tmb_lint_run: ${caller}: ${message}` };
}

function ok(sql: string): SqlResult {
  return { code: 0, sql, error: '' };
}

/** The stale sweep, the run's INSERT, and the SELECT of its id. */
export function lintRunStartSql(
  taskId: string,
  sha: string,
  baseSha: string,
  fingerprint: string,
  source: LintRunSource,
  now: string = nowIso(),
): SqlResult {
  if (!INT_RE.test(taskId)) return invalid('lintRunStartSql', `invalid task_id '${taskId}'`);
  if (!LINT_RUN_SOURCES.includes(source)) return invalid('lintRunStartSql', `invalid source '${source}'`);
  return ok(`UPDATE lint_runs SET finished_at = '${now}', exit_code = 137
 WHERE finished_at IS NULL
   AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at) < strftime('%Y-%m-%dT%H:%M:%fZ', '${now}', '-${LINT_RUN_STALE_S} seconds');
INSERT INTO lint_runs (task_id, commit_sha, base_sha, fingerprint, source, started_at) VALUES (${taskId}, '${sqlQuote(sha)}', '${sqlQuote(baseSha)}', '${sqlQuote(fingerprint)}', '${source}', '${now}');
SELECT last_insert_rowid();`);
}

/** One lint's result row, its output cut to the last TMB_VERIFICATION_TAIL_CHARS characters as verification command rows are. */
export function lintRunResultSql(
  runId: string,
  ordinal: number,
  name: string,
  rc: number,
  elapsed: number,
  output: string,
  env: NodeJS.ProcessEnv,
): SqlResult {
  if (!INT_RE.test(runId)) return invalid('lintRunResultSql', `invalid run_id '${runId}'`);
  if (!Number.isInteger(ordinal) || ordinal < 1) return invalid('lintRunResultSql', `invalid ordinal '${ordinal}'`);
  if (!Number.isInteger(rc)) return invalid('lintRunResultSql', `invalid exit code '${rc}'`);
  if (!Number.isFinite(elapsed)) return invalid('lintRunResultSql', `invalid elapsed '${elapsed}'`);
  return ok(
    `INSERT INTO lint_run_results (run_id, ordinal, name, exit_code, elapsed_s, output_tail) VALUES (${runId}, ${ordinal}, '${sqlQuote(name)}', ${rc}, ${elapsed}, '${sqlQuote(capTail(output, env))}');`,
  );
}

/** Stamps finished_at and exit_code on the run. */
export function lintRunFinishSql(runId: string, rc: number, now: string = nowIso()): SqlResult {
  if (!INT_RE.test(runId)) return invalid('lintRunFinishSql', `invalid run_id '${runId}'`);
  if (!Number.isInteger(rc)) return invalid('lintRunFinishSql', `invalid exit code '${rc}'`);
  return ok(`UPDATE lint_runs SET finished_at = '${now}', exit_code = ${rc} WHERE id = ${runId};`);
}

/** The newest-started finished lint run of (task, sha) with its results in ordinal order; null when none or the read fails. */
export function latestLintRun(db: string, taskId: string, sha: string, env: NodeJS.ProcessEnv): LintRunRecord | null {
  if (!INT_RE.test(taskId)) return null;
  const out = sqliteRo(
    db,
    `SELECT json_object(
       'run_id', r.id, 'task_id', r.task_id, 'commit_sha', r.commit_sha, 'base_sha', r.base_sha,
       'fingerprint', r.fingerprint, 'source', r.source, 'started_at', r.started_at,
       'finished_at', r.finished_at, 'exit_code', r.exit_code,
       'results', json((SELECT json_group_array(json_object('ordinal', c.ordinal, 'name', c.name, 'exit_code', c.exit_code, 'elapsed_s', c.elapsed_s, 'output_tail', c.output_tail))
                          FROM lint_run_results c WHERE c.run_id = r.id)))
       FROM lint_runs r
      WHERE r.task_id = ${taskId} AND r.commit_sha = '${sqlQuote(sha)}' AND r.finished_at IS NOT NULL
      ORDER BY r.started_at DESC, r.id DESC LIMIT 1;`,
    env,
  );
  if (out.trim() === '') return null;
  try {
    const run = JSON.parse(out) as LintRunRecord;
    run.results.sort((a, b) => a.ordinal - b.ordinal);
    return run;
  } catch {
    return null;
  }
}
