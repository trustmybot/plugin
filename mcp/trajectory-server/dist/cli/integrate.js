/**
 * `cli.js integrate` (GH 1518, GH 1692): bro's post-review rebase of a task's
 * branch onto a moved base.
 *
 *   node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" integrate <task_id> <base>
 *
 * Run by bro from the main checkout, after bro's own verify and the code-reviewer
 * pass. The task's repo, branch_id, commit_sha and verification[] come from
 * the trajectory DB (TRAJECTORY_DB_PATH, else CLAUDE_PROJECT_DIR, else a walk
 * up from cwd).
 *   1. No passing review for the task's commit_sha (a pass verdict at or after
 *      the first bro_verification_pass naming the task and that commit) → exit 3.
 *   2. <base> already an ancestor of commit_sha → print commit_sha, exit 0;
 *      nothing is recorded.
 *   3. A temporary worktree <repo>/.claude/worktrees/integrate-<task_id>.XXXXXX,
 *      detached at commit_sha, runs `git rebase <base>`. A conflict is aborted
 *      → exit 2, branch and DB unchanged. Each untracked node_modules of the
 *      main checkout beside a tracked package.json is symlinked into the
 *      worktree (GH 1541).
 *   4. When scripts/maintenance/regen-generated.ts (or, on an older base, its
 *      shell predecessor) exists and either side of the rebase touched a path
 *      the worktree's .gitattributes marks merge=tmb-regen, the script runs in
 *      the worktree (GH 1652); a failure → exit 2, branch and DB unchanged.
 *      Tracked files it changes are amended into the rebased tip, keeping its
 *      author and message.
 *   5. The `git patch-id --stable` lists of the commits a rebase picks from
 *      commit_sha and from <rebased> (`rev-list --cherry-pick --right-only
 *      <base>...<sha>`: a commit whose patch is already in <base>, such as a
 *      squash-merged parent branch's, is skipped), both over source paths only
 *      (every merge=tmb-regen path excluded), must match, else exit 2. No
 *      rebased commit left means the task's patch is already in <base> → exit 2.
 *      verification[] runs in the temporary worktree and is recorded as a
 *      verification_runs row (source manual, commit_sha = the rebased SHA).
 *      A failure → exit 1, branch unmoved. A pass moves refs/heads/<branch_id>
 *      to the rebased SHA and prints it.
 *   6. The temporary worktree is removed on every exit. A run still open when
 *      the command exits (INT → 130, TERM → 143, or the failure it exits with)
 *      is finished with that exit code and its running command is killed; a
 *      finished run is not rewritten. A SIGKILL leaves the run open until a
 *      later run start sweeps it (exit 137) once it is past its budget + 60 s.
 * The branch is moved only when no worktree has it checked out and it still
 * points at commit_sha, or at a rebase of it with a passing recorded run.
 * The git-push-guard gate denies a push of a rebased task commit without such a run.
 *
 * The regen run is bounded by the whole budget on its own; each verification
 * command is bounded by what is left of the budget,
 * plugin_config.verification_timeout_s (default 900 s; TMB_VERIFICATION_TIMEOUT_S
 * overrides it), capped at 1800 s.
 * stdout carries only the SHA; progress and failures go to stderr.
 * Exit 0 = integrated, 1 = verification failed, 2 = conflict or patch drift,
 * 3 = no passing review, 4 = usage error or a precondition not met.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { dbWrite, nowIso } from '../hooks/lib/audit.js';
import { dbPath, GATE_READ_ERROR, gateRead, sqliteRo, sqlInt, sqlQuote } from '../hooks/lib/db.js';
import { isDir } from '../hooks/lib/git.js';
import { keysInOrder } from '../hooks/lib/jq-key-order.js';
import { jsonStream } from '../hooks/lib/jq.js';
import { commandSubstitution, posixDirname } from '../hooks/lib/project-env.js';
import { repoGitRoot, repoPathByName, repoSinglePath } from '../hooks/lib/repo.js';
import { joinToolchainPath, parseBudget, shellLength, shellTail, toolchainDirs } from '../hooks/swe-verification-gate.js';
import { HAS_PASS_SQL } from '../review-sql.js';
import { linkWorktreeNodeModules } from '../utils/worktree-deps.js';
const FINISH_ATTEMPTS = 3;
const TAIL_LINES = 20;
const DEFAULT_TAIL_CHARS = 4000;
const TIMED_OUT_CODE = 124;
const REGEN_ATTR = 'attr:merge=tmb-regen';
const REGEN_SCRIPTS = [
    { name: 'regen-generated.ts', run: ['node', '--experimental-strip-types', '--no-warnings'] },
    { name: 'regen-generated.sh', run: ['bash'] },
];
const RECORD_ENV = { TMB_DB_WRITE_TIMEOUT_MS: '5000', TMB_DB_WRITE_RUN_BUDGET_MS: '10000' };
const MAX_BUFFER = 256 * 1024 * 1024;
const signals = osConstants.signals;
class Exit extends Error {
    code;
    constructor(code) {
        super(`exit ${code}`);
        this.code = code;
    }
}
function nowS() {
    return Math.floor(Date.now() / 1000);
}
function sleepS(seconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}
/** `jq -r '.[]? | select(type == "string" and length > 0)'`; null when the input does not parse. */
function verificationCommands(json) {
    const { values, complete } = jsonStream(json);
    if (!complete)
        return null;
    const out = [];
    for (const value of values) {
        if (value === null || typeof value !== 'object')
            continue;
        const items = Array.isArray(value) ? value : keysInOrder(value).map((k) => value[k]);
        for (const item of items)
            if (typeof item === 'string' && item !== '')
                out.push(item);
    }
    return commandSubstitution(out.join('\n'));
}
function lastLines(text, n) {
    return text === '' ? '' : text.split('\n').slice(-n).join('\n');
}
class Integration {
    env;
    io;
    db = '';
    taskId = '';
    base = '';
    branch = '';
    commitSha = '';
    baseSha = '';
    repoRoot = '';
    tip = '';
    wt = '';
    runId = '';
    runOpen = false;
    child = null;
    scratch = '';
    constructor(env, io) {
        this.env = env;
        this.io = io;
    }
    say(text) {
        this.io.err(`integrate: ${text}\n`);
    }
    die(code, text) {
        this.say(text);
        throw new Exit(code);
    }
    git(dir, args, opts = {}) {
        const r = spawnSync('git', ['-C', dir, ...args], {
            encoding: 'utf8',
            env: opts.env ?? this.env,
            input: opts.input,
            stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
            maxBuffer: MAX_BUFFER,
        });
        return { ok: r.status === 0, out: commandSubstitution(r.stdout ?? ''), err: r.stderr ?? '' };
    }
    /** A git command whose output goes to stderr, as the .sh's `>&2`. */
    gitLoud(dir, args, env) {
        const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: env ?? this.env, stdio: ['ignore', 'pipe', 'pipe'] });
        this.io.err(`${r.stdout ?? ''}${r.stderr ?? ''}`);
        return r.status === 0;
    }
    g(args) {
        return this.git(this.repoRoot, args);
    }
    revParse(dir, rev) {
        const r = this.git(dir, ['rev-parse', '--verify', '-q', rev]);
        return r.ok ? r.out : '';
    }
    record(sql) {
        const r = dbWrite(this.db, sql, { caller: 'integrate', env: { ...this.env, ...RECORD_ENV } });
        if (!r.ok && r.error !== '')
            this.io.err(`${r.error}\n`);
        return { ok: r.ok, stdout: r.stdout };
    }
    finish(rc, timedOut) {
        for (let attempt = 1; attempt <= FINISH_ATTEMPTS; attempt += 1) {
            if (this.record(`UPDATE verification_runs SET finished_at = '${nowIso()}', exit_code = ${rc}, timed_out = ${timedOut} WHERE id = ${this.runId};`).ok) {
                this.runOpen = false;
                return true;
            }
            sleepS(attempt);
        }
        return false;
    }
    recordCommand(ordinal, command, rc, elapsed, output) {
        const rawCap = this.env.TMB_VERIFICATION_TAIL_CHARS || String(DEFAULT_TAIL_CHARS);
        const cap = /^[0-9]+$/.test(rawCap) ? Number(rawCap) : DEFAULT_TAIL_CHARS;
        const tail = shellLength(output, this.env) > cap ? shellTail(output, cap, this.env) : output;
        return this.record(`INSERT INTO verification_run_commands (run_id, ordinal, command, exit_code, elapsed_s, output_tail) VALUES (${this.runId}, ${ordinal}, '${sqlQuote(command)}', ${rc}, ${elapsed}, '${sqlQuote(tail)}');`).ok;
    }
    /** Finishes a run left open, kills its command and removes the temporary worktree; safe to call twice. */
    cleanup(code) {
        if (this.child?.pid !== undefined && this.child.exitCode === null && this.child.signalCode === null) {
            try {
                process.kill(-this.child.pid, 'SIGKILL');
            }
            catch {
                /* already gone */
            }
        }
        if (this.runOpen) {
            const rc = code === 0 ? 1 : code;
            if (!this.finish(rc, 0))
                this.say(`run #${this.runId} finish write failed on exit ${rc}`);
        }
        if (this.scratch !== '')
            rmSync(this.scratch, { recursive: true, force: true });
        this.scratch = '';
        if (this.wt === '')
            return;
        if (!this.g(['worktree', 'remove', '--force', this.wt]).ok) {
            rmSync(this.wt, { recursive: true, force: true });
            this.g(['worktree', 'prune']);
        }
        this.wt = '';
    }
    /** Runs <cmd> in the worktree, output captured, killed with its process group after <seconds>. */
    execute(cmd, seconds, env) {
        if (this.scratch === '')
            this.scratch = mkdtempSync(join(this.env.TMPDIR || tmpdir(), 'tmb-integrate-'));
        const outPath = join(this.scratch, 'out');
        return new Promise((done) => {
            const fd = openSync(outPath, 'w');
            let fired = false;
            let settled = false;
            const settle = (rc) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                this.child = null;
                let out = '';
                try {
                    out = commandSubstitution(readFileSync(outPath, 'utf8'));
                }
                catch {
                    /* no output */
                }
                rmSync(outPath, { force: true });
                done({ rc, fired, out });
            };
            const child = spawn(cmd[0], cmd.slice(1), { cwd: this.wt, env: { ...env, PWD: this.wt }, stdio: ['ignore', fd, fd], detached: true });
            this.child = child;
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
            child.on('error', () => settle(127));
            child.on('exit', (code, signal) => {
                if (fired)
                    settle(TIMED_OUT_CODE);
                else
                    settle(code ?? 128 + (signal !== null ? (signals[signal] ?? 0) : 0));
            });
        });
    }
    branchHolder() {
        let wt = '';
        for (const line of this.g(['worktree', 'list', '--porcelain']).out.split('\n')) {
            if (line.startsWith('worktree '))
                wt = line.slice('worktree '.length);
            if (line === `branch refs/heads/${this.branch}`)
                return wt;
        }
        return '';
    }
    /** True when no worktree holds the branch and its tip is commit_sha, a verified rebase of it, or absent; sets tip. */
    branchMovable() {
        const holder = this.branchHolder();
        if (holder !== '') {
            this.say(`${this.branch} is checked out at ${holder}; remove that worktree (or switch it off the branch) and run cli.js integrate again`);
            return false;
        }
        this.tip = this.revParse(this.repoRoot, `refs/heads/${this.branch}^{commit}`);
        if (this.tip === '' || this.tip === this.commitSha)
            return true;
        const runs = gateRead(this.db, `SELECT COUNT(*) FROM verification_runs
    WHERE task_id = ${this.taskId} AND commit_sha = '${sqlQuote(this.tip)}' AND exit_code = 0 AND timed_out = 0;`, this.env);
        if (runs === '' || runs === GATE_READ_ERROR || runs === '0') {
            this.say(`${this.branch} is at ${this.tip}, which is neither task ${this.taskId}'s reviewed commit nor a verified integration of it; refusing to move it`);
            return false;
        }
        return true;
    }
    rebasePicks(sha) {
        return this.git(this.wt, ['rev-list', '--reverse', '--no-merges', '--cherry-pick', '--right-only', `${this.baseSha}...${sha}`]).out;
    }
    patchIds(sha) {
        const picks = this.rebasePicks(sha);
        const diff = spawnSync('git', ['-C', this.wt, 'diff-tree', '--stdin', '-p', '-r', '--root', '--', '.', `:(exclude,${REGEN_ATTR})`], {
            encoding: 'utf8',
            env: this.env,
            input: picks === '' ? '' : `${picks}\n`,
            maxBuffer: MAX_BUFFER,
        });
        const ids = this.git(this.wt, ['patch-id', '--stable'], { input: diff.stdout ?? '' });
        return commandSubstitution(ids.out
            .split('\n')
            .map((line) => line.split(' ')[0])
            .join('\n'));
    }
    regenTouched() {
        return [`${this.baseSha}...${this.commitSha}`, `${this.commitSha}...${this.baseSha}`].some((side) => this.git(this.wt, ['diff', '--name-only', side, '--', `:(${REGEN_ATTR})`]).out !== '');
    }
    async run(argv) {
        if (argv.length !== 2)
            this.die(4, 'usage: cli.js integrate <task_id> <base>');
        this.taskId = sqlInt(argv[0]);
        this.base = argv[1];
        if (this.taskId === '')
            this.die(4, `task_id must be a number, got '${argv[0]}'`);
        if (this.base === '')
            this.die(4, 'base is empty');
        const db = dbPath(this.env);
        if (db === null)
            this.die(4, 'no trajectory DB resolved (set TRAJECTORY_DB_PATH or CLAUDE_PROJECT_DIR)');
        this.db = db;
        const row = gateRead(db, `SELECT 'task' || char(10) || COALESCE(repo, '') || char(10) || COALESCE(branch_id, '') || char(10) || COALESCE(commit_sha, '') || char(10) || ${HAS_PASS_SQL}
  FROM tasks t WHERE t.id = ${this.taskId};`, this.env);
        if (row === GATE_READ_ERROR)
            this.die(4, `trajectory DB read failed: ${db}`);
        if (row === '')
            this.die(4, `no task ${this.taskId}`);
        const [, taskRepo = '', branch = '', commitSha = '', hasPass = ''] = row.split('\n');
        this.branch = branch;
        if (branch === '')
            this.die(4, `task ${this.taskId} has no branch_id`);
        if (commitSha === '')
            this.die(3, `task ${this.taskId} has no commit_sha, so no reviewed commit`);
        if (hasPass !== '1')
            this.die(3, `task ${this.taskId} has no passing code-reviewer verdict for commit ${commitSha}`);
        const wsRoot = posixDirname(posixDirname(posixDirname(db)));
        const repoDir = taskRepo !== '' ? repoPathByName(db, taskRepo, this.env) || `${wsRoot}/${taskRepo}` : repoSinglePath(db, this.env) || wsRoot;
        this.repoRoot = await repoGitRoot(repoDir, this.env);
        if (this.repoRoot === '' || !isDir(repoDir))
            this.die(4, `task ${this.taskId}'s repo is not a git checkout: ${repoDir || '<unresolved>'}`);
        this.commitSha = this.revParse(this.repoRoot, `${commitSha}^{commit}`);
        if (this.commitSha === '')
            this.die(4, `commit_sha of task ${this.taskId} is not a commit in ${this.repoRoot}`);
        this.baseSha = this.revParse(this.repoRoot, `${this.base}^{commit}`);
        if (this.baseSha === '')
            this.die(4, `base '${this.base}' is not a commit in ${this.repoRoot}`);
        if (this.g(['merge-base', '--is-ancestor', this.baseSha, this.commitSha]).ok) {
            this.say(`${this.base} is already an ancestor of task ${this.taskId}'s commit; nothing to rebase`);
            this.io.out(`${this.commitSha}\n`);
            return 0;
        }
        const verification = gateRead(db, `SELECT COALESCE(verification, '[]') FROM tasks WHERE id = ${this.taskId};`, this.env);
        if (verification === GATE_READ_ERROR)
            this.die(4, `trajectory DB read failed: ${db}`);
        const commands = verificationCommands(verification);
        if (commands === null)
            this.die(4, `task ${this.taskId}'s verification[] is not a JSON array`);
        if (commands === '')
            this.die(4, `task ${this.taskId} has no verification[]; there is nothing to re-verify the rebased commit with`);
        if (!this.branchMovable())
            throw new Exit(4);
        try {
            mkdirSync(`${this.repoRoot}/.claude/worktrees`, { recursive: true });
        }
        catch {
            this.die(4, `cannot create ${this.repoRoot}/.claude/worktrees`);
        }
        try {
            this.wt = mkdtempSync(`${this.repoRoot}/.claude/worktrees/integrate-${this.taskId}.`);
        }
        catch {
            this.die(4, 'cannot create a temporary worktree dir');
        }
        if (!this.gitLoud(this.repoRoot, ['worktree', 'add', '-q', '--detach', this.wt, this.commitSha])) {
            try {
                rmdirSync(this.wt);
            }
            catch {
                /* not empty or gone */
            }
            this.wt = '';
            this.die(4, 'git worktree add failed');
        }
        this.say(`rebasing task ${this.taskId} (${this.commitSha}) onto ${this.base} (${this.baseSha}) in ${this.wt}`);
        if (!this.gitLoud(this.wt, ['rebase', '-q', this.baseSha], { ...this.env, GIT_EDITOR: 'true' })) {
            this.git(this.wt, ['rebase', '--abort']);
            this.die(2, `rebase of task ${this.taskId} onto ${this.base} conflicted; aborted, ${branch} and the DB are unchanged`);
        }
        let newSha = this.revParse(this.wt, 'HEAD');
        if (newSha === '')
            this.die(4, 'cannot read the rebased HEAD');
        try {
            for (const s of linkWorktreeNodeModules(this.repoRoot, this.wt).skipped)
                this.io.err(`worktree-deps: ${s.dir}: ${s.reason}\n`);
        }
        catch {
            this.say('node_modules linking failed');
        }
        const budgetRaw = this.env.TMB_VERIFICATION_TIMEOUT_S ||
            sqliteRo(db, "SELECT json_extract(value_json, '$') FROM plugin_config WHERE key = 'verification_timeout_s';", this.env);
        const timeoutS = parseBudget(budgetRaw).timeoutS;
        const toolchainPath = joinToolchainPath(toolchainDirs(this.env, this.wt), this.env.PATH ?? '');
        const regen = REGEN_SCRIPTS.find((s) => existsSync(`${this.wt}/scripts/maintenance/${s.name}`));
        if (newSha !== this.baseSha && regen !== undefined && this.regenTouched()) {
            const script = `scripts/maintenance/${regen.name}`;
            this.say(`regenerating generated files with ${script}`);
            const r = await this.execute([...regen.run, script], timeoutS, { ...this.env, PATH: toolchainPath });
            if (r.out !== '')
                this.io.err(`${r.out}\n`);
            if (r.rc !== 0)
                this.die(2, `${script} exited ${r.rc} in the rebased worktree; ${branch} and the DB are unchanged`);
            if (this.git(this.wt, ['status', '--porcelain', '--untracked-files=no']).out !== '') {
                if (!this.gitLoud(this.wt, ['add', '-u']) || !this.gitLoud(this.wt, ['commit', '-q', '--amend', '--no-edit'])) {
                    this.die(4, `could not amend the regenerated files into the rebased commit; ${branch} and the DB are unchanged`);
                }
                newSha = this.revParse(this.wt, 'HEAD');
                if (newSha === '')
                    this.die(4, 'cannot read the amended HEAD');
            }
        }
        if (this.rebasePicks(newSha) === '') {
            this.die(2, `task ${this.taskId}'s patch is already in ${this.base}; nothing to integrate, ${branch} and the DB are unchanged`);
        }
        if (this.patchIds(this.commitSha) !== this.patchIds(newSha)) {
            this.die(2, `the rebase changed task ${this.taskId}'s source patches (patch-id of ${this.base}..reviewed differs from ${this.base}..rebased); ${branch} and the DB are unchanged`);
        }
        const now = nowIso();
        const started = this.record(`UPDATE verification_runs SET finished_at = '${now}', exit_code = 137, timed_out = 0
 WHERE finished_at IS NULL
   AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at) < strftime('%Y-%m-%dT%H:%M:%fZ', '${now}', '-' || (budget_s + 60) || ' seconds');
INSERT INTO verification_runs (task_id, commit_sha, source, started_at, budget_s) VALUES (${this.taskId}, '${sqlQuote(newSha)}', 'manual', '${now}', ${timeoutS});
SELECT last_insert_rowid();`);
        this.runId = started.ok ? commandSubstitution(started.stdout) : '';
        if (this.runId === '')
            this.die(4, `could not record a verification run for ${newSha}; ${branch} unmoved`);
        this.runOpen = true;
        const commandEnv = { ...this.env, ...RECORD_ENV, PATH: toolchainPath };
        const lines = commands.split('\n');
        const total = lines.filter((line) => line !== '').length;
        const startS = nowS();
        for (const [i, cmd] of lines.entries()) {
            const ordinal = i + 1;
            const remaining = timeoutS - (nowS() - startS);
            if (remaining <= 0) {
                this.recordCommand(ordinal, cmd, TIMED_OUT_CODE, 0, 'budget spent before the command started');
                if (!this.finish(TIMED_OUT_CODE, 1))
                    this.say(`run #${this.runId} finish write failed`);
                this.die(1, `verification budget (${timeoutS}s) spent before command ${ordinal}/${total}: ${cmd}; recorded as run #${this.runId}; ${branch} unmoved`);
            }
            const cmdStart = nowS();
            const { rc, fired, out } = await this.execute(['bash', '-c', cmd], remaining, commandEnv);
            const elapsed = nowS() - cmdStart;
            const tail = lastLines(out, TAIL_LINES);
            const timedOut = rc === TIMED_OUT_CODE && fired ? 1 : 0;
            if (!this.recordCommand(ordinal, cmd, rc, elapsed, tail))
                this.say(`run #${this.runId}: command ${ordinal} row not recorded`);
            if (rc !== 0) {
                if (!this.finish(rc, timedOut))
                    this.say(`run #${this.runId} finish write failed`);
                this.say(`verification failed on ${newSha}: command ${ordinal}/${total} exited ${rc} after ${elapsed}s: ${cmd}`);
                this.io.err(`${tail}\n`);
                this.die(1, `recorded as run #${this.runId}; ${branch} unmoved`);
            }
        }
        if (!this.finish(0, 0)) {
            this.die(4, `run #${this.runId} passed but its finish write failed, so the push guard will not count it; ${branch} unmoved`);
        }
        const oldTip = this.tip;
        if (!this.branchMovable()) {
            this.die(4, `verification passed (run #${this.runId}) but ${branch} cannot be moved; the rebased commit is ${newSha}`);
        }
        if (this.tip !== oldTip)
            this.die(4, `${branch} moved during integration (${oldTip} -> ${this.tip}); left as is`);
        if (!this.g(['update-ref', '-m', `cli.js integrate: task ${this.taskId} onto ${this.base}`, `refs/heads/${branch}`, newSha, this.tip]).ok) {
            this.die(4, `git update-ref of ${branch} failed; the rebased commit is ${newSha} (run #${this.runId})`);
        }
        this.say(`${branch} -> ${newSha} (verification run #${this.runId} passed)`);
        this.io.out(`${newSha}\n`);
        return 0;
    }
}
export async function integrate(argv, env, io) {
    const integration = new Integration(env, io);
    const onExit = (code) => integration.cleanup(code);
    process.on('exit', onExit);
    let code = 1;
    try {
        code = await integration.run(argv);
    }
    catch (e) {
        if (!(e instanceof Exit))
            throw e;
        code = e.code;
    }
    finally {
        process.off('exit', onExit);
        integration.cleanup(code);
    }
    return code;
}
//# sourceMappingURL=integrate.js.map