/**
 * The swe fences resolve the caller from the payload agent_id (its agent_runs
 * row, spawn_id = agent_id), never from the cwd or the target path (GH 1499,
 * GH 1692). Every payload runs through `node dist/hooks.js <gate>` for each
 * PreToolUse gate hooks.json registers for its tool (the router's
 * dist/hooks-router.txt gates), against a sandbox project with two task
 * worktrees (A, B) where swe row A is bound to agent_id agA, and a temp HOME.
 *
 *   (a) swe agA, cwd = main checkout, Write into worktree B → denied; the
 *       containment_denied row has root = worktree A and task_id = A.
 *   (b) the same payload writing inside worktree A → allowed by every gate.
 *   (c) Bash touch <worktree B>/x from agA, cwd = main checkout → denied; the
 *       recorded path is <worktree B>/x.
 *   (c2) Bash from agA, cwd = main checkout, judged by its write targets, not
 *       its cwd: ls, cd A && git status, cd A && touch src/x.ts → allowed by
 *       every gate; a bare touch x and cd B && touch x → denied.
 *   (h) GH 1508, agA with cwd = main checkout: git -C B commit / checkout /
 *       stash, tar / make / env -C B, npm --prefix B and a bare mutating git
 *       (commit, reset --hard, clean, checkout --, stash) → denied, the row
 *       naming worktree A and task A; git -C A commit, make -C A,
 *       npm --prefix A, git -C A status, git -C B log → allowed.
 *   (d) swe agZ with no spawn transcript and no bound row → denied, naming
 *       the missing task_id; its row's root is not the project root.
 *   (e) the main thread (no agent_type, no agent_id), cwd = worktree A,
 *       writing <project>/.claude/tmb/issue-drafts/x.md → allowed by every gate.
 *   (f) no containment_denied row has a NULL task_id and the project root.
 *   (g) code-reviewer, cwd = worktree A, writing in the project → allowed (its
 *       root is the project, not derived from the cwd).
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { hookRegistrations, PLUGIN_ROOT, routerCommand, routerGates, routerTable } from './hooks-router-table.js';
const HOOKS_JS = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const NOW = '2026-10-18T10:00:00.000Z';
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
/** Every PreToolUse gate hooks.json registers for <tool>, the gates the router runs for it included. */
function gates(tool) {
    const table = routerTable(PLUGIN_ROOT);
    return hookRegistrations(PLUGIN_ROOT)
        .filter((r) => r.event === 'PreToolUse' && new RegExp(`^(${r.matcher})$`).test(tool))
        .flatMap((r) => {
        const router = routerCommand(r.command, false);
        if (router !== null)
            return routerGates(table, router.event, { matcher: r.matcher, tool });
        const direct = /dist\/hooks\.js" ([a-z][a-z0-9-]*)$/.exec(r.command);
        return direct === null ? [] : [direct[1]];
    });
}
function hookOutput(stdout) {
    const text = stdout.trim();
    if (text === '')
        return {};
    try {
        return JSON.parse(text);
    }
    catch {
        try {
            return JSON.parse(text.split('\n').at(-1) ?? '');
        }
        catch {
            return {};
        }
    }
}
const text = (out) => out.map((r) => `${r.gate}\t${r.decision}\t${r.reason}`).join('\n');
const decisionOf = (out, gate) => out.find((r) => r.gate === gate)?.decision ?? '';
const deniedBy = (out) => out
    .filter((r) => r.decision === 'deny')
    .map((r) => r.gate)
    .join(',');
