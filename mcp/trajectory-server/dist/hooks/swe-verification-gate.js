/**
 * PreToolUse gate (GH 1692): a swe's task_update_status(status='completed') runs the task's typed
 * verification[] (Typed Rails #673), then the probe_cmd of every blocking review
 * finding not wontfix (GH 1737, GH 1955; every severity on a DB below v57), in
 * the task worktree, and denies on a failing
 * command or a spent budget.
 *
 * A bro close of a task with a no_code_class (GH 3075) runs the same path, after
 * first classing the task's diff since its merge base with origin/<PR target>
 * (else base_sha) by the path classes committed at base_sha: a code or mixed diff denies, naming its
 * code paths. Any other non-swe caller, another status, no task id or no
 * resolvable DB allows; an unlocatable worktree denies. Before anything else runs, the changelog and
 * stale-doc checks (lib/doc-checks.ts, GH 2866) judge the worktree HEAD against
 * its merge base with the task's PR target and deny with the JSON reason
 * {check, expected, actual}; an unprovable state (a git failure, no PR target
 * ref, no merge base, an invalid .config/tmb/doc-checks.json at HEAD) denies
 * too. That project file names the changelog directory and doc and tool
 * globs; with no file or no key a check is skipped, and the allow's
 * additionalContext names the file and key to add. Then the leak scan
 * (lib/leak-scan.ts, GH 2929) checks the lines that diff adds for secrets
 * (secretlint's recommended preset), email addresses and home paths, and
 * denies as leak_scan naming each hit's file, line and rule, never the
 * matched text; the optional .config/tmb/leak-scan.json at HEAD adds allow
 * entries and turns rules off, each with a reason, and an invalid one denies
 * as leak_scan_config. A doc-check or leak-scan deny records no verification
 * run, so a passing verification_runs row for HEAD means all of them passed, which
 * swe-atomic-close and code-reviewer-preflight rely on. No waiver or bypass
 * skips them. Then a waive_verification_gate_reason of at least 10 characters
 * allows and writes one verification_gate_waived audit row per (task, commit),
 * and an empty verification[] with no finding allows with a warning. A passing
 * run of the same commands on the worktree HEAD from the last hour is reused (GH 1672); otherwise the run is recorded in
 * verification_runs under a per-(task, HEAD) mkdir lock, commands the task's
 * last passing ancestor run carries forward are recorded, not run (GH 1950),
 * and the rest run through `bash -c` with the user's toolchain PATH.
 * Before a run that is not reused, the worktree's opt-in
 * .config/tmb/worktree-setup.json commands run with that same env (GH 2054);
 * a setup failure denies with the failing command and its output tail, and
 * setup is never recorded as a verification command.
 *
 * Once verification[] passes (or is reused) for the worktree HEAD, the close
 * lints run (GH 2570, lib/close-lints.ts): the repo's .config/tmb/close-lints.json
 * lints at HEAD, recorded as a lint_runs row (source gate) against
 * merge-base(HEAD, PR target) with what verification[] left of the budget. A non-zero lint denies,
 * naming each failing lint with its exit code and last 15 output lines; a
 * malformed close-lints.json or an unresolvable merge-base denies with nothing
 * run. A clean lint run of HEAD whose fingerprint and base_sha still hold is
 * reused, not run again.
 *
 * Budget: plugin_config.verification_timeout_s or TMB_VERIFICATION_TIMEOUT_S,
 * default 900 s, clamped to [1, 1800]; it counts command time only, worktree
 * setup included: verification[] gets what setup leaves, and a setup that
 * spends it denies. The record
 * writes have their own per-write and pooled budgets, and the finish write is
 * tried three times. timed_out is 1 only when the gate's own timer fired or
 * the budget was spent before a command started; a timed-out command's
 * process group is killed.
 *
 * When a command or probe is a full suite (isFullSuite), the run first takes a
 * suite slot (suite-lock.ts, GH 2092), exported to the commands as
 * TMB_SUITE_LOCK_HELD. The wait comes before the budget timer and is capped at
 * the hook timeout less 30 s and the budget (1800 s at the 1800 s budget;
 * TMB_SUITE_WAIT_CAP_S lowers it for tests); waiters queue first come first
 * served (GH 2297). Past the cap the gate denies with `suite slot busy` and
 * records no run.
 *
 * It needs neither jq nor the sqlite3 CLI.
 */
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ALLOW } from './gate.js';
import { auditAppend, dbWrite, nowIso } from './lib/audit.js';
import { closeLintsPlan, describeFailures, LINT_TIMED_OUT, lintBaseSha, reusableLintRun, runCloseLints, runLabel } from './lib/close-lints.js';
import { denyJson, structuredDenyResult } from './lib/deny.js';
import { branchSlug, DB_RETRY_FIX, dbPath, denyDbUnavailable, GATE_READ_ERROR, gateRead, haveSqlite, sqliteRo, sqlQuote } from './lib/db.js';
import { docChecks, gitText, nulFields, revParse } from './lib/doc-checks.js';
import { classifyChange, classifyPath, PATH_CLASSES_FILE, readPathClasses } from '../path-classes.js';
import { gitRun, isDir } from './lib/git.js';
import { leakScan } from './lib/leak-scan.js';
import { prTargetRef } from './lib/git-refs.js';
import { firstLine } from './lib/host.js';
import { jqCompact, jqNumberLiteral, jqRawElements } from './lib/jq.js';
import { jqCapture, jqInput } from './lib/jq-raw.js';
import { CLOSE_LINTS_PATH } from './lib/lint-fingerprint.js';
import { commandSubstitution, jqRawText, posixDirname } from './lib/project-env.js';
import { repoSinglePath } from './lib/repo.js';
import { normalizeRole } from './lib/role.js';
import { planCarrySafe } from './lib/verification-carry.js';
import { reusableRun, runCommandSql, runFinishSql, runStartSql, shellLength } from './lib/verification-runs.js';
import { rawOrEmpty } from './swe-brief-gate.js';
import { acquireSuiteSlot, describeHolder, isFullSuite, SUITE_LOCK_HELD_ENV } from '../suite-lock.js';
import { describeSetupFailure, runWorktreeSetup, WORKTREE_SETUP_FILE } from '../utils/worktree-setup.js';
export const GATE_NAME = 'swe-verification-gate';
/** hooks.json's timeout for the trajectory-server PreToolUse matcher that runs this gate. */
export const TRAJECTORY_PRETOOLUSE_TIMEOUT_S = 3630;
const SUITE_WAIT_MARGIN_S = 30;
/** The suite-slot wait cap: the hook timeout less 30 s and the verification budget. */
export function suiteWaitCapS(budgetS) {
    return TRAJECTORY_PRETOOLUSE_TIMEOUT_S - SUITE_WAIT_MARGIN_S - budgetS;
}
export const VERIFICATION_DEFAULT_S = 900;
export const VERIFICATION_MAX_S = 1800;
const RECORD_BUDGET_MS = 3000;
const RECORD_POOL_MS = 9000;
const FINISH_ATTEMPTS = 3;
const FINISH_BACKOFF_MS = 500;
const LOCK_POLL_MS = 500;
const TAIL_LINES = 20;
const FAILURE_LINES = 15;
const signals = osConstants.signals;
const DB_UNAVAILABLE_DENY = `${denyJson('BLOCKED: trajectory DB unavailable — the verification gate could not read the task row, so it refuses to fail open. Check the trajectory DB (sqlite3 error on read).', DB_RETRY_FIX)}\n`;
const WAIVER_UNRECORDED_DENY = `${denyJson('BLOCKED: trajectory DB unavailable — the verification-gate waiver could not be recorded, so it cannot be honoured.', { allowed: 'the same call again, once the trajectory DB is writable' })}\n`;
const RETRY_FIXED = { allowed: "task_update_status(status='completed', commit_sha, report) again once the fix is committed" };
const NO_VERIFICATION_CONTEXT = "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"TMB: task has no typed verification[] — verification gate skipped. Ask bro to set the task's verification[] field (Typed Rails #673) to enforce verification commands.\"}}\n";
const UNRECORDED_PASS_CONTEXT = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"TMB: verification[] passed (not recorded: worktree HEAD unresolvable)."}}\n';
const stderr = (text) => {
    process.stderr.write(text);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** `${s%%|*}`. */
function beforeBar(s) {
    const i = s.indexOf('|');
    return i < 0 ? s : s.slice(0, i);
}
/** `${s#*|}`. */
function afterBar(s) {
    const i = s.indexOf('|');
    return i < 0 ? s : s.slice(i + 1);
}
function deny(reason, fix) {
    return `${denyJson(reason, fix)}\n`;
}
function context(text) {
    return `${jqCompact({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } })}\n`;
}
/** awk's `printf "%.1f", ms / 1000`: the exact binary value rounded, an exact tie to even. */
export function msToS(ms) {
    const abs = Math.abs(ms);
    const sign = ms < 0 ? '-' : '';
    if (abs % 1000 === 250)
        return `${sign}${Math.floor(abs / 1000)}.2`;
    return `${sign}${(abs / 1000).toFixed(1)}`;
}
/** The command budget from TMB_VERIFICATION_TIMEOUT_S, else plugin_config.verification_timeout_s. */
export function parseBudget(raw) {
    let timeoutS = VERIFICATION_DEFAULT_S;
    if (raw !== '') {
        if (!/^[0-9]+$/.test(raw))
            timeoutS = null;
        else if (raw.length > 9)
            timeoutS = VERIFICATION_MAX_S;
        else
            timeoutS = Number(raw) >= 1 ? Number(raw) : null;
    }
    let warning = '';
    if (timeoutS === null) {
        warning = `${GATE_NAME}: verification_timeout_s '${raw.replaceAll('\n', ' ')}' is not an integer from 1 to ${VERIFICATION_MAX_S}; using the default ${VERIFICATION_DEFAULT_S}s\n`;
        timeoutS = VERIFICATION_DEFAULT_S;
    }
    return { timeoutS: Math.min(timeoutS, VERIFICATION_MAX_S), warning };
}
function executable(path) {
    if (path === '')
        return false;
    try {
        accessSync(path, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
function capture(cmd, args, dir, env) {
    const r = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] });
    return r.stdout ?? '';
}
/** tmb_user_toolchain_dirs: mise shims and <worktree>'s bin-paths, Homebrew, ~/.local/bin and bun, in that order. */
export function toolchainDirs(env, worktree) {
    const home = env.HOME ?? '';
    const out = [];
    const miseData = env.MISE_DATA_DIR || `${env.XDG_DATA_HOME || `${home}/.local/share`}/mise`;
    if (isDir(`${miseData}/shims`))
        out.push(`${miseData}/shims`);
    const mise = [env.MISE_INSTALL_PATH ?? '', '/opt/homebrew/bin/mise', '/usr/local/bin/mise', `${home}/.local/bin/mise`].find(executable);
    if (mise !== undefined)
        out.push(...capture(mise, ['bin-paths'], worktree, env).split('\n'));
    const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(executable);
    const brewPrefix = brew === undefined ? '' : commandSubstitution(capture(brew, ['--prefix'], worktree, env));
    const brewDirs = brewPrefix !== '' ? [`${brewPrefix}/bin`, `${brewPrefix}/sbin`] : ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];
    out.push(...brewDirs.filter(isDir));
    if (home !== '' && isDir(`${home}/.local/bin`))
        out.push(`${home}/.local/bin`);
    if (home !== '') {
        for (const dir of [`${home}/Library/Application Support/reflex/bun/bin`, `${home}/.bun/bin`]) {
            if (isDir(dir) && executable(`${dir}/bun`))
                out.push(dir);
        }
    }
    return out;
}
/** tmb_resolve_toolchain_path <base>: the toolchain dirs before <base>, deduplicated, first occurrence kept. */
export function joinToolchainPath(dirs, base) {
    const seen = new Set();
    for (const dir of [...dirs.filter((d) => d !== ''), ...base.split(':')]) {
        if (dir !== '')
            seen.add(dir);
    }
    return [...seen].join(':');
}
function repoPathByName(db, name, env) {
    let file = false;
    try {
        file = statSync(db).isFile();
    }
    catch {
        /* no DB */
    }
    if (!file || !haveSqlite(env) || name === '')
        return '';
    return firstLine(sqliteRo(db, `SELECT path FROM repos WHERE name = '${sqlQuote(name)}' LIMIT 1;`, env));
}
export function reviewFindingsActive(db, taskId, env) {
    const has = gateRead(db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'review_findings';", env);
    if (has === GATE_READ_ERROR)
        return GATE_READ_ERROR;
    if (has !== '1')
        return '[]';
    const severity = gateRead(db, "SELECT COUNT(*) FROM pragma_table_info('review_findings') WHERE name = 'severity';", env);
    if (severity === GATE_READ_ERROR)
        return GATE_READ_ERROR;
    const blockingOnly = severity === '1' ? " AND severity = 'blocking'" : '';
    const out = gateRead(db, `SELECT COALESCE(json_group_array(json_object('id', id, 'status', status, 'probe_cmd', probe_cmd)), '[]')
     FROM (SELECT id, status, probe_cmd FROM review_findings
            WHERE task_id = ${taskId} AND status <> 'wontfix'${blockingOnly}
            ORDER BY CAST(substr(id, instr(id, '-') + 1) AS INTEGER));`, env);
    return out || '[]';
}
function parseFindings(json) {
    try {
        const parsed = JSON.parse(json);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
/** jq's `"[probe " + .id + "] " + .probe_cmd`. */
function probeCommand(f) {
    return `[probe ${typeof f.id === 'string' ? f.id : ''}] ${typeof f.probe_cmd === 'string' ? f.probe_cmd : ''}`;
}
function lastLines(text, n) {
    return text.split('\n').slice(-n).join('\n');
}
function failureLines(text) {
    return text
        .split('\n')
        .filter((line) => /FAIL|failed|Error|❌/.test(line))
        .slice(0, FAILURE_LINES)
        .join('\n');
}
/** One verification run of the worktree, recorded in verification_runs as it goes. */
class VerificationRun {
    c;
    runId = '';
    recordMs = 0;
    poolNoted = false;
    ordinal = 0;
    runStart = 0;
    carryRun = '';
    carrySha = '';
    carryOrdinals = new Set();
    constructor(c) {
        this.c = c;
    }
    allowanceMs() {
        const left = RECORD_POOL_MS - this.recordMs;
        if (left <= 0)
            return null;
        return Math.min(left, RECORD_BUDGET_MS);
    }
    write(ms, sql) {
        const env = { ...this.c.env, TMB_DB_WRITE_TIMEOUT_MS: String(ms), TMB_DB_WRITE_RUN_BUDGET_MS: String(ms) };
        const r = dbWrite(this.c.db, sql, { caller: GATE_NAME, env });
        if (!r.ok && r.error !== '')
            stderr(`${r.error}\n`);
        return r;
    }
    invalid(message) {
        stderr(`tmb_verification_run: ${GATE_NAME}: ${message}\n`);
        return { ok: false, code: 2, stdout: '', error: '' };
    }
    start(ms) {
        const r = this.write(ms, runStartSql(this.c.taskId, this.c.wtSha, this.c.timeoutS, 'gate'));
        return r.ok ? commandSubstitution(r.stdout) : '';
    }
    commandWrite(ms, ordinal, command, rc, elapsed, output) {
        const s = runCommandSql(GATE_NAME, this.runId, ordinal, command, rc, elapsed, output, this.c.env);
        if (s.code !== 0) {
            stderr(`${s.error}\n`);
            return;
        }
        this.write(ms, s.sql);
    }
    finishWrite(rc, timedOut) {
        const s = runFinishSql(GATE_NAME, this.runId, rc, timedOut);
        if (s.code !== 0) {
            stderr(`${s.error}\n`);
            return { ok: false, code: 2, stdout: '', error: '' };
        }
        return this.write(RECORD_BUDGET_MS, s.sql);
    }
    fixedWrite(ms, id) {
        if (!/^F[0-9]+-[0-9]+$/.test(id))
            return this.invalid(`invalid finding id '${id}'`);
        return this.write(ms, `UPDATE review_findings SET status = 'fixed', resolved_at = '${nowIso()}' WHERE id = '${sqlQuote(id)}' AND status = 'open';`);
    }
    recordCommand(ordinal, command, rc, elapsed, output) {
        if (this.runId === '')
            return;
        const ms = this.allowanceMs();
        if (ms === null) {
            if (!this.poolNoted) {
                this.poolNoted = true;
                stderr(`${GATE_NAME}: run-record write budget (${RECORD_POOL_MS}ms) spent; verification run #${this.runId} keeps no further command rows\n`);
            }
            return;
        }
        const t0 = Date.now();
        this.commandWrite(ms, ordinal, command, rc, elapsed, output);
        this.recordMs += Date.now() - t0;
    }
    async recordFinish(rc, timedOut) {
        if (this.runId === '')
            return;
        for (let attempt = 1;; attempt += 1) {
            if (this.finishWrite(rc, timedOut).ok)
                return;
            if (attempt >= FINISH_ATTEMPTS)
                break;
            await sleep(attempt * FINISH_BACKOFF_MS);
        }
        stderr(`${GATE_NAME}: verification run #${this.runId} record unfinished — its finish write failed ${FINISH_ATTEMPTS} times; the decision stands (trajectory_doctor reports it under no_unfinished_verification_runs after 2 h)\n`);
    }
    recordNote() {
        if (this.runId !== '')
            return ` Recorded as verification run #${this.runId}.`;
        return this.c.wtSha === '' ? ' (not recorded: worktree HEAD unresolvable)' : '';
    }
    activeMs() {
        return Date.now() - this.runStart - this.recordMs;
    }
    timeoutReason(ordinal, command, elapsed, cumulative) {
        const ran = elapsed !== '' ? ` after ${elapsed}s` : '';
        return commandSubstitution(`BLOCKED: verification timed out — the ${this.c.timeoutS}s budget${this.c.setupS !== undefined ? ` left after ${this.c.setupS}s of worktree setup` : ''} ran out ${cumulative}s in, while running command ${ordinal}/${this.c.cmdTotal}${ran}:\n${command}\n\nRaise plugin_config.verification_timeout_s (config_set; capped at ${VERIFICATION_MAX_S}s) or speed up the command.${this.recordNote()}`);
    }
    async planCarry() {
        const plan = await planCarrySafe({ db: this.c.db, taskId: this.c.taskId, worktree: this.c.worktree, head: this.c.wtSha, commandsJson: this.c.gateCmdsJson }, { ...this.c.env, PATH: this.c.toolchainPath });
        if (typeof plan.source_run !== 'number' || typeof plan.source_sha !== 'string' || !Array.isArray(plan.carry))
            return;
        const run = String(plan.source_run);
        const ords = plan.carry.map(String).join(' ');
        if (!/^[0-9]+$/.test(run))
            return;
        if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(plan.source_sha))
            return;
        if (!/^[0-9]+( [0-9]+)*$/.test(ords))
            return;
        this.carryRun = run;
        this.carrySha = plan.source_sha;
        this.carryOrdinals = new Set(plan.carry);
    }
    execute(command, seconds, outPath) {
        return new Promise((done) => {
            const fd = openSync(outPath, 'w');
            let fired = false;
            let settled = false;
            const finish = (rc) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                done({ rc, fired });
            };
            const child = spawn('bash', ['-c', command], {
                cwd: this.c.worktree,
                env: { ...this.c.env, PATH: this.c.toolchainPath, PWD: this.c.worktree },
                stdio: ['ignore', fd, fd],
                detached: true,
            });
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
                    finish(124);
                else
                    finish(code ?? 128 + (signal !== null ? (signals[signal] ?? 0) : 0));
            });
        });
    }
    /** run_one: <runCmd> in the worktree within the remaining budget, recorded as <recordedCmd>; a deny string when the budget ran out. */
    async runOne(runCmd, recordedCmd) {
        this.ordinal += 1;
        const ordinal = this.ordinal;
        const remaining = this.c.timeoutS - Math.trunc(this.activeMs() / 1000);
        if (remaining <= 0) {
            await this.recordFinish(124, 1);
            return deny(this.timeoutReason(ordinal, recordedCmd, '', msToS(this.activeMs())), 'policy');
        }
        const outPath = `${this.c.scratch}/out-${ordinal}`;
        const cmdStart = Date.now();
        const { rc, fired } = await this.execute(runCmd, remaining, outPath);
        const cmdMs = Date.now() - cmdStart;
        let out = '';
        try {
            out = commandSubstitution(readFileSync(outPath, 'utf8'));
            rmSync(outPath, { force: true });
        }
        catch {
            /* no output file */
        }
        const elapsed = msToS(cmdMs);
        const total = msToS(this.activeMs());
        const tail = lastLines(out, TAIL_LINES);
        this.recordCommand(ordinal, recordedCmd, rc, elapsed, tail);
        if (rc === 124 && fired) {
            await this.recordFinish(124, 1);
            return deny(this.timeoutReason(ordinal, recordedCmd, elapsed, total), 'policy');
        }
        return { rc, out, elapsed, total, tail };
    }
    /** run_verification: the deny decision, the pass context, or "" when every command passed. */
    async run() {
        const c = this.c;
        this.runStart = Date.now();
        if (c.wtSha !== '') {
            const ms = this.allowanceMs();
            if (ms !== null) {
                this.runId = this.start(ms);
                this.recordMs = Date.now() - this.runStart;
            }
        }
        if (this.runId !== '')
            await this.planCarry();
        const carried = [];
        for (const cmd of c.commands) {
            if (this.carryOrdinals.has(this.ordinal + 1)) {
                this.ordinal += 1;
                this.recordCommand(this.ordinal, cmd, 0, '0', `carried from run #${this.carryRun} at ${this.carrySha.slice(0, 12)}`);
                carried.push(cmd);
                continue;
            }
            const r = await this.runOne(cmd, cmd);
            if (typeof r === 'string')
                return r;
            if (r.rc !== 0) {
                await this.recordFinish(r.rc, 0);
                const hits = failureLines(r.out);
                const hitsBlock = hits !== '' ? `\n\nFailure lines (max ${FAILURE_LINES}):\n${hits}` : '';
                return deny(commandSubstitution(`BLOCKED: verification failed.\nFailing command (${this.ordinal}/${c.cmdTotal}): ${cmd}\nExit ${r.rc} after ${r.elapsed}s; ${r.total}s cumulative.${this.recordNote()}${hitsBlock}\n\nOutput (last ${TAIL_LINES} lines):\n${r.tail}`), RETRY_FIXED);
            }
        }
        let probeFail = '';
        let probeRc = 0;
        for (const f of c.findings) {
            const fid = commandSubstitution(jqRawText(f.id));
            const fstatus = commandSubstitution(jqRawText(f.status));
            const pcmd = commandSubstitution(jqRawText(f.probe_cmd));
            const r = await this.runOne(pcmd, `[probe ${fid}] ${pcmd}`);
            if (typeof r === 'string')
                return r;
            if (r.rc === 0) {
                if (fstatus === 'open') {
                    const ms = this.allowanceMs();
                    if (ms !== null) {
                        const t0 = Date.now();
                        if (!this.fixedWrite(ms, fid).ok)
                            stderr(`${GATE_NAME}: review finding ${fid} probe passed but its fixed write failed; it stays open\n`);
                        this.recordMs += Date.now() - t0;
                    }
                    else {
                        stderr(`${GATE_NAME}: run-record write budget (${RECORD_POOL_MS}ms) spent; review finding ${fid} probe passed but it stays open\n`);
                    }
                }
                continue;
            }
            if (probeRc === 0)
                probeRc = r.rc;
            const regressed = fstatus === 'fixed' ? ' — REGRESSION: this finding was fixed and its probe fails again' : '';
            probeFail += commandSubstitution(`\n\nFinding ${fid} (probe ${this.ordinal}/${c.cmdTotal})${regressed}: ${pcmd}\nExit ${r.rc} after ${r.elapsed}s.\nOutput (last ${TAIL_LINES} lines):\n${r.tail}`);
        }
        if (probeFail !== '') {
            await this.recordFinish(probeRc, 0);
            return deny(`BLOCKED: verification failed — review finding probe(s) failed; ${msToS(this.activeMs())}s cumulative.${this.recordNote()}${probeFail}\n\nFix each finding so its probe exits 0 (task_brief.open_findings lists the open ones).`, RETRY_FIXED);
        }
        await this.recordFinish(0, 0);
        if (c.wtSha === '')
            return UNRECORDED_PASS_CONTEXT;
        if (carried.length > 0) {
            return context(`TMB: verification carried forward from run #${this.carryRun} at ${this.carrySha.slice(0, 12)} — this commit touched none of their declared inputs (.config/tmb/verification-inputs.json), so these commands were not run again; the rest of the ${c.cmdTotal} ran:\n${carried.join('\n')}`);
        }
        return '';
    }
}
function nowS() {
    return Math.floor(Date.now() / 1000);
}
/** lock_held_since: the holder's `started` stamp, else the lock dir's mtime; null when neither reads. */
function lockHeldSince(lock) {
    try {
        const since = commandSubstitution(readFileSync(`${lock}/started`, 'utf8'));
        if (/^[0-9]+$/.test(since))
            return Number(since);
    }
    catch {
        /* no stamp */
    }
    try {
        return Math.floor(statSync(lock).mtimeMs / 1000);
    }
    catch {
        return null;
    }
}
function tryMkdir(dir) {
    try {
        mkdirSync(dir);
        return true;
    }
    catch {
        return false;
    }
}
/** `rm -rf <path> 2>/dev/null || true`. */
function removeQuietly(path) {
    try {
        rmSync(path, { recursive: true, force: true });
    }
    catch {
        /* left behind */
    }
}
/** Takes the run lock of (task, HEAD), reclaiming one older than <staleS>, and waiting out a live holder. */
async function acquireLock(lock, staleS) {
    while (!tryMkdir(lock)) {
        const held = lockHeldSince(lock) ?? nowS();
        if (nowS() - held > staleS) {
            removeQuietly(lock);
            continue;
        }
        while (isDir(lock)) {
            await sleep(LOCK_POLL_MS);
            const since = lockHeldSince(lock);
            if (since === null)
                continue;
            if (nowS() - since > staleS)
                break;
        }
    }
}
function makeScratch(db) {
    try {
        return resolve(mkdtempSync(`${posixDirname(db)}/verify-run.`));
    }
    catch {
        return mkdtempSync(`${tmpdir()}/verify-run.`);
    }
}
function waive(db, taskId, reason, field, env) {
    const row = gateRead(db, `SELECT COALESCE(issue_id, -1) || '|' || COALESCE(branch_id, '') || '|' || COALESCE(commit_sha, '') FROM tasks WHERE id = ${taskId} LIMIT 1;`, env);
    if (row === GATE_READ_ERROR)
        return { stdout: `${denyDbUnavailable(`${GATE_NAME} (waiver)`, env)}\n`, code: 0 };
    if (row === '')
        return ALLOW;
    const rest = afterBar(row);
    const sha = field('commit_sha') || afterBar(rest);
    const r = auditAppend(db, {
        issueId: beforeBar(row),
        branchId: beforeBar(rest),
        fromNode: `hook:${GATE_NAME}`,
        eventType: 'verification_gate_waived',
        summary: `SWE waived verification gate for task_id=${taskId}`,
        contentJson: `{"task_id":${jqNumberLiteral(taskId)},"commit_sha":${jqCompact(sha)},"waiver_reason":${jqCompact(reason)}}`,
        dedupePaths: ['$.task_id', '$.commit_sha'],
    }, { caller: GATE_NAME, env });
    if (r.ok)
        return { stdout: r.stdout, code: 0 };
    if (r.error !== '')
        stderr(`${r.error}\n`);
    return { stdout: `${r.stdout}${WAIVER_UNRECORDED_DENY}`, code: 0 };
}
/**
 * <result> with the doc checks' skip <notes> added to an allow's additionalContext; a deny,
 * or stdout that is not one hook JSON object, stays as is.
 */
