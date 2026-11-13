/**
 * The one trajectory-DB location rule (docs/architecture/MEMORY.md#where-the-trajectory-db-lives)
 * across the hooks, and the fail-closed gate semantics that ride on it
 * (GH 1692). Every hook runs as `node dist/hooks.js <hook>` with a temp HOME.
 *
 * Part A — the TMB workspace layout: DB at <ws>/.claude/tmb/trajectory.db, the
 * repo at <ws>/plugin with its own .git, hooks running with cwd inside the
 * repo. Every hook that used to carry a private copy of the path rule must
 * resolve the workspace DB, both with CLAUDE_PROJECT_DIR=<ws> (root) and with
 * CLAUDE_PROJECT_DIR unset and no test flag (walk, the outermost walk).
 *
 * Part B — every deny-capable gate: (a) DB unresolved → allow, (b) DB present
 * but unreadable → deny with the "trajectory DB unavailable" reason, (c) the
 * normal path still decides as before.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { childEnv, FAKE_UID_PRELOAD, GIT_ENV, HOOKS_JS, runNode, sandboxDir, sqlExec, sqlRows, sqlRun, type Run } from './db-test-fixtures.js';

const RUN_ID = 'db-path-rule';

/** The columns and tables the hooks under test read. */
const SCHEMA = `
  CREATE TABLE issues (id INTEGER PRIMARY KEY, objective TEXT DEFAULT 'o', status TEXT DEFAULT 'open', repo TEXT, created_at TEXT DEFAULT '2026-01-01', updated_at TEXT DEFAULT '2026-01-01');
  CREATE TABLE tasks (id INTEGER PRIMARY KEY, issue_id INTEGER DEFAULT 1, branch_id TEXT, status TEXT, spec_body TEXT DEFAULT '## spec', repo TEXT, parent_branch_id TEXT, files TEXT, verification TEXT, prompt_bearing INTEGER DEFAULT 0, commit_sha TEXT);
  CREATE TABLE repos (name TEXT, path TEXT, target_branch TEXT, branching_model TEXT, protected_branches TEXT);
  CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT);
  CREATE TABLE plugin_meta (id INTEGER PRIMARY KEY, schema_version INTEGER);
  CREATE TABLE agents (name TEXT, kind TEXT);
  CREATE TABLE discussions (id INTEGER PRIMARY KEY, issue_id INTEGER, author TEXT, kind TEXT, body TEXT, created_at TEXT);
  CREATE TABLE audit (id INTEGER PRIMARY KEY, issue_id INTEGER, branch_id TEXT, from_node TEXT, event_type TEXT, summary TEXT, content_json TEXT, repo TEXT, created_at TEXT);
  CREATE TABLE validation_attempts (task_id TEXT, verdict TEXT);
  CREATE TABLE debug_trajectory (session_id TEXT, step_n INTEGER, kind TEXT, tool_or_mcp_name TEXT, args_json TEXT, created_at TEXT);
  INSERT INTO plugin_meta (schema_version) VALUES (30);
`;

function schema(db: string): void {
  mkdirSync(dirname(db), { recursive: true });
  sqlExec(db, SCHEMA);
}

const DENY = '"permissionDecision":"deny"';
const UNAVAILABLE = 'trajectory DB unavailable';
const BRANCH_CREATE = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git worktree add -b feat/x .claude/worktrees/x' } });

