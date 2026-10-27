/**
 * PreToolUse gate (GH 1692), the port of scripts/hooks/swe-verification-gate.sh:
 * a swe's task_update_status(status='completed') runs the task's typed
 * verification[] (Typed Rails #673), then the probe_cmd of every review
 * finding not wontfix (GH 1737), in the task worktree, and denies on a failing
 * command or a spent budget.
 *
 * A non-swe caller, another status, no task id or no resolvable DB allows. A
 * waive_verification_gate_reason of at least 10 characters allows and writes
 * one verification_gate_waived audit row per (task, commit). An empty
 * verification[] with no finding allows with a warning; an unlocatable
 * worktree denies. A passing run of the same commands on the worktree HEAD
 * from the last hour is reused (GH 1672); otherwise the run is recorded in
 * verification_runs under a per-(task, HEAD) mkdir lock, commands the task's
 * last passing ancestor run carries forward are recorded, not run (GH 1950),
 * and the rest run through `bash -c` with the user's toolchain PATH.
 *
 * Budget: plugin_config.verification_timeout_s or TMB_VERIFICATION_TIMEOUT_S,
 * default 900 s, clamped to [1, 1800]; it counts command time only. The record
 * writes have their own per-write and pooled budgets, and the finish write is
 * tried three times. timed_out is 1 only when the gate's own timer fired or
 * the budget was spent before a command started; a timed-out command's
 * process group is killed.
 *
 * Unlike the .sh, it needs neither jq nor the sqlite3 CLI, so without them it
 * still runs verification[] and denies a failing command where the .sh let
 * every completion through (decision 703).
 */
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ALLOW } from './gate.js';
import { auditAppend, dbWrite, nowIso } from './lib/audit.js';
import { branchSlug, dbPath, denyDbUnavailable, GATE_READ_ERROR, gateRead, haveSqlite, sqliteRo, sqlQuote } from './lib/db.js';
import { gitRun, isDir } from './lib/git.js';
import { firstLine } from './lib/host.js';
import { jqCompact, jqNumberLiteral, jqRawElements } from './lib/jq.js';
import { commandSubstitution, ctypeUtf8, jqRawText, posixDirname } from './lib/project-env.js';
import { repoSinglePath } from './lib/repo.js';
import { normalizeRole } from './lib/role.js';
import { planCarrySafe } from './lib/verification-carry.js';
import { rawOrEmpty } from './swe-brief-gate.js';
export const GATE_NAME = 'swe-verification-gate';
export const VERIFICATION_DEFAULT_S = 900;
export const VERIFICATION_MAX_S = 1800;
const RECORD_BUDGET_MS = 3000;
const RECORD_POOL_MS = 9000;
const FINISH_ATTEMPTS = 3;
const FINISH_BACKOFF_MS = 500;
const LOCK_POLL_MS = 500;
const TAIL_LINES = 20;
const FAILURE_LINES = 15;
const DEFAULT_TAIL_CHARS = 4000;
const signals = osConstants.signals;
const DB_UNAVAILABLE_DENY = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: trajectory DB unavailable — the verification gate could not read the task row, so it refuses to fail open. Check the trajectory DB (sqlite3 error on read) and retry."}}\n';
const WAIVER_UNRECORDED_DENY = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: trajectory DB unavailable — the verification-gate waiver could not be recorded, so it cannot be honoured. Retry once the DB is writable."}}\n';
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
function deny(reason) {
    return `${jqCompact({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`;
}
function context(text) {
    return `${jqCompact({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } })}\n`;
}
/** bash's `${#s}`: code points under a UTF-8 LC_CTYPE, bytes under C. */
export function shellLength(s, env) {
    return ctypeUtf8(env) ? [...s].length : Buffer.byteLength(s);
}
/** bash's `${s: -n}` for n > 0, in the units shellLength counts. */
function shellTail(s, n, env) {
    if (ctypeUtf8(env))
        return [...s].slice(-n).join('');
    const bytes = Buffer.from(s);
    return bytes.subarray(Math.max(0, bytes.length - n)).toString('utf8');
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
function capture(cmd, args, env) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] });
    return r.stdout ?? '';
}
/** tmb_user_toolchain_dirs: mise shims and bin-paths, Homebrew, ~/.local/bin and bun, in that order. */
export function toolchainDirs(env) {
    const home = env.HOME ?? '';
    const out = [];
    const miseData = env.MISE_DATA_DIR || `${env.XDG_DATA_HOME || `${home}/.local/share`}/mise`;
    if (isDir(`${miseData}/shims`))
        out.push(`${miseData}/shims`);
    const mise = [env.MISE_INSTALL_PATH ?? '', '/opt/homebrew/bin/mise', '/usr/local/bin/mise', `${home}/.local/bin/mise`].find(executable);
    if (mise !== undefined)
        out.push(...capture(mise, ['bin-paths'], env).split('\n'));
    const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(executable);
    const brewPrefix = brew === undefined ? '' : commandSubstitution(capture(brew, ['--prefix'], env));
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
function reviewFindingsActive(db, taskId, env) {
    const has = gateRead(db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'review_findings';", env);
    if (has === GATE_READ_ERROR)
        return GATE_READ_ERROR;
    if (has !== '1')
        return '[]';
    const out = gateRead(db, `SELECT COALESCE(json_group_array(json_object('id', id, 'status', status, 'probe_cmd', probe_cmd)), '[]')
     FROM (SELECT id, status, probe_cmd FROM review_findings
            WHERE task_id = ${taskId} AND status <> 'wontfix'
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
function reusableRun(db, taskId, sha, commandsJson, env) {
    const cmds = sqlQuote(commandsJson);
    return sqliteRo(db, `SELECT r.id || '|' || r.finished_at FROM verification_runs r
     WHERE r.task_id = ${taskId} AND r.commit_sha = '${sqlQuote(sha)}'
       AND r.exit_code = 0 AND r.timed_out = 0 AND r.finished_at IS NOT NULL
       AND r.finished_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3600 seconds')
       AND json_valid('${cmds}')
       AND (SELECT COUNT(*) FROM verification_run_commands c WHERE c.run_id = r.id) = json_array_length('${cmds}')
       AND NOT EXISTS (SELECT 1 FROM json_each('${cmds}') e
             LEFT JOIN verification_run_commands c ON c.run_id = r.id AND c.ordinal = e.key + 1
            WHERE c.command IS NOT e.value)
     ORDER BY r.finished_at DESC, r.id DESC LIMIT 1;`, env);
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
        const now = nowIso();
        const r = this.write(ms, `UPDATE verification_runs SET finished_at = '${now}', exit_code = 137, timed_out = 0
 WHERE finished_at IS NULL
   AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at) < strftime('%Y-%m-%dT%H:%M:%fZ', '${now}', '-' || (budget_s + 60) || ' seconds');
INSERT INTO verification_runs (task_id, commit_sha, source, started_at, budget_s) VALUES (${this.c.taskId}, '${sqlQuote(this.c.wtSha)}', 'gate', '${now}', ${this.c.timeoutS});
SELECT last_insert_rowid();`);
        return r.ok ? commandSubstitution(r.stdout) : '';
    }
    commandWrite(ms, ordinal, command, rc, elapsed, output) {
        if (!/^[0-9]+$/.test(this.runId)) {
            this.invalid(`invalid run_id '${this.runId}'`);
            return;
        }
        const rawCap = this.c.env.TMB_VERIFICATION_TAIL_CHARS || String(DEFAULT_TAIL_CHARS);
        const cap = /^[0-9]+$/.test(rawCap) ? Number(rawCap) : DEFAULT_TAIL_CHARS;
        const tail = cap > 0 && shellLength(output, this.c.env) > cap ? shellTail(output, cap, this.c.env) : output;
        this.write(ms, `INSERT INTO verification_run_commands (run_id, ordinal, command, exit_code, elapsed_s, output_tail) VALUES (${this.runId}, ${ordinal}, '${sqlQuote(command)}', ${rc}, ${elapsed}, '${sqlQuote(tail)}');`);
    }
    finishWrite(rc, timedOut) {
        if (!/^[0-9]+$/.test(this.runId))
            return this.invalid(`invalid run_id '${this.runId}'`);
        return this.write(RECORD_BUDGET_MS, `UPDATE verification_runs SET finished_at = '${nowIso()}', exit_code = ${rc}, timed_out = ${timedOut} WHERE id = ${this.runId};`);
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
        return commandSubstitution(`BLOCKED: verification timed out — the ${this.c.timeoutS}s budget ran out ${cumulative}s in, while running command ${ordinal}/${this.c.cmdTotal}${ran}:\n${command}\n\nRaise plugin_config.verification_timeout_s (config_set; capped at ${VERIFICATION_MAX_S}s) or speed up the command.${this.recordNote()}`);
    }
    planCarry() {
        const plan = planCarrySafe({ db: this.c.db, taskId: this.c.taskId, worktree: this.c.worktree, head: this.c.wtSha, commandsJson: this.c.gateCmdsJson }, { ...this.c.env, PATH: this.c.toolchainPath });
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
            return deny(this.timeoutReason(ordinal, recordedCmd, '', msToS(this.activeMs())));
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
            return deny(this.timeoutReason(ordinal, recordedCmd, elapsed, total));
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
            this.planCarry();
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
                return deny(commandSubstitution(`BLOCKED: verification failed.\nFailing command (${this.ordinal}/${c.cmdTotal}): ${cmd}\nExit ${r.rc} after ${r.elapsed}s; ${r.total}s cumulative.${this.recordNote()}${hitsBlock}\n\nOutput (last ${TAIL_LINES} lines):\n${r.tail}`));
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
            return deny(`BLOCKED: verification failed — review finding probe(s) failed; ${msToS(this.activeMs())}s cumulative.${this.recordNote()}${probeFail}\n\nFix each finding so its probe exits 0 (task_brief.open_findings lists the open ones).`);
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
export const sweVerificationGate = async (payload, env) => {
    const input = `${commandSubstitution(payload)}\n`;
    const field = (key) => commandSubstitution(rawOrEmpty(input, ['tool_input', key]));
    if (normalizeRole(field('agent')) !== 'swe')
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
    const waiver = field('waive_verification_gate_reason');
    if (waiver !== '' && shellLength(waiver, genv) >= 10)
        return waive(db, taskId, waiver, field, genv);
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
    if (block === '' && findings.length === 0)
        return { stdout: NO_VERIFICATION_CONTEXT, code: 0 };
    const slug = branchSlug(branchId);
    const wsRoot = posixDirname(posixDirname(posixDirname(db)));
    const repoRoot = taskRepo !== '' ? repoPathByName(db, taskRepo, genv) || `${wsRoot}/${taskRepo}` : repoSinglePath(db, genv) || wsRoot;
    const worktree = `${repoRoot}/.claude/worktrees/${slug}`;
    if (repoRoot === '' || !isDir(worktree)) {
        const missingAt = `${repoRoot || wsRoot || '?'}/.claude/worktrees/${slug}`;
        return {
            stdout: deny(`BLOCKED: verification gate could not locate the task worktree at ${missingAt} — refusing to fail open with non-empty verification[]. Ensure SWE ran in its registered worktree (ensure-swe-worktree creates it under <repoRoot>/.claude/worktrees/<slug>), verify the task's repo maps to the correct repos.path, or set waive_verification_gate_reason.`),
            code: 0,
        };
    }
    const toolchainPath = joinToolchainPath(toolchainDirs(genv), genv.PATH ?? '');
    const budget = parseBudget(genv.TMB_VERIFICATION_TIMEOUT_S || sqliteRo(db, "SELECT json_extract(value_json, '$') FROM plugin_config WHERE key = 'verification_timeout_s';", genv));
    if (budget.warning !== '')
        stderr(budget.warning);
    const head = gitRun(worktree, ['rev-parse', '--verify', '-q', 'HEAD'], genv);
    const wtSha = head.code === 0 ? commandSubstitution(head.stdout) : '';
    const expectedSha = field('commit_sha');
    const commands = block.split('\n').filter((line) => line !== '');
    const gateCmdsJson = jqCompact([...commands, ...findings.map(probeCommand)]);
    const scratch = makeScratch(db);
    let lock = '';
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
        const reused = reuse();
        if (reused !== null)
            return { stdout: reused, code: 0 };
        if (wtSha === '')
            return { stdout: await new VerificationRun(ctx).run(), code: 0 };
        const lockRoot = `${posixDirname(db)}/locks`;
        try {
            mkdirSync(lockRoot, { recursive: true });
        }
        catch {
            return { stdout: await new VerificationRun(ctx).run(), code: 0 };
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
            return { stdout: reusedAfterWait, code: 0 };
        return { stdout: await new VerificationRun(ctx).run(), code: 0 };
    }
    finally {
        if (lock !== '')
            removeQuietly(lock);
        removeQuietly(scratch);
    }
};
//# sourceMappingURL=swe-verification-gate.js.map