const write = (p) => ({ file_path: p, content: 'x\n' });
const bashCmd = (c) => ({ command: c });
describe('hook-caller-identity: the swe fences resolve the caller from agent_id (GH 1499)', () => {
    let sandbox;
    let project;
    let wtA;
    let wtB;
    let db;
    let hostTmp;
    let env;
    let seq = 0;
    const git = (...args) => execFileSync('git', args, { cwd: sandbox, env: { ...process.env, ...GIT_ENV, HOME: join(sandbox, 'home') }, stdio: 'pipe' });
    function query(sql) {
        const d = new DatabaseSync(db);
        try {
            const row = d.prepare(sql).get();
            return row === undefined ? undefined : Object.values(row)[0];
        }
        finally {
            d.close();
        }
    }
    const lastDenial = () => String(query("SELECT json_extract(content_json,'$.root') || '|' || COALESCE(json_extract(content_json,'$.task_id'), 'null') FROM audit WHERE event_type='containment_denied' ORDER BY id DESC LIMIT 1") ?? '');
    const lastDeniedPath = () => String(query("SELECT json_extract(content_json,'$.path') FROM audit WHERE event_type='containment_denied' ORDER BY id DESC LIMIT 1") ?? '');
    /** Every gate for <tool> through dist/hooks.js <gate>, one result per gate. */
    function run(cwd, agentType, agentId, tool, toolInput) {
        seq += 1;
        const payload = JSON.stringify({
            hook_event_name: 'PreToolUse',
            session_id: 'sess-main',
            tool_use_id: `toolu_${seq}`,
            cwd,
            tool_name: tool,
            tool_input: toolInput,
            ...(agentType === '' ? {} : { agent_type: agentType }),
            ...(agentId === '' ? {} : { agent_id: agentId }),
        });
        return gates(tool).map((gate) => {
            const r = spawnSync(process.execPath, [HOOKS_JS, gate], {
                cwd,
                input: payload,
                env: { ...env, CLAUDE_CONFIG_DIR: '', TMPDIR: hostTmp },
                encoding: 'utf8',
                timeout: 60_000,
            });
            if (r.error)
                throw r.error;
            const out = hookOutput(r.stdout);
            return {
                gate,
                decision: out.hookSpecificOutput?.permissionDecision || 'allow',
                reason: out.hookSpecificOutput?.permissionDecisionReason || '',
            };
        });
    }
    before(() => {
        sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-hook-caller-identity.')));
        project = join(sandbox, 'project');
        wtA = join(project, '.claude/worktrees/a-task');
        wtB = join(project, '.claude/worktrees/b-task');
        db = join(project, '.claude/tmb/trajectory.db');
        hostTmp = join(sandbox, 'host-tmp');
        for (const dir of [project, hostTmp, join(sandbox, 'home')])
            mkdirSync(dir, { recursive: true });
        git('init', '-q', '-b', 'dev', project);
        git('-C', project, 'config', 'user.email', 't@t.io');
        git('-C', project, 'config', 'user.name', 't');
        writeFileSync(join(project, '.gitignore'), '.claude/\n');
        writeFileSync(join(project, 'README.md'), 'init\n');
        git('-C', project, 'add', '.');
        git('-C', project, 'commit', '-qm', 'init');
        for (const slug of ['a-task', 'b-task'])
            git('-C', project, 'worktree', 'add', '-q', '-b', `fix/${slug}`, join(project, '.claude/worktrees', slug));
        for (const dir of [join(wtA, 'src'), join(wtB, 'src'), dirname(db)])
            mkdirSync(dir, { recursive: true });
        const d = new DatabaseSync(db);
        d.exec(readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8'));
        d.prepare('INSERT INTO repos (name, path) VALUES (?, ?)').run('project', project);
        d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (9, 'caller identity', 'open', ?, ?)").run(NOW, NOW);
        const task = d.prepare("INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, spec_body, files, created_at, updated_at) VALUES (?, 9, ?, 'dev', 'd', 'running', '## spec', '[\"src/\"]', ?, ?)");
        task.run(1, 'fix/a-task', NOW, NOW);
        task.run(2, 'fix/b-task', NOW, NOW);
        const runRow = d.prepare("INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, root_dir, host, spawn_id) VALUES (?, 9, 'swe', ?, ?, 'claude', ?)");
        runRow.run(1, NOW, wtA, 'agA');
        runRow.run(2, NOW, wtB, 'agB');
        const brief = d.prepare("INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (9, 'server', 'swe_brief_fetched', 'brief', ?, ?)");
        brief.run('{"task_id":1}', NOW);
        brief.run('{"task_id":2}', NOW);
        d.close();
        env = {
            PATH: process.env.PATH,
            HOME: join(sandbox, 'home'),
            TRAJECTORY_DB_PATH: db,
            CLAUDE_PROJECT_DIR: project,
            CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
            TMB_INSTALLED_JSON: join(sandbox, 'no-installed-plugins.json'),
            // The sandbox sits under the harness's /tmp/claude-<uid>, which the gates
            // allow as scratch; a preloaded fake uid keeps that allowance from covering it.
            NODE_OPTIONS: `--import ${join(PLUGIN_ROOT, 'tests/lib/fake-uid.mjs')}`,
            ...GIT_ENV,
        };
    });
    after(() => {
        rmSync(sandbox, { recursive: true, force: true });
    });
    it('the sandbox sits outside the plugin repo', () => {
        const top = (dir) => spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
        assert.notEqual(top(sandbox), top(PLUGIN_ROOT));
    });
    it('the fixture runs every PreToolUse Write gate', () => {
        const writeGates = gates('Write').join(',');
        for (const g of ['containment-guard', 'swe-boundary', 'swe-scope-fence'])
            assert.ok(writeGates.includes(g), `${g} in ${writeGates}`);
    });
    it('(a) swe agA, cwd = main checkout, Write into worktree B → denied', () => {
        const out = run(project, 'tmb:swe', 'agA', 'Write', write(join(wtB, 'src/x.ts')));
        assert.equal(decisionOf(out, 'containment-guard'), 'deny', 'containment-guard denies');
        assert.equal(decisionOf(out, 'swe-boundary'), 'deny', 'swe-boundary rule (c) denies');
        assert.ok(`${decisionOf(out, 'swe-boundary')}${text(out)}`.includes(`assigned worktree (${wtA})`), 'rule (c) names worktree A');
        assert.equal(lastDenial(), `${wtA}|1`, 'the containment_denied row: root = worktree A, task_id = A');
    });
    it('(b) the same caller writing inside worktree A → allowed by every gate', () => {
        assert.equal(deniedBy(run(project, 'tmb:swe', 'agA', 'Write', write(join(wtA, 'src/a.ts')))), '', 'no gate denies');
    });
    it('(b) a write in worktree A outside files[] is noted against task A', () => {
        assert.equal(deniedBy(run(project, 'tmb:swe', 'agA', 'Write', write(join(wtA, 'notes/n.md')))), '', 'no gate denies');
        const note = spawnSync(process.execPath, [HOOKS_JS, 'swe-scope-fence'], {
            cwd: project,
            input: JSON.stringify({
                hook_event_name: 'PreToolUse',
                session_id: 'sess-main',
                tool_use_id: 'toolu_note',
                cwd: project,
                tool_name: 'Write',
                agent_type: 'swe',
                agent_id: 'agA',
                tool_input: { file_path: join(wtA, 'notes/m.md'), content: 'x' },
            }),
            env,
            encoding: 'utf8',
            timeout: 60_000,
        });
        assert.ok(note.stdout.includes("notes/m.md is outside this task's files[]"), "swe-scope-fence judges task A's files[] with cwd = main checkout");
    });
    it('(c) Bash touch <worktree B>/x from agA, cwd = main checkout → denied', () => {
        const out = run(project, 'tmb:swe', 'agA', 'Bash', bashCmd(`touch ${wtB}/x`));
        assert.equal(decisionOf(out, 'containment-guard'), 'deny', 'containment-guard denies');
        assert.equal(lastDenial(), `${wtA}|1`, 'root = worktree A, task_id = A');
        assert.equal(lastDeniedPath(), `${wtB}/x`, "the recorded path is worktree B's x, not the cwd");
    });
    it("(c2) a bound swe's Bash is judged by its write targets, not its cwd (cwd = main checkout)", () => {
        assert.equal(deniedBy(run(project, 'tmb:swe', 'agA', 'Bash', bashCmd('ls'))), '', 'ls: no gate denies');
        assert.equal(deniedBy(run(project, 'tmb:swe', 'agA', 'Bash', bashCmd(`cd ${wtA} && git status`))), '', 'cd A && git status: no gate denies');
        assert.equal(deniedBy(run(project, 'tmb:swe', 'agA', 'Bash', bashCmd(`cd ${wtA} && touch src/x.ts`))), '', 'cd A && touch src/x.ts: no gate denies');
        assert.equal(decisionOf(run(project, 'tmb:swe', 'agA', 'Bash', bashCmd('touch x')), 'containment-guard'), 'deny', 'bare touch x from the main checkout');
        assert.equal(lastDeniedPath(), `${project}/x`, "the recorded path is the main checkout's x");
        assert.equal(decisionOf(run(project, 'tmb:swe', 'agA', 'Bash', bashCmd(`cd ${wtB} && touch x`)), 'containment-guard'), 'deny', 'cd B && touch x');
        assert.equal(lastDeniedPath(), `${wtB}/x`, "the recorded path is worktree B's x");
    });
    it("(h) GH 1508: a -C / --prefix dir and a mutating git's tree are write targets (cwd = main checkout)", () => {
        for (const c of [
            `git -C ${wtB} commit -am x`,
            `git -C ${wtB} checkout fix/b-task`,
            `git -C ${wtB} stash`,
            `tar -xf a.tar -C ${wtB}`,
            `make -C ${wtB}`,
            `env -C ${wtB} make`,
            `npm --prefix ${wtB} install`,
        ]) {
            assert.equal(decisionOf(run(project, 'tmb:swe', 'agA', 'Bash', bashCmd(c)), 'containment-guard'), 'deny', `${c} → into worktree B`);
            assert.equal(lastDenial(), `${wtA}|1`, `${c}: root = worktree A, task_id = A`);
        }
        for (const c of ['git commit -am x', 'git reset --hard', 'git clean -fd', 'git checkout -- README.md', 'git stash']) {
            assert.equal(decisionOf(run(project, 'tmb:swe', 'agA', 'Bash', bashCmd(c)), 'containment-guard'), 'deny', `${c} → into the main checkout`);
            assert.equal(lastDenial(), `${wtA}|1`, `${c}: root = worktree A, task_id = A`);
            assert.equal(lastDeniedPath(), project, `${c}: the recorded path is the main checkout`);
        }
        for (const c of [`git -C ${wtA} commit -am x`, `make -C ${wtA}`, `npm --prefix ${wtA} install`, `git -C ${wtA} status`, `git -C ${wtB} log`]) {
            assert.equal(decisionOf(run(project, 'tmb:swe', 'agA', 'Bash', bashCmd(c)), 'containment-guard'), 'allow', `${c} → allowed`);
        }
        assert.equal(decisionOf(run(wtA, 'tmb:swe', 'agA', 'Bash', bashCmd('git commit -am x')), 'containment-guard'), 'allow', 'a swe committing inside its own worktree');
        assert.equal(decisionOf(run(project, '', '', 'Bash', bashCmd('git commit -am x')), 'containment-guard'), 'allow', 'bro committing in the main checkout');
        assert.equal(decisionOf(run(project, 'tmb:code-reviewer', 'agR', 'Bash', bashCmd(`git -C ${project} stash`)), 'containment-guard'), 'allow', 'code-reviewer: its root is the project');
    });
    it('(d) swe agZ with no transcript and no bound row → denied, naming the missing piece', () => {
        const out = run(project, 'swe', 'agZ', 'Write', write(join(wtA, 'src/z.ts')));
        assert.equal(decisionOf(out, 'containment-guard'), 'deny', 'a write inside a worktree');
        assert.ok(text(out).includes('no task_id'), 'the reason names the missing task_id');
        assert.ok(text(out).includes('task_id=<N> in its spawn prompt'), 'the reason names where the task_id comes from');
        const row = String(query("SELECT COALESCE(json_extract(content_json,'$.root'), 'null') || '|' || json_extract(content_json,'$.reason') FROM audit WHERE event_type='containment_denied' ORDER BY id DESC LIMIT 1") ?? '');
        assert.ok(row.includes('null|unbound_caller'), 'root null, reason names the unbound caller');
        assert.ok(row.includes('agZ'), 'the reason names its agent_id');
        assert.equal(decisionOf(run(project, 'swe', 'agZ', 'Write', write(join(project, 'README.md'))), 'containment-guard'), 'deny', 'a write in the project root');
        assert.equal(decisionOf(run(project, 'swe', 'agZ', 'Bash', bashCmd(`echo x > ${project}/y`)), 'containment-guard'), 'deny', 'a Bash write');
        assert.equal(decisionOf(run(project, 'swe', 'agZ', 'Bash', bashCmd(`ls ${wtA} 2>/dev/null`)), 'containment-guard'), 'allow', 'a Bash read before task_brief');
    });
    it("(e) main thread, cwd = worktree A, writing the project's issue drafts → allowed by every gate", () => {
        mkdirSync(join(project, '.claude/tmb/issue-drafts'), { recursive: true });
        const out = run(wtA, '', '', 'Write', write(join(project, '.claude/tmb/issue-drafts/x.md')));
        assert.equal(deniedBy(out), '', 'no gate denies');
        assert.ok(!text(out).includes('SWE may only edit files inside its assigned worktree'), 'never fenced as a swe');
    });
    it('(g) code-reviewer, cwd = worktree A: its root is the project', () => {
        const out = run(wtA, 'tmb:code-reviewer', 'agR', 'Write', write(join(project, '.claude/tmb/issue-drafts/r.md')));
        assert.equal(decisionOf(out, 'containment-guard'), 'allow', 'a project write outside worktree A');
    });
    it('(f) no containment_denied row widens to the project root with a NULL task_id', () => {
        const d = new DatabaseSync(db);
        try {
            const row = d
                .prepare("SELECT COUNT(*) AS n FROM audit WHERE event_type='containment_denied' AND json_extract(content_json,'$.task_id') IS NULL AND json_extract(content_json,'$.root') = ?")
                .get(project);
            assert.equal(row.n, 0, 'zero rows');
        }
        finally {
            d.close();
        }
    });
});
//# sourceMappingURL=hook-caller-identity.test.js.map