describe('db-path-rule: one trajectory-DB location rule across the hooks, and fail-closed gates', () => {
  let base: string;
  let fakeHome: string;
  let livePath: string;
  let ws: string;
  let repo: string;
  let wsDb: string;
  let gateRepo: string;
  let wt: string;
  let goodDb: string;
  let corruptDb: string;
  let lockedDb: string;
  let missingDb: string;
  let spawnTr: string;

  const git = (...args: string[]) => execFileSync('git', args, { env: { ...process.env, ...GIT_ENV, HOME: fakeHome }, stdio: 'pipe' });

  function gitInit(dir: string): void {
    git('-C', dir, 'init', '-q', '-b', 'main');
    git('-C', dir, 'config', 'user.email', 't@example.com');
    git('-C', dir, 'config', 'user.name', 'T');
    writeFileSync(join(dir, 'README.md'), 'x\n');
    git('-C', dir, 'add', 'README.md');
    git('-C', dir, 'commit', '-qm', 'init');
  }

  /** The env every hook run starts from: the l3 runner's, a test flag set, HOME and TMPDIR in the sandbox. */
  const baseEnv = (extra: Record<string, string | undefined> = {}) =>
    childEnv({ HOME: fakeHome, TMPDIR: join(base, 'tmp'), NODE_OPTIONS: FAKE_UID_PRELOAD, TMB_TEST_RUN_ID: RUN_ID, ...GIT_ENV, ...extra });

  const hook = (name: string, payload: string, cwd: string, env: NodeJS.ProcessEnv): Run => runNode([HOOKS_JS, name], { cwd, env, input: payload });

  /**
   * <hook> with cwd inside the repo. mode=root sets CLAUDE_PROJECT_DIR=<ws>;
   * mode=walk leaves it unset and drops the test flags, under which the
   * resolver never walks.
   */
  function runWs(mode: 'root' | 'walk', name: string, payload: string, extra: Record<string, string> = {}): Run {
    const env = mode === 'root' ? baseEnv({ CLAUDE_PROJECT_DIR: ws, ...extra }) : baseEnv({ TMB_TEST_RUN_ID: undefined, TMB_FORBID_LIVE_SYNC: undefined, ...extra });
    return hook(name, payload, join(repo, 'src'), env);
  }

  const runGate = (name: string, payload: string, db: string, cwd = gateRepo): Run => hook(name, payload, cwd, baseEnv({ TRAJECTORY_DB_PATH: db }));

  before(() => {
    base = sandboxDir('db-path-rule');
    fakeHome = join(base, 'home');
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    mkdirSync(join(base, 'tmp'), { recursive: true });
    mkdirSync(join(base, 'bin'), { recursive: true });
    writeFileSync(join(base, 'bin/pgrep'), '#!/usr/bin/env node\nconsole.log(99999);\n', { mode: 0o755 });
    livePath = `${join(base, 'bin')}:${process.env.PATH ?? ''}`;

    ws = join(base, 'ws');
    repo = join(ws, 'plugin');
    wsDb = join(ws, '.claude/tmb/trajectory.db');
    mkdirSync(join(repo, 'src'), { recursive: true });
    schema(wsDb);
    gitInit(repo);
    const origin = join(base, 'origin.git');
    git('clone', '-q', '--bare', repo, origin);
    git('-C', repo, 'remote', 'add', 'origin', origin);
    git('-C', repo, 'fetch', '-q', 'origin');
    git('-C', repo, 'branch', 'feat/stale', 'main');
    writeFileSync(join(repo, 'README.md'), 'x\ny\n');
    git('-C', repo, 'commit', '-qam', 'ahead');
    git('-C', repo, 'push', '-q', 'origin', 'main');
    sqlExec(wsDb, "INSERT INTO plugin_config VALUES ('onboarded', 'true'); INSERT INTO issues (id, objective) VALUES (1, 'one'), (2, 'two'), (3, 'three');");
    sqlRun(wsDb, "INSERT INTO repos (name, path, target_branch) VALUES ('plugin', ?, 'main')", repo);

    const gateDir = join(base, 'gate');
    gateRepo = join(gateDir, 'repo');
    wt = join(gateRepo, '.claude/worktrees/db-rule');
    for (const d of [join(wt, 'src'), join(wt, 'agents')]) mkdirSync(d, { recursive: true });
    gitInit(gateRepo);
    goodDb = join(gateDir, 'good.db');
    schema(goodDb);
    sqlExec(
      goodDb,
      `INSERT INTO issues (id) VALUES (1);
       INSERT INTO tasks (id, branch_id, status, repo, files) VALUES
         (1, 'feat/missing-branch', 'pending', 'repo', NULL),
         (2, 'feat/open', 'running', NULL, NULL),
         (3, 'feat/db-rule', 'running', NULL, '["docs/"]'),
         (4, 'feat/done', 'completed', NULL, NULL);
       INSERT INTO agents VALUES ('security', 'consultant');`,
    );
    sqlRun(goodDb, "INSERT INTO repos (name, path, target_branch) VALUES ('repo', ?, 'main')", gateRepo);
    corruptDb = join(gateDir, 'corrupt.db');
    writeFileSync(corruptDb, 'this is not a sqlite database, only text');
    lockedDb = join(gateDir, 'locked.db');
    copyFileSync(goodDb, lockedDb);
    chmodSync(lockedDb, 0o000);
    missingDb = join(gateDir, 'missing.db');
    spawnTr = join(gateDir, 'spawn-3.jsonl');
    writeFileSync(spawnTr, '{"message":{"content":[{"type":"text","text":"task_id=3"}]}}\n');
  });

  after(() => {
    if (existsSync(lockedDb)) chmodSync(lockedDb, 0o600);
    rmSync(base, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // Part A — TMB layout
  // --------------------------------------------------------------------------
  for (const mode of ['root', 'walk'] as const) {
    it(`[${mode}] activation-routine reads the workspace DB`, () => {
      const out = runWs(mode, 'activation-routine', '{"prompt":"hey bro"}', { PATH: livePath }).stdout;
      assert.ok(out.includes('onboarded=yes'), 'onboarded marker from the workspace DB');
      assert.ok(out.includes('pending=#3'), 'pending issue from the workspace DB');
    });

    it(`[${mode}] branch-up-to-date-with-remote gates (was inert in this layout)`, () => {
      const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: `cd ${repo} && git worktree add .claude/worktrees/s feat/stale` } });
      const out = runWs(mode, 'branch-up-to-date-with-remote', payload).stdout;
      assert.ok(out.includes(DENY), 'stale branch denied');
      assert.ok(out.includes('behind origin/main'), 'behind-remote reason');
    });

    it(`[${mode}] no-worktree-branch-create gates (was inert in this layout)`, () => {
      assert.ok(runWs(mode, 'no-worktree-branch-create', BRANCH_CREATE).stdout.includes('cannot create a branch'), 'branch-create denied');
    });

    it(`[${mode}] debug-trajectory writes to the workspace DB`, () => {
      const count = () => Number(sqlRows(wsDb, 'SELECT COUNT(*) FROM debug_trajectory;'));
      const before_ = count();
      runWs(mode, 'debug-trajectory', '{"tool_name":"Read","tool_input":{"file_path":"x"}}', { TMB_EVAL_MODE: '1', TMB_DEBUG_TRAJECTORY: '1' });
      assert.equal(count(), before_ + 1, 'one debug row in the workspace DB');
    });

    it(`[${mode}] no-source-edit-from-main guards the registered repo`, () => {
      const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(repo, 'src/main.ts') } });
      assert.ok(runWs(mode, 'no-source-edit-from-main', payload).stdout.includes('source edits from the main checkout are denied'), 'main-checkout source edit denied');
    });

    it(`[${mode}] session-start-prescan reads the workspace DB`, () => {
      const out = runWs(mode, 'session-start-prescan', '{}').stdout;
      const context = String(JSON.parse(out).hookSpecificOutput?.additionalContext ?? '');
      assert.ok(context.includes('Open issues:       3'), 'issue count from the workspace DB');
    });

    it(`[${mode}] mcp-health-check logs the workspace DB, beside it`, () => {
      const healthLog = join(dirname(wsDb), 'logs/mcp-health.log');
      rmSync(healthLog, { force: true });
      runWs(mode, 'mcp-health-check', '{"hook_event_name":"SessionStart","session_id":"s"}', { TMB_MCP_HEALTH_SAMPLES: '1' });
      const last = readFileSync(healthLog, 'utf8').trimEnd().split('\n').at(-1) ?? '';
      assert.equal(JSON.parse(last).db_path, wsDb, 'db_path logged');
    });

    it(`[${mode}] orphan-scan anchors on the workspace project`, () => {
      const slug = ws.replace(/[^A-Za-z0-9]+/g, '-');
      const stale = join(fakeHome, '.claude/projects', slug, 'trajectory.db');
      mkdirSync(dirname(stale), { recursive: true });
      writeFileSync(stale, '');
      try {
        const out = runWs(mode, 'orphan-scan', '{}', { TMB_ORPHAN_SCAN_HOME: fakeHome, TMB_ORPHAN_SCAN_HOLDERS_OVERRIDE: ' ' }).stdout;
        assert.ok(out.includes(`stale trajectory DB (this project): ${stale}`), 'stale DB of the workspace project reported');
      } finally {
        rmSync(join(fakeHome, '.claude/projects'), { recursive: true, force: true });
      }
    });

    it(`[${mode}] ensure-gitignore covers the registered repo, not the cwd`, () => {
      assert.equal(runWs(mode, 'ensure-gitignore', '{}').stdout, '', 'no stdout');
      assert.ok(readFileSync(join(repo, '.gitignore'), 'utf8').split('\n').includes('.claude/'), '.claude/ ignored in the repo');
    });
  }

  for (const [mode, name, label] of [
    ['root', '[root] a nested repo DB does not shadow the project-root DB', 'still the workspace DB'],
    ['walk', '[walk] the outermost DB wins over a nested repo DB', 'outermost workspace DB'],
  ] as const) {
    it(name, () => {
      schema(join(repo, '.claude/tmb/trajectory.db'));
      try {
        assert.ok(runWs(mode, 'activation-routine', '{"prompt":"hey bro"}', { PATH: livePath }).stdout.includes('pending=#3'), label);
      } finally {
        rmSync(join(repo, '.claude'), { recursive: true, force: true });
      }
    });
  }

  it('[root] CLAUDE_PROJECT_DIR below the workspace walks up to the workspace DB (GH 1553)', () => {
    const out = hook('no-worktree-branch-create', BRANCH_CREATE, '/', baseEnv({ TMB_TEST_RUN_ID: undefined, TMB_FORBID_LIVE_SYNC: undefined, CLAUDE_PROJECT_DIR: repo })).stdout;
    assert.ok(out.includes('cannot create a branch'), 'workspace DB resolved → branch-create denied');
  });

  it('[root] CLAUDE_PROJECT_DIR with no DB above it is unresolved', () => {
    mkdirSync(join(base, 'nodb/project'), { recursive: true });
    const env = baseEnv({ TMB_TEST_RUN_ID: undefined, TMB_FORBID_LIVE_SYNC: undefined, CLAUDE_PROJECT_DIR: join(base, 'nodb/project') });
    assert.equal(hook('no-worktree-branch-create', BRANCH_CREATE, join(repo, 'src'), env).stdout, '', 'unresolved → allow');
  });

  it('[root] under a test flag CLAUDE_PROJECT_DIR without its own DB is unresolved (no walking)', () => {
    assert.equal(hook('no-worktree-branch-create', BRANCH_CREATE, join(repo, 'src'), baseEnv({ CLAUDE_PROJECT_DIR: repo })).stdout, '', 'unresolved → allow');
  });

  // --------------------------------------------------------------------------
  // Part B — deny-capable gates: unresolved / unreadable / normal
  // --------------------------------------------------------------------------
  const gates: { hook: string; payload: () => string; normal: string }[] = [
    { hook: 'require-task-spec', payload: () => '{"tool_name":"Agent","tool_input":{"subagent_type":"swe","prompt":"task_id=4"}}', normal: 'has status=completed' },
    {
      hook: 'require-feature-branch-active',
      payload: () => '{"tool_name":"Agent","tool_input":{"subagent_type":"swe","prompt":"task_id=1"}}',
      normal: 'needs branch feat/missing-branch',
    },
    {
      hook: 'code-reviewer-after-atomic-close',
      payload: () => '{"tool_name":"Agent","tool_input":{"subagent_type":"code-reviewer","prompt":"task_id=4"}}',
      normal: 'has no review_handoff for the task\'s current commit',
    },
    { hook: 'stay-on-base-guard', payload: () => '{"tool_name":"Bash","tool_input":{"command":"git checkout feat/open"}}', normal: 'belongs to open task #2' },
    { hook: 'no-worktree-branch-create', payload: () => BRANCH_CREATE, normal: 'cannot create a branch' },
    {
      hook: 'no-source-edit-from-main',
      payload: () => JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(gateRepo, 'main.ts') } }),
      normal: 'source edits from the main checkout are denied',
    },
    {
      hook: 'branch-up-to-date-with-remote',
      payload: () => JSON.stringify({ tool_name: 'Bash', tool_input: { command: `cd ${gateRepo} && git worktree add .claude/worktrees/y main` } }),
      normal: '',
    },
    { hook: 'consultant-persistence-gate', payload: () => '{"agent_type":"security","stop_hook_active":false}', normal: 'Consultant persistence gate' },
  ];

  for (const g of gates) {
    it(`${g.hook}: unresolved DB allows`, () => {
      const out = runGate(g.hook, g.payload(), missingDb).stdout;
      assert.ok(!out.includes(DENY), 'no deny');
      assert.ok(!out.includes('"decision":"block"'), 'no block');
    });

    it(`${g.hook}: corrupt DB denies as unavailable`, () => {
      assert.ok(runGate(g.hook, g.payload(), corruptDb).stdout.includes(UNAVAILABLE), 'unavailable reason');
    });

    it(`${g.hook}: unreadable (chmod 000) DB denies as unavailable`, () => {
      assert.ok(runGate(g.hook, g.payload(), lockedDb).stdout.includes(UNAVAILABLE), 'unavailable reason');
    });

    it(`${g.hook}: normal path unchanged`, () => {
      const out = runGate(g.hook, g.payload(), goodDb).stdout;
      if (g.normal === '') assert.equal(out, '', 'normal allow');
      else assert.ok(out.includes(g.normal), 'normal decision');
      assert.ok(!out.includes(UNAVAILABLE), 'not the unavailable reason');
    });
  }

  // swe-scope-fence only notes a write outside files[]: a DB error leaves it
  // silent, never a deny. The swe's spawn transcript names task 3, whose
  // worktree is <wt>.
  const sfPayload = () => JSON.stringify({ tool_name: 'Edit', agent_type: 'swe', agent_transcript_path: spawnTr, tool_input: { file_path: join(wt, 'src/x.ts') } });

  it('swe-scope-fence: corrupt or unreadable DB stays silent', () => {
    assert.equal(runGate('swe-scope-fence', sfPayload(), corruptDb, wt).stdout, '', 'corrupt DB: no output');
    assert.equal(runGate('swe-scope-fence', sfPayload(), lockedDb, wt).stdout, '', 'unreadable DB: no output');
  });

  it('swe-scope-fence: normal path notes the out-of-fence write', () => {
    assert.ok(runGate('swe-scope-fence', sfPayload(), goodDb, wt).stdout.includes("src/x.ts is outside this task's files[]"), 'the note');
  });

  // swe-boundary keeps its prompt-surface deny for un-onboarded projects (its
  // rule needs no DB); the DB only grants prompt_bearing. So (a) asserts the
  // reason is the prompt-surface one, never the unavailable one.
  const sbPayload = () => JSON.stringify({ tool_name: 'Edit', agent_type: 'swe', agent_transcript_path: spawnTr, tool_input: { file_path: join(wt, 'agents/a.md') } });

  it('swe-boundary: unresolved DB keeps the un-onboarded behaviour', () => {
    const out = runGate('swe-boundary', sbPayload(), missingDb, wt).stdout;
    assert.ok(out.includes('may not edit prompt-surface files'), 'prompt-surface reason');
    assert.ok(!out.includes(UNAVAILABLE), 'not the unavailable reason');
  });

  it('swe-boundary: corrupt DB denies as unavailable', () => {
    assert.ok(runGate('swe-boundary', sbPayload(), corruptDb, wt).stdout.includes(UNAVAILABLE), 'unavailable reason');
  });

  it('swe-boundary: normal path unchanged', () => {
    assert.ok(runGate('swe-boundary', sbPayload(), goodDb, wt).stdout.includes('may not edit prompt-surface files'), 'prompt-surface reason');
    sqlExec(goodDb, 'UPDATE tasks SET prompt_bearing = 1 WHERE id = 3;');
    assert.equal(runGate('swe-boundary', sbPayload(), goodDb, wt).stdout, '', 'prompt_bearing=1 task allows');
  });

  it('advisory hooks log one stderr line and allow on a DB error', () => {
    const r = hook('activation-routine', '{"prompt":"hey bro"}', gateRepo, baseEnv({ PATH: livePath, TRAJECTORY_DB_PATH: corruptDb }));
    assert.ok(r.stderr.includes('activation-routine: trajectory DB unavailable'), 'activation-routine stderr line');
    assert.equal(r.stdout, '', 'activation-routine emits nothing');
  });
});
