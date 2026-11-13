/**
 * The close-lint runner (GH 2570) swe-verification-gate runs at S10 and
 * `cli.js integrate` runs on the rebased SHA: the lints a repo's
 * .config/tmb/close-lints.json declares at <sha> (an allowlist; nothing else
 * runs), each as `bash -c '<command>'` in the checkout under the env it is
 * given, recorded against <base> as one lint_runs row with a lint_run_results
 * row per lint, in that order. The changelog and stale-doc checks are not close
 * lints; doc-checks.ts runs them at swe's close.
 *
 * The config lints share <budgetS>: each gets what the earlier ones left, a lint
 * killed at it (its process group SIGKILLed) or one the budget ran out before
 * records exit 124. With no close-lints.json the run holds no results,
 * fingerprinted over no inputs. A malformed config or a
 * fingerprint git cannot compute is returned as a string, with nothing run. A
 * run start the DB cannot record still runs the lints, unrecorded (runId ''),
 * as the verification record's own write failures leave the gate's verdict.
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { dbWrite } from './audit.js';
import { gateRead, GATE_READ_ERROR } from './db.js';
import { gitText } from './doc-checks.js';
import { prTargetRef } from './git-refs.js';
import { CLOSE_LINTS_PATH, lintFingerprint } from './lint-fingerprint.js';
import { latestLintRun, lintRunFinishSql, lintRunResultSql, lintRunStartSql, parseCloseLints } from './lint-runs.js';
export const LINT_TIMED_OUT = 124;
export const FAILURE_TAIL_LINES = 15;
const RECORD_ENV = { TMB_DB_WRITE_TIMEOUT_MS: '3000', TMB_DB_WRITE_RUN_BUDGET_MS: '3000' };
const FINISH_ATTEMPTS = 3;
const signals = osConstants.signals;
/** The close-lints.json at <sha>, null when it has none, or why it does not parse. */
export async function readCloseLints(repo, sha, env) {
    const listed = await gitText(repo, ['ls-tree', '--name-only', sha, '--', CLOSE_LINTS_PATH], env);
    if (listed.code !== 0)
        return `git ls-tree ${sha} failed: ${listed.stderr.trim()}`;
    if (listed.stdout.trim() === '')
        return null;
    const shown = await gitText(repo, ['show', `${sha}:${CLOSE_LINTS_PATH}`], env);
    if (shown.code !== 0)
        return `git show ${sha}:${CLOSE_LINTS_PATH} failed: ${shown.stderr.trim()}`;
    const parsed = parseCloseLints(shown.stdout);
    return typeof parsed === 'string' ? `${CLOSE_LINTS_PATH} at ${sha.slice(0, 12)}: ${parsed}` : parsed;
}
/** The close-lints config at <sha> and its fingerprint, or why either cannot be had. */
export async function closeLintsPlan(repo, sha, env) {
    const config = await readCloseLints(repo, sha, env);
    if (typeof config === 'string')
        return config;
    const fingerprint = await lintFingerprint(repo, sha, config?.fingerprint_inputs ?? [], env);
    if (fingerprint === null)
        return `the close-lint fingerprint of ${sha} could not be computed (git ls-tree failed or a fingerprint_inputs glob does not apply)`;
    return { config, fingerprint };
}
/**
 * merge-base(<sha>, the task's PR target ref), the target resolved as
 * code-reviewer-preflight does (an unreadable task row leaves only the repo
 * default); '' when none resolves.
 */
export async function lintBaseSha(repo, db, taskId, sha, env) {
    if (!/^[0-9]+$/.test(taskId))
        return '';
    const row = gateRead(db, `SELECT COALESCE((SELECT target_branch FROM repos WHERE name = t.repo), '') || '|' || COALESCE(t.parent_branch_id, '') FROM tasks t WHERE t.id = ${taskId};`, env);
    const line = row === GATE_READ_ERROR ? '' : row.split('\n')[0];
    const bar = line.indexOf('|');
    const target = bar < 0 ? '' : line.slice(0, bar);
    const parent = bar < 0 ? '' : line.slice(bar + 1);
    const ref = await prTargetRef(repo, target, parent, env);
    if (ref === null)
        return '';
    const base = await gitText(repo, ['merge-base', ref, sha], env);
    return base.code === 0 ? base.stdout.trim() : '';
}
/** The task's newest lint run at <sha> when it is clean and its fingerprint and base still hold, else null. */
export function reusableLintRun(target, sha, baseSha, fingerprint, env) {
    const run = latestLintRun(target.db, target.taskId, sha, env);
    if (run === null || run.exit_code !== 0 || run.fingerprint !== fingerprint || run.base_sha !== baseSha)
        return null;
    return String(run.run_id);
}
export function tailLines(text, n = FAILURE_TAIL_LINES) {
    return text.replace(/\n+$/, '').split('\n').slice(-n).join('\n');
}
function write(db, sql, env) {
    const r = dbWrite(db, sql, { caller: 'close-lints', env: { ...env, ...RECORD_ENV } });
    if (!r.ok && r.error !== '')
        process.stderr.write(`${r.error}\n`);
    return r;
}
function execute(command, cwd, env, seconds, outPath) {
    return new Promise((done) => {
        const fd = openSync(outPath, 'w');
        let fired = false;
        let settled = false;
        const finish = (rc) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            done(rc);
        };
        const child = spawn('bash', ['-c', command], { cwd, env: { ...env, PWD: cwd }, stdio: ['ignore', fd, fd], detached: true });
        closeSync(fd);
        const timer = setTimeout(() => {
            fired = true;
            try {
                if (child.pid !== undefined)
                    process.kill(-child.pid, 'SIGKILL');
            }
            catch {
                /* already gone */
            }
        }, seconds * 1000);
        child.on('error', () => finish(127));
        child.on('exit', (code, signal) => {
            if (fired)
                finish(LINT_TIMED_OUT);
            else
                finish(code ?? 128 + (signal !== null ? (signals[signal] ?? 0) : 0));
        });
    });
}
function seconds(ms) {
    return Math.round(ms / 100) / 10;
}
/**
 * Runs the close lints of <repo> at <sha> against <baseSha> within <budgetS>
 * seconds and records them for <target>; the recorded run, or why none ran.
 */
