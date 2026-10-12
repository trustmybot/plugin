import type { TrajectoryDB } from '../db.js';

export interface VerificationRunCommand {
  ordinal: number;
  command: string;
  exit_code: number | null;
  elapsed_s: number | null;
}

export interface VerificationRunRecord {
  run_id: number;
  commit_sha: string;
  source: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  timed_out: boolean;
  budget_s: number;
  commands: VerificationRunCommand[];
}

/**
 * The task's latest recorded verification run (written by
 * swe-verification-gate.sh), or null when none exists. With `startedBy`, only
 * runs started at or before that ISO timestamp count.
 */
export function latestVerificationRun(db: TrajectoryDB, taskId: number, startedBy?: string): VerificationRunRecord | null {
  const run = db.get<{
    id: number;
    commit_sha: string;
    source: string;
    started_at: string;
    finished_at: string | null;
    exit_code: number | null;
    timed_out: number;
    budget_s: number;
  }>(
    `SELECT id, commit_sha, source, started_at, finished_at, exit_code, timed_out, budget_s
       FROM verification_runs
      WHERE task_id = ?${startedBy ? ' AND started_at <= ?' : ''}
      ORDER BY started_at DESC, id DESC LIMIT 1`,
    startedBy ? [taskId, startedBy] : [taskId],
  );
  if (!run) return null;
  const commands = db
    .all<VerificationRunCommand>(
      `SELECT ordinal, command, exit_code, elapsed_s FROM verification_run_commands WHERE run_id = ? ORDER BY ordinal`,
      [run.id],
    )
    .map((c) => ({ ordinal: c.ordinal, command: c.command, exit_code: c.exit_code, elapsed_s: c.elapsed_s }));
  return {
    run_id: run.id,
    commit_sha: run.commit_sha,
    source: run.source,
    started_at: run.started_at,
    finished_at: run.finished_at,
    exit_code: run.exit_code,
    timed_out: run.timed_out === 1,
    budget_s: run.budget_s,
    commands,
  };
}