function withDocNotes(result, notes) {
    if (notes.length === 0)
        return result;
    const note = `TMB: ${notes.join(' ')}`;
    const out = result.stdout.trim();
    if (out === '')
        return { ...result, stdout: context(note) };
    let parsed;
    try {
        parsed = JSON.parse(out);
    }
    catch {
        return result;
    }
    const output = parsed.hookSpecificOutput;
    if (output === undefined || output.permissionDecision !== undefined)
        return result;
    const prior = typeof output.additionalContext === 'string' && output.additionalContext !== '' ? `${output.additionalContext}\n\n` : '';
    return { ...result, stdout: context(`${prior}${note}`) };
}
/**
 * The changelog and stale-doc checks and the leak scan of the worktree HEAD against its merge base
 * with the task's PR target: the deny when one fails or cannot be proven, else null with each
 * skipped check's note pushed onto <notes>.
 */
/** The task's PR target ref as prTargetRef resolves it, null when none resolves, or GATE_READ_ERROR. */
async function taskPrTargetRef(db, taskId, worktree, env) {
    const row = gateRead(db, `SELECT 'row|' || COALESCE(t.parent_branch_id, '') || '|' || COALESCE((SELECT r.target_branch FROM repos r
              WHERE r.name = t.repo OR (COALESCE(t.repo, '') = '' AND (SELECT COUNT(*) FROM repos) = 1) LIMIT 1), '')
       FROM tasks t WHERE t.id = ${taskId} LIMIT 1;`, env);
    if (row === GATE_READ_ERROR)
        return GATE_READ_ERROR;
    const [, parentBranch = '', targetBranch = ''] = row.split('|');
    return await prTargetRef(worktree, targetBranch, parentBranch, env);
}
async function docGate(db, taskId, worktree, env, notes) {
    const targetRef = await taskPrTargetRef(db, taskId, worktree, env);
    if (targetRef === GATE_READ_ERROR)
        return { stdout: DB_UNAVAILABLE_DENY, code: 0 };
    const unproven = (expected, actual) => structuredDenyResult({ check: 'stale_doc_ref', expected, actual }, RETRY_FIXED);
    const head = await revParse(worktree, 'HEAD', env);
    if (head === null)
        return unproven('the worktree HEAD resolves to a commit', `git rev-parse HEAD failed in ${worktree}`);
    const targetTip = targetRef === null ? null : await revParse(worktree, targetRef, env);
    if (targetRef === null || targetTip === null) {
        return unproven(`${head} has a merge base with the PR target`, `no PR target ref resolves in ${worktree}`);
    }
    const mergeBase = (await gitText(worktree, ['merge-base', targetTip, head], env)).stdout.trim();
    if (mergeBase === '')
        return unproven(`${head} shares history with ${targetRef} (${targetTip})`, 'no merge-base');
    const result = await docChecks(worktree, mergeBase, head, env);
    if (result.failure !== null)
        return structuredDenyResult(result.failure, RETRY_FIXED);
    const leak = await leakScan(worktree, mergeBase, head, env);
    if (leak !== null)
        return structuredDenyResult(leak, RETRY_FIXED);
    notes.push(...result.notes);
    return null;
}
/** The task's no_code_class, '' when it has none or the DB predates the column (v72), or GATE_READ_ERROR. */
function taskNoCodeClass(db, taskId, env) {
    const column = gateRead(db, "SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name = 'no_code_class';", env);
    if (column === GATE_READ_ERROR)
        return GATE_READ_ERROR;
    if (column !== '1')
        return '';
    return gateRead(db, `SELECT COALESCE(no_code_class, '') FROM tasks WHERE id = ${taskId} LIMIT 1;`, env);
}
const NO_CODE_FIX = {
    allowed: "revert the code paths from the task's commits and close again; a code change goes to swe through its own task",
};
function noCodeDenied(reason, fix = NO_CODE_FIX) {
    return { stdout: deny(`BLOCKED: bro's close of a no-code task needs every changed path classed docs or prompts. ${reason}`, fix), code: 0 };
}
/** Each path the commits <shas> change since their merge base with <from>, renames as delete plus add. */
async function changedSince(worktree, from, shas, env) {
    const paths = new Set();
    for (const sha of shas) {
        const mergeBase = (await gitText(worktree, ['merge-base', from, sha], env)).stdout.trim();
        if (mergeBase === '')
            return `no merge-base of ${sha} with ${from}`;
        const diff = await gitText(worktree, ['diff', '--name-only', '--no-renames', '-z', mergeBase, sha], env);
        if (diff.code !== 0)
            return `git diff ${mergeBase} ${sha} failed: ${firstLine(diff.stderr)}`;
        for (const path of nulFields(diff.stdout))
            paths.add(path);
    }
    return [...paths];
}
/**
 * GH 3075: a bro close of a no-code task classes the task's own diff, from its merge
 * base with origin/<PR target> to the closing commit (and the worktree HEAD verification
 * runs on), by the path classes committed at base_sha, and denies a code or mixed
 * change. Measuring from the PR target leaves out target commits merged into the task
 * branch; with no origin ref for the target it measures from base_sha instead.
 */