export async function runCloseLints(repo, sha, baseSha, budgetS, env, target) {
    const plan = await closeLintsPlan(repo, sha, env);
    if (typeof plan === 'string')
        return plan;
    const start = lintRunStartSql(target.taskId, sha, baseSha, plan.fingerprint, target.source);
    if (start.code !== 0)
        return start.error;
    const started = write(target.db, start.sql, env);
    const id = started.ok ? (started.stdout.trim().split('\n').at(-1) ?? '') : '';
    const runId = /^[0-9]+$/.test(id) ? id : '';
    if (runId === '')
        process.stderr.write(`close-lints: the lint run start could not be recorded in ${target.db}; the lints run unrecorded\n`);
    const results = [];
    const record = (r) => {
        results.push(r);
        if (runId === '')
            return;
        const s = lintRunResultSql(runId, results.length, r.name, r.exitCode, r.elapsedS, r.output, env);
        if (s.code !== 0)
            process.stderr.write(`${s.error}\n`);
        else
            write(target.db, s.sql, env);
    };
    const scratch = mkdtempSync(join(tmpdir(), 'tmb-close-lints-'));
    try {
        const budgetStart = Date.now();
        for (const [i, lint] of (plan.config?.lints ?? []).entries()) {
            const left = budgetS - (Date.now() - budgetStart) / 1000;
            if (left <= 0) {
                record({ name: lint.name, exitCode: LINT_TIMED_OUT, elapsedS: 0, output: `the ${budgetS}s close-lint budget ran out before \`${lint.command}\` started` });
                continue;
            }
            const outPath = join(scratch, `out-${i + 1}`);
            const t0 = Date.now();
            const rc = await execute(lint.command, repo, env, left, outPath);
            const elapsedS = seconds(Date.now() - t0);
            let output = '';
            try {
                output = readFileSync(outPath, 'utf8');
            }
            catch {
                /* no output file */
            }
            if (rc === LINT_TIMED_OUT) {
                const killed = `killed at the ${budgetS}s close-lint budget after ${elapsedS}s`;
                const printed = output.replace(/\n+$/, '');
                output = printed === '' ? killed : `${printed}\n${killed}`;
            }
            record({ name: lint.name, exitCode: rc, elapsedS, output });
        }
    }
    finally {
        rmSync(scratch, { recursive: true, force: true });
    }
    const failures = results.filter((r) => r.exitCode !== 0);
    const exitCode = failures[0]?.exitCode ?? 0;
    if (runId !== '') {
        const finish = lintRunFinishSql(runId, exitCode);
        let finished = false;
        for (let attempt = 1; attempt <= FINISH_ATTEMPTS && !finished; attempt += 1)
            finished = write(target.db, finish.sql, env).ok;
        if (!finished)
            process.stderr.write(`close-lints: lint run #${runId} finish write failed ${FINISH_ATTEMPTS} times; it stays unfinished\n`);
    }
    return { runId, exitCode, fingerprint: plan.fingerprint, results, failures };
}
/** `lint run #<id>`, or that the run went unrecorded. */
export function runLabel(run) {
    return run.runId === '' ? 'an unrecorded lint run (the trajectory DB write failed)' : `lint run #${run.runId}`;
}
/** Each failing lint with its exit code and last FAILURE_TAIL_LINES output lines. */
export function describeFailures(run) {
    return run.failures
        .map((f) => {
        const shown = tailLines(f.output);
        const why = f.exitCode === LINT_TIMED_OUT ? ' (timed out)' : '';
        return `Lint ${f.name} exited ${f.exitCode}${why}.${shown === '' ? ' It printed nothing.' : `\nOutput (last ${FAILURE_TAIL_LINES} lines):\n${shown}`}`;
    })
        .join('\n\n');
}
//# sourceMappingURL=close-lints.js.map