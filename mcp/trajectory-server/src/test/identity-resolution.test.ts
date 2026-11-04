/**
 * Identity resolution end to end (GH 1550, GH 1692): swe-boundary and
 * containment-guard resolve a swe's location from its identity and the
 * trajectory DB — task_id=<N> in the spawn transcript → tasks.repo →
 * repos.path → <repos.path>/.claude/worktrees/<branch slug> — never from the
 * payload cwd or the hook's $PWD, which Claude Code shares across bro and
 * every subagent.
 *
 * Five layouts, each run with cwd/$PWD at the swe's worktree, a sibling
 * worktree and the project root:
 *   (a) the main checkout is the project and the repo;
 *   (b) repos.path lies outside the project dir;
 *   (c) the project is itself a git worktree under <host>/.claude/worktrees/<n>;
 *   (d) a workspace project with nested repos ws/svc-a and ws/svc-b, both
 *       holding a worktree of the same slug;
 *   (e) .claude/worktrees appears twice above the project, and repos.path is
 *       relative to the project root.
 * Plus: an unresolved swe is denied naming the missing piece, bro is
 * unchanged, the subagents/ transcript fallback, the scan walker from a session
 * dir under .claude/worktrees/<n>, and heredoc text vs a redirect target. Each
 * hook runs as `node dist/hooks.js <hook>` in a sandbox with its own HOME and a
 * preloaded fake uid, so the harness's /tmp/claude-<uid> scratch allowance
 * never covers the sandbox.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { FAKE_UID_PRELOAD } from './db-test-fixtures.js';
import { jsonValues, makeSandbox, PLUGIN_ROOT, runGate, type Sandbox } from './hook-sandbox.js';

const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const DIST = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist');
const NOW = '2026-10-19T10:00:00.000Z';
const BOUNDARY = 'swe-boundary';
const CONTAIN = 'containment-guard';
const GIT_ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

type ToolInput = Record<string, unknown>;

interface Layout {
  project: string;
  db: string;
  task: number;
  wt: string;
  other: string;
}

const edit = (p: string): ToolInput => ({ file_path: p, old_string: 'a', new_string: 'b' });
const bashCmd = (c: string): ToolInput => ({ command: c });

function payload(agentType: string, transcript: string, cwd: string, tool: string, toolInput: ToolInput): string {
  const p: Record<string, unknown> = { hook_event_name: 'PreToolUse', session_id: 's-1550', cwd, tool_name: tool, tool_input: toolInput };
  if (agentType !== '') p.agent_type = agentType;
  if (transcript !== '') p.agent_transcript_path = transcript;
  return JSON.stringify(p);
}

function hookOutput(stdout: string): { permissionDecision?: string; permissionDecisionReason?: string } {
  const v = jsonValues(stdout)[0] as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | undefined;
  return v?.hookSpecificOutput ?? {};
}
const decision = (out: string) => (out === '' ? 'allow' : (hookOutput(out).permissionDecision ?? 'allow'));
const reason = (out: string) => hookOutput(out).permissionDecisionReason ?? '';

describe('identity resolution: hooks find a swe from its identity and the DB', () => {
  let sb: Sandbox;
  let cache: string;
  let hostTmp: string;
  const layouts: Record<string, Layout> = {};
  let aDb: string;
  let aProj: string;
  let bProj: string;
  let dDb: string;
  let dProj: string;
  let cDb: string;
  let cProj: string;
  let wtA: string;

  function git(dir: string, ...args: string[]): void {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...sb.env, ...GIT_ID } });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  }

  function gitInit(dir: string): void {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  }

  function exec(path: string, sql: string, ...params: string[]): void {
    const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
    try {
      if (params.length === 0) db.exec(sql);
      else db.prepare(sql).run(...params);
    } finally {
      db.close();
    }
  }

  function newDb(project: string): string {
    const db = join(project, '.claude/tmb/trajectory.db');
    mkdirSync(dirname(db), { recursive: true });
    exec(db, SCHEMA);
    exec(db, "INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'identity', 'open', ?, ?)", NOW, NOW);
    return db;
  }

  const addRepo = (db: string, name: string, path: string) => exec(db, 'INSERT INTO repos (name, path) VALUES (?, ?)', name, path);

  function addTask(db: string, id: number, branch: string, repo: string): void {
    exec(
      db,
      "INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at, repo) VALUES (?, 1, ?, 'd', 'running', ?, ?, NULLIF(?, ''))",
      String(id),
      branch,
      NOW,
      NOW,
      repo,
    );
  }

  function transcript(task: number): string {
    const f = join(sb.dir, `spawn-${task}.jsonl`);
    writeFileSync(f, `${JSON.stringify({ message: { content: [{ type: 'text', text: `task_id=${task} worktree: /somewhere/else` }] } })}\n`);
    return f;
  }

  function hook(gate: string, project: string, db: string, pwd: string, input: string): string {
    const env = {
      ...sb.env,
      PWD: pwd,
      CLAUDE_PROJECT_DIR: project,
      TRAJECTORY_DB_PATH: db,
      CLAUDE_CONFIG_DIR: '',
      TMB_MODEL_CACHE_DIR: cache,
      TMPDIR: hostTmp,
      NODE_OPTIONS: FAKE_UID_PRELOAD,
    };
    const r = runGate(gate, { cwd: pwd, input, env });
    return r.stdout + r.stderr;
  }

  before(() => {
    sb = makeSandbox('identity-resolution');
    cache = join(sb.dir, 'model-cache');
    hostTmp = join(sb.dir, 'host-tmp');
    mkdirSync(cache);
    mkdirSync(hostTmp);

    aProj = join(sb.dir, 'a/project');
    gitInit(aProj);
    aDb = newDb(aProj);
    addRepo(aDb, 'project', aProj);
    addTask(aDb, 1, 'feat/id-a', 'project');
    addTask(aDb, 2, 'feat/other-a', 'project');
    git(aProj, 'worktree', 'add', '-q', '-b', 'feat/id-a', join(aProj, '.claude/worktrees/id-a'));
    git(aProj, 'worktree', 'add', '-q', '-b', 'feat/other-a', join(aProj, '.claude/worktrees/other-a'));
    layouts.a = { project: aProj, db: aDb, task: 1, wt: join(aProj, '.claude/worktrees/id-a'), other: join(aProj, '.claude/worktrees/other-a') };
    wtA = layouts.a.wt;

    bProj = join(sb.dir, 'b/project');
    const bRepo = join(sb.dir, 'b/elsewhere/svc');
    mkdirSync(bProj, { recursive: true });
    gitInit(bRepo);
    const bDb = newDb(bProj);
    addRepo(bDb, 'svc', bRepo);
    addTask(bDb, 1, 'fix/id-b', 'svc');
    git(bRepo, 'worktree', 'add', '-q', '-b', 'fix/id-b', join(bRepo, '.claude/worktrees/id-b'));
    git(bRepo, 'worktree', 'add', '-q', '-b', 'fix/other-b', join(bRepo, '.claude/worktrees/other-b'));
    layouts.b = { project: bProj, db: bDb, task: 1, wt: join(bRepo, '.claude/worktrees/id-b'), other: join(bRepo, '.claude/worktrees/other-b') };

    const cHost = join(sb.dir, 'c/host');
    gitInit(cHost);
    cProj = join(cHost, '.claude/worktrees/p1');
    git(cHost, 'worktree', 'add', '-q', '-b', 'feat/p1', cProj);
    git(cHost, 'worktree', 'add', '-q', '-b', 'feat/p2', join(cHost, '.claude/worktrees/p2'));
    cDb = newDb(cProj);
    addRepo(cDb, 'p1', cProj);
    addTask(cDb, 1, 'feat/id-c', '');
    git(cProj, 'worktree', 'add', '-q', '-b', 'feat/id-c', join(cProj, '.claude/worktrees/id-c'));
    layouts.c = { project: cProj, db: cDb, task: 1, wt: join(cProj, '.claude/worktrees/id-c'), other: join(cHost, '.claude/worktrees/p2') };

    dProj = join(sb.dir, 'd/ws');
    gitInit(dProj);
    gitInit(join(dProj, 'svc-a'));
    gitInit(join(dProj, 'svc-b'));
    dDb = newDb(dProj);
    addRepo(dDb, 'ws', dProj);
    addRepo(dDb, 'svc-a', join(dProj, 'svc-a'));
    addRepo(dDb, 'svc-b', join(dProj, 'svc-b'));
    addTask(dDb, 1, 'feat/id-d', 'svc-a');
    git(join(dProj, 'svc-a'), 'worktree', 'add', '-q', '-b', 'feat/id-d', join(dProj, 'svc-a/.claude/worktrees/id-d'));
    git(join(dProj, 'svc-b'), 'worktree', 'add', '-q', '-b', 'feat/id-d', join(dProj, 'svc-b/.claude/worktrees/id-d'));
    layouts.d = { project: dProj, db: dDb, task: 1, wt: join(dProj, 'svc-a/.claude/worktrees/id-d'), other: join(dProj, 'svc-b/.claude/worktrees/id-d') };

    const eOuter = join(sb.dir, 'e/outer/.claude/worktrees/n1');
    const eProj = join(eOuter, '.claude/worktrees/n2');
    gitInit(eProj);
    const eDb = newDb(eProj);
    addRepo(eDb, 'n2', '.');
    addTask(eDb, 1, 'chore/id-e', 'n2');
    git(eProj, 'worktree', 'add', '-q', '-b', 'chore/id-e', join(eProj, '.claude/worktrees/id-e'));
    git(eProj, 'worktree', 'add', '-q', '-b', 'chore/other-e', join(eOuter, '.claude/worktrees/other-e'));
    layouts.e = { project: eProj, db: eDb, task: 1, wt: join(eProj, '.claude/worktrees/id-e'), other: join(eOuter, '.claude/worktrees/other-e') };

    for (const l of Object.values(layouts)) {
      mkdirSync(join(l.wt, 'src'), { recursive: true });
      mkdirSync(l.other, { recursive: true });
    }
  });

  after(() => sb.remove());

  for (const label of ['a', 'b', 'c', 'd', 'e']) {
    describe(`layout (${label}): a swe may Edit inside its worktree and nowhere else`, () => {
      for (const where of ['the swe worktree', 'another worktree', 'the project root'] as const) {
        it(`cwd and $PWD at ${where}`, () => {
          const { project, db, task, wt, other } = layouts[label];
          const dir = where === 'the swe worktree' ? wt : where === 'another worktree' ? other : project;
          const tr = transcript(task);
          const run = (gate: string, tool: string, ti: ToolInput) => hook(gate, project, db, dir, payload('swe', tr, dir, tool, ti));

          assert.equal(decision(run(BOUNDARY, 'Edit', edit(join(wt, 'src/f.txt')))), 'allow', 'swe-boundary: Edit inside the derived worktree');
          let out = run(BOUNDARY, 'Edit', edit(join(other, 'f.txt')));
          assert.equal(decision(out), 'deny', 'swe-boundary: Edit in another worktree');
          assert.ok(reason(out).includes(`(${wt})`), `swe-boundary: the reason names the derived worktree: ${reason(out)}`);
          assert.equal(decision(run(BOUNDARY, 'Edit', edit(join(project, 'f.txt')))), 'deny', 'swe-boundary: Edit at the project root');

          assert.equal(decision(run(CONTAIN, 'Edit', edit(join(wt, 'src/f.txt')))), 'allow', 'containment: Edit inside the derived worktree');
          out = run(CONTAIN, 'Edit', edit(join(other, 'f.txt')));
          assert.equal(decision(out), 'deny', 'containment: Edit in another worktree');
          assert.ok(reason(out).includes(`root ${wt}.`), `containment: the reason names the derived worktree: ${reason(out)}`);
          assert.equal(decision(run(CONTAIN, 'Edit', edit(join(project, 'f.txt')))), 'deny', 'containment: Edit at the project root');
          assert.equal(decision(run(CONTAIN, 'Bash', bashCmd(`echo x > ${wt}/src/o.txt`))), 'allow', 'containment: Bash write inside the derived worktree');
          assert.equal(decision(run(CONTAIN, 'Bash', bashCmd(`echo x > ${other}/o.txt`))), 'deny', 'containment: Bash write in another worktree');
        });
      }

      it('a relative Bash target joins the payload cwd', () => {
        const { project, db, task, wt, other } = layouts[label];
        const tr = transcript(task);
        const rel = bashCmd('echo x > rel.txt');
        assert.equal(decision(hook(CONTAIN, project, db, project, payload('swe', tr, wt, 'Bash', rel))), 'allow', 'payload cwd at the worktree, $PWD at the project');
        assert.equal(decision(hook(CONTAIN, project, db, wt, payload('swe', tr, other, 'Bash', rel))), 'deny', 'payload cwd at another worktree, $PWD at the worktree');
      });
    });
  }

  it('(d) the root-level worktree of the same slug is another worktree', () => {
    const rootWt = join(dProj, '.claude/worktrees/id-d');
    mkdirSync(rootWt, { recursive: true });
    const out = hook(BOUNDARY, dProj, dDb, rootWt, payload('swe', transcript(1), rootWt, 'Edit', edit(join(rootWt, 'f.txt'))));
    assert.equal(decision(out), 'deny', 'swe-boundary: ws/.claude/worktrees/id-d is not svc-a\'s');
  });

  describe('an unresolvable swe is denied with the missing piece named', () => {
    before(() => addTask(aDb, 3, 'feat/ghost', 'ghost'));

    for (const gate of [BOUNDARY, CONTAIN]) {
      it(gate, () => {
        const run = (tr: string) => hook(gate, aProj, aDb, wtA, payload('swe', tr, wtA, 'Edit', edit(join(wtA, 'f.txt'))));
        let out = run('');
        assert.equal(decision(out), 'deny', `${gate}: no transcript`);
        assert.ok(reason(out).includes('no task_id'), `${gate}: names the missing task_id: ${reason(out)}`);
        out = run(transcript(99));
        assert.equal(decision(out), 'deny', `${gate}: a task with no row`);
        assert.ok(reason(out).includes('task 99 has no tasks row'), `${gate}: names the missing tasks row: ${reason(out)}`);
        out = run(transcript(3));
        assert.equal(decision(out), 'deny', `${gate}: a task whose repo has no row`);
        assert.ok(reason(out).includes("repo 'ghost' has no repos row"), `${gate}: names the missing repos row: ${reason(out)}`);
      });
    }
  });

  it('tasks.repo empty with several repos rows names the ambiguity', () => {
    addTask(dDb, 2, 'feat/no-repo', '');
    const out = hook(BOUNDARY, dProj, dDb, dProj, payload('swe', transcript(2), dProj, 'Edit', edit(join(dProj, 'svc-a/f.txt'))));
    assert.equal(decision(out), 'deny', 'swe-boundary: no repo resolves');
    assert.ok(reason(out).includes('tasks.repo is empty'), `names the empty tasks.repo: ${reason(out)}`);
  });

  it('bro is unchanged: the project is its root', () => {
    for (const dir of [aProj, wtA]) {
      const run = (gate: string, p: string) => hook(gate, aProj, aDb, dir, payload('', '', dir, 'Edit', edit(p)));
      assert.equal(decision(run(BOUNDARY, join(aProj, 'README.md'))), 'allow', `swe-boundary ignores bro (cwd ${dir})`);
      assert.equal(decision(run(CONTAIN, join(aProj, 'README.md'))), 'allow', `containment: bro Edit in the project (cwd ${dir})`);
      const out = run(CONTAIN, join(bProj, 'f.txt'));
      assert.equal(decision(out), 'deny', `containment: bro Edit outside the project (cwd ${dir})`);
      assert.ok(reason(out).includes(`root ${aProj}.`), `containment: bro's root is the project: ${reason(out)}`);
    }
  });

  it('the spawn transcript falls back to <transcript_path>/subagents/agent-<id>.jsonl', () => {
    const session = join(sb.dir, 'session-1550');
    mkdirSync(join(session, 'subagents'), { recursive: true });
    writeFileSync(join(session, 'subagents/agent-ab12.jsonl'), `${JSON.stringify({ message: { content: [{ type: 'text', text: 'task_id=1' }] } })}\n`);
    const input = (p: string) =>
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        cwd: aProj,
        tool_name: 'Edit',
        agent_type: 'swe',
        agent_id: 'ab12',
        transcript_path: `${session}.jsonl`,
        tool_input: edit(p),
      });
    for (const gate of [BOUNDARY, CONTAIN]) {
      assert.equal(decision(hook(gate, aProj, aDb, aProj, input(join(wtA, 'f.txt')))), 'allow', `${gate}: inside the worktree`);
      assert.equal(decision(hook(gate, aProj, aDb, aProj, input(join(aProj, '.claude/worktrees/other-a/f.txt')))), 'deny', `${gate}: another worktree`);
    }
  });

  describe('heredoc program text is data; a redirect is a target', () => {
    const prog = () => ["python3 - <<'PY'", `s = open('${wtA}/notes.txt').read()`, "s = s.replace('x', '/user/own')", `open('${wtA}/notes.txt', 'w').write(s)`, 'PY'].join('\n');
    const contain = (cmd: string) => hook(CONTAIN, aProj, aDb, aProj, payload('swe', transcript(1), aProj, 'Bash', bashCmd(cmd)));

    it('a heredoc python program the guard cannot prove is denied as unproven (GH 1739), never naming /user/own', () => {
      const out = contain(prog());
      assert.equal(decision(out), 'deny', 'a heredoc python program the guard cannot prove is denied as unproven');
      assert.ok(reason(out).includes('the inline program is unproven'), `the reason is the unproven program: ${reason(out)}`);
      assert.ok(!reason(out).includes('/user/own'), 'a replace() argument naming /user/own is not a write target');
    });

    it('a write through a variable counts every literal', () => {
      const out = contain(["python3 - <<'PY'", `p = '${wtA}/notes.txt'`, 's = open(p).read()', "s = s.replace('x', '/user/own')", "open(p, 'w').write(s)", 'PY'].join('\n'));
      assert.equal(decision(out), 'deny', 'a write through a variable counts every literal');
      assert.ok(reason(out).includes('/user/own'), `the reason names /user/own: ${reason(out)}`);
    });

    it('echo x > /outside/f is a write target', () => {
      const out = contain('echo x > /outside/f');
      assert.equal(decision(out), 'deny', 'echo x > /outside/f is a write target');
      assert.ok(reason(out).includes('/outside/f'), `the reason names /outside/f: ${reason(out)}`);
    });

    for (const gate of [BOUNDARY, CONTAIN]) {
      it(`${gate}: a path routed through a text call or a rebound variable is still a write target`, () => {
        // swe-boundary judges Bash writes by the prompt surface (rule e), so its target is the worktree's CLAUDE.md.
        const t = gate === BOUNDARY ? join(wtA, 'CLAUDE.md') : join(sb.dir, 'outside-1550/evil');
        const cmds = [
          `python3 -c "p='x'.replace('x','${t}'); open(p,'w').write('1')"`,
          ["python3 - <<'PY'", `p='x'.replace('x','${t}'); open(p,'w').write('1')`, 'PY'].join('\n'),
          `python3 -c "open('x'.replace('x','${t}'),'w')"`,
          `node -e "const p='x'.replace('x','${t}'); require('fs').writeFileSync(p,'1')"`,
          `python3 -c "import cProfile; p='notes.txt'; cProfile.run('p=%r' % '${t}'); open(p,'w').write('1')"`,
          ["python3 - <<'PY'", 'import cProfile', "p = 'notes.txt'", `cProfile.run('p=%r' % '${t}')`, "open(p, 'w').write('1')", 'PY'].join('\n'),
          ["python3 - <<'PY'", 'import trace', "p = 'notes.txt'", `trace.Trace(count=0, trace=0).run('p=%r' % '${t}')`, "open(p, 'w').write('1')", 'PY'].join('\n'),
          [
            "python3 - <<'PY'",
            'import gc',
            "p = 'notes.txt'",
            'for o in gc.get_objects():',
            `    if isinstance(o, dict) and o.get('p') == 'notes.txt': o['p'] = '${t}'`,
            "open(p, 'w').write('1')",
            'PY',
          ].join('\n'),
        ];
        const run = (cmd: string) => hook(gate, aProj, aDb, wtA, payload('swe', transcript(1), wtA, 'Bash', bashCmd(cmd)));
        for (const cmd of cmds) assert.equal(decision(run(cmd)), 'deny', `${gate}: ${cmd.split('\n')[0]}`);
        if (gate === CONTAIN) assert.equal(decision(run(prog())), 'deny', `${gate}: the /user/own heredoc is denied as an unproven program (GH 1739)`);
        else assert.equal(decision(run(prog())), 'allow', `${gate}: the /user/own heredoc stays allowed`);
      });
    }
  });

  it('the scan walker from a session dir under .claude/worktrees/<n> finds the repo', () => {
    const script = `
      const [, dist, db, dir] = process.argv;
      const { TrajectoryDB } = await import(dist + '/db.js');
      const { walkProject } = await import(dist + '/tools/scan-walk.js');
      process.stdout.write(JSON.stringify(await walkProject(new TrajectoryDB(db), dir, { timeoutMs: 60000 })));
    `;
    const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', '--input-type=module', '-e', script, DIST, cDb, cProj], {
      encoding: 'utf8',
      env: { ...sb.env, TMB_FORBID_LIVE_SYNC: '1' },
      timeout: 120_000,
    });
    assert.equal(r.status, 0, r.stderr);
    const repos = (JSON.parse(r.stdout) as { repos: { path: string }[] }).repos;
    assert.ok(repos.length >= 1, `the scan walker found ${repos.length} repos under ${cProj}`);
    assert.equal(repos[0].path, cProj, 'the repo is the session dir itself');
  });
});