async function noCodeGate(db, taskId, worktree, commitSha, env) {
    const baseSha = gateRead(db, `SELECT COALESCE(base_sha, '') FROM tasks WHERE id = ${taskId} LIMIT 1;`, env);
    if (baseSha === GATE_READ_ERROR)
        return { stdout: DB_UNAVAILABLE_DENY, code: 0 };
    if (baseSha === '')
        return noCodeDenied(`Task #${taskId} has no base_sha to class its diff against.`, 'policy');
    const head = await revParse(worktree, 'HEAD', env);
    if (head === null)
        return noCodeDenied(`git rev-parse HEAD failed in ${worktree}.`, RETRY_FIXED);
    const closing = commitSha === '' ? head : await revParse(worktree, commitSha, env);
    if (closing === null)
        return noCodeDenied(`commit_sha ${commitSha} does not resolve in ${worktree}.`, RETRY_FIXED);
    const targetRef = await taskPrTargetRef(db, taskId, worktree, env);
    if (targetRef === GATE_READ_ERROR)
        return { stdout: DB_UNAVAILABLE_DENY, code: 0 };
    const from = targetRef?.startsWith('origin/') ? targetRef : baseSha;
    const changed = await changedSince(worktree, from, closing === head ? [head] : [closing, head], env);
    if (typeof changed === 'string')
        return noCodeDenied(`Its diff cannot be listed: ${changed}.`, RETRY_FIXED);
    const read = readPathClasses(worktree, baseSha);
    if ('error' in read)
        return noCodeDenied(`${PATH_CLASSES_FILE} at ${baseSha} cannot be read: ${read.error}.`, 'policy');
    const changeClass = classifyChange(changed, read.classes);
    if (changeClass === 'docs' || changeClass === 'prompts')
        return null;
    if (changed.length === 0)
        return noCodeDenied(`The task changes no path since its merge base with ${from}.`, RETRY_FIXED);
    const codePaths = changed.filter((path) => classifyPath(path, read.classes) === 'code');
    const why = read.classes === null ? `${PATH_CLASSES_FILE} is absent at ${baseSha}, so every path is code. ` : '';
    return noCodeDenied(`${why}The diff is ${changeClass}; its code paths go to swe: ${codePaths.join(', ')}.`);
}
export const sweVerificationGate = async (payload, env) => {
    const docNotes = [];
    return withDocNotes(await verifyCompletion(payload, env, docNotes), docNotes);
};
async function verifyCompletion(payload, env, docNotes) {
    const input = `${commandSubstitution(payload)}\n`;
    const field = (key) => commandSubstitution(rawOrEmpty(input, ['tool_input', key]));
    const role = normalizeRole(field('agent'));
    if (role !== 'swe' && role !== 'bro')
        return ALLOW;
    if (field('status') !== 'completed')
        return ALLOW;
    const taskId = field('task_id');
    if (!/^[0-9]+$/.test(taskId))
        return ALLOW;
    const db = dbPath(env, (line) => stderr(`${line}\n`));
    if (db === null || !haveSqlite(env))
        return ALLOW;
    const genv = { ...env, TMB_DB_WRITE_TIMEOUT_MS: '5000', TMB_DB_WRITE_RUN_BUDGET_MS: '10200' };
    const broNoCode = role === 'bro';
    if (broNoCode) {
        const noCodeClass = taskNoCodeClass(db, taskId, genv);
        if (noCodeClass === GATE_READ_ERROR)
            return { stdout: DB_UNAVAILABLE_DENY, code: 0 };
        if (noCodeClass === '')
            return ALLOW;
    }
    const verificationJson = sqliteRo(db, `SELECT COALESCE(verification, '[]') FROM tasks WHERE id = ${taskId} LIMIT 1;`, genv);
    const branchId = gateRead(db, `SELECT COALESCE(branch_id, '') FROM tasks WHERE id = ${taskId} LIMIT 1;`, genv);
    if (branchId === GATE_READ_ERROR)
        return { stdout: DB_UNAVAILABLE_DENY, code: 0 };
    const taskRepo = sqliteRo(db, `SELECT COALESCE(repo, '') FROM tasks WHERE id = ${taskId} LIMIT 1;`, genv);
    if (branchId === '')
        return ALLOW;
    const findingsJson = reviewFindingsActive(db, taskId, genv);
    if (findingsJson === GATE_READ_ERROR)
        return { stdout: DB_UNAVAILABLE_DENY, code: 0 };
    const findings = parseFindings(findingsJson);
    const block = commandSubstitution(jqRawElements(verificationJson));
    const waiver = field('waive_verification_gate_reason');
    const waived = waiver !== '' && shellLength(waiver, genv) >= 10;
    const slug = branchSlug(branchId);
    const wsRoot = posixDirname(posixDirname(posixDirname(db)));
    const repoRoot = taskRepo !== '' ? repoPathByName(db, taskRepo, genv) || `${wsRoot}/${taskRepo}` : repoSinglePath(db, genv) || wsRoot;
    const worktree = `${repoRoot}/.claude/worktrees/${slug}`;
    if (repoRoot === '' || !isDir(worktree)) {
        const missingAt = `${repoRoot || wsRoot || '?'}/.claude/worktrees/${slug}`;
        const reason = waived || (block === '' && findings.length === 0)
            ? `BLOCKED: verification gate could not locate the task worktree at ${missingAt}, so it cannot run the changelog and doc checks on its HEAD. Ensure SWE ran in its registered worktree (ensure-swe-worktree creates it under <repoRoot>/.claude/worktrees/<slug>) and verify the task's repo maps to the correct repos.path.`
            : `BLOCKED: verification gate could not locate the task worktree at ${missingAt} — refusing to fail open with non-empty verification[]. Ensure SWE ran in its registered worktree (ensure-swe-worktree creates it under <repoRoot>/.claude/worktrees/<slug>), verify the task's repo maps to the correct repos.path, or set waive_verification_gate_reason.`;
        return { stdout: deny(reason, 'policy'), code: 0 };
    }
    if (broNoCode) {
        const noCodeDeny = await noCodeGate(db, taskId, worktree, field('commit_sha'), genv);
        if (noCodeDeny !== null)
            return noCodeDeny;
    }
    const docDeny = await docGate(db, taskId, worktree, genv, docNotes);
    if (docDeny !== null)
        return docDeny;
    if (waived)
        return waive(db, taskId, waiver, field, genv);
    if (block === '' && findings.length === 0)
        return { stdout: NO_VERIFICATION_CONTEXT, code: 0 };
    const toolchainPath = joinToolchainPath(toolchainDirs(genv, worktree), genv.PATH ?? '');
    const budget = parseBudget(genv.TMB_VERIFICATION_TIMEOUT_S || sqliteRo(db, "SELECT json_extract(value_json, '$') FROM plugin_config WHERE key = 'verification_timeout_s';", genv));
    if (budget.warning !== '')
        stderr(budget.warning);
    const head = await gitRun(worktree, ['rev-parse', '--verify', '-q', 'HEAD'], genv);
    const wtSha = head.code === 0 ? commandSubstitution(head.stdout) : '';
    const expectedSha = field('commit_sha');
    const commands = block.split('\n').filter((line) => line !== '');
    const gateCmdsJson = jqCompact([...commands, ...findings.map(probeCommand)]);
    const scratch = makeScratch(db);
    let lock = '';
    let verifiedMs = 0;
    try {
        const ctx = {
            db,
            taskId,
            worktree,
            wtSha,
            timeoutS: budget.timeoutS,
            commands,
            findings,
            cmdTotal: commands.length + findings.length,
            gateCmdsJson,
            toolchainPath,
            scratch,
            env: genv,
        };
        const reuse = () => {
            if (wtSha === '')
                return null;
            if (expectedSha !== '' && !wtSha.startsWith(expectedSha))
                return null;
            const row = reusableRun(db, taskId, wtSha, gateCmdsJson, genv);
            if (row === '')
                return null;
            return context(`TMB: verification reused run #${beforeBar(row)} (${afterBar(row)}) — verification[] passed on commit ${wtSha} within the last hour, so it was not run again.`);
        };
        const setupThenRun = async (runCtx) => {
            const ranFrom = Date.now();
            try {
                return await setupThenVerify(runCtx);
            }
            finally {
                verifiedMs += Date.now() - ranFrom;
            }
        };
        const setupThenVerify = async (runCtx) => {
            const setupStart = Date.now();
            const setup = await runWorktreeSetup(worktree, { env: { ...runCtx.env, PATH: toolchainPath }, totalTimeoutMs: runCtx.timeoutS * 1000 });
            const setupS = Math.ceil((Date.now() - setupStart) / 1000);
            const raise = `Raise plugin_config.verification_timeout_s (config_set; capped at ${VERIFICATION_MAX_S}s) or speed up setup.`;
            if (setup.error !== undefined) {
                const timedOut = setup.commands.some((c) => c.timed_out);
                return deny(`BLOCKED: worktree setup failed, so verification[] did not run and no verification run was recorded.\n${describeSetupFailure(setup)}\n\n${timedOut ? `Worktree setup counts against the ${runCtx.timeoutS}s verification budget. ${raise}` : `Fix the command or ${WORKTREE_SETUP_FILE}.`}`, timedOut ? 'policy' : RETRY_FIXED);
            }
            if (!setup.ran)
                return new VerificationRun(runCtx).run();
            const leftS = runCtx.timeoutS - setupS;
            if (leftS <= 0) {
                return deny(`BLOCKED: worktree setup used up the ${runCtx.timeoutS}s verification budget (${setupS}s), so verification[] did not run and no verification run was recorded. ${raise}`, 'policy');
            }
            return new VerificationRun({ ...runCtx, timeoutS: leftS, setupS }).run();
        };
        const suiteCommand = [...commands, ...findings.map((f) => (typeof f.probe_cmd === 'string' ? f.probe_cmd : ''))].find(isFullSuite);
        const verify = async () => {
            if (suiteCommand === undefined)
                return setupThenRun(ctx);
            const fullCapS = suiteWaitCapS(budget.timeoutS);
            const capOverride = genv.TMB_SUITE_WAIT_CAP_S ?? '';
            const capS = /^[0-9]{1,6}$/.test(capOverride) ? Math.min(Number(capOverride), fullCapS) : fullCapS;
            const capWhy = capS === fullCapS
                ? `the ${TRAJECTORY_PRETOOLUSE_TIMEOUT_S}s hook timeout less ${SUITE_WAIT_MARGIN_S}s and the ${budget.timeoutS}s verification budget`
                : 'set by TMB_SUITE_WAIT_CAP_S';
            const slot = await acquireSuiteSlot({ command: suiteCommand, worktree, env: genv, maxWaitS: capS, stderr });
            if (slot.kind === 'busy') {
                return deny(`BLOCKED: suite slot busy — every suite slot is ${describeHolder(slot.holder)}; waited ${slot.waitedS}s, the cap of ${capS}s (${capWhy}). No verification run was recorded.`, { allowed: "task_update_status(status='completed', commit_sha, report) again once that suite finishes" });
            }
            try {
                const reusedAfterSlot = reuse();
                if (reusedAfterSlot !== null)
                    return reusedAfterSlot;
                const env = slot.kind === 'held' ? { ...genv, [SUITE_LOCK_HELD_ENV]: slot.slot } : genv;
                return await setupThenRun({ ...ctx, env });
            }
            finally {
                if (slot.kind === 'held')
                    slot.release();
            }
        };
        const closeLints = async (verified) => {
            if (wtSha === '' || jqCapture(jqInput(verified), ['hookSpecificOutput', 'permissionDecision']) === 'deny')
                return verified;
            const target = { db, taskId, source: 'gate' };
            const baseSha = await lintBaseSha(worktree, db, taskId, wtSha, genv);
            if (baseSha === '') {
                return deny(`BLOCKED: close lints did not run — no merge-base of ${wtSha} with the task's PR target (repos.target_branch, parent_branch_id, else the repo default) resolves in ${worktree}, and the lint record names one.`, 'policy');
            }
            const plan = await closeLintsPlan(worktree, wtSha, genv);
            if (typeof plan === 'string')
                return deny(`BLOCKED: close lints did not run — ${plan}`, RETRY_FIXED);
            if (reusableLintRun(target, wtSha, baseSha, plan.fingerprint, genv) !== null)
                return verified;
            const leftS = budget.timeoutS - Math.ceil(verifiedMs / 1000);
            const run = await runCloseLints(worktree, wtSha, baseSha, leftS, { ...genv, PATH: toolchainPath }, target);
            if (typeof run === 'string')
                return deny(`BLOCKED: close lints did not run — ${run}`, DB_RETRY_FIX);
            if (run.exitCode === 0)
                return verified;
            const timedOut = run.failures.some((f) => f.exitCode === LINT_TIMED_OUT);
            return deny(commandSubstitution(`BLOCKED: close lints failed on ${wtSha} — ${run.failures.length} of ${run.results.length} failed; recorded as ${runLabel(run)}. verification[] passed; the close lints (${CLOSE_LINTS_PATH}) run after it.\n\n${describeFailures(run)}${timedOut ? `\n\nThe close lints get what verification[] leaves of the ${budget.timeoutS}s budget; raise plugin_config.verification_timeout_s (config_set; capped at ${VERIFICATION_MAX_S}s) or speed up the lint.` : ''}`), RETRY_FIXED);
        };
        const reused = reuse();
        if (reused !== null)
            return { stdout: await closeLints(reused), code: 0 };
        if (wtSha === '')
            return { stdout: await verify(), code: 0 };
        const lockRoot = `${posixDirname(db)}/locks`;
        try {
            mkdirSync(lockRoot, { recursive: true });
        }
        catch {
            return { stdout: await closeLints(await verify()), code: 0 };
        }
        const lockDir = `${lockRoot}/verify-${taskId}-${wtSha}`;
        await acquireLock(lockDir, budget.timeoutS + 60);
        lock = lockDir;
        try {
            writeFileSync(`${lock}/started`, `${nowS()}\n`);
        }
        catch {
            /* the mtime stands in */
        }
        const reusedAfterWait = reuse();
        if (reusedAfterWait !== null)
            return { stdout: await closeLints(reusedAfterWait), code: 0 };
        return { stdout: await closeLints(await verify()), code: 0 };
    }
    finally {
        if (lock !== '')
            removeQuietly(lock);
        removeQuietly(scratch);
    }
}
//# sourceMappingURL=swe-verification-gate.js.map