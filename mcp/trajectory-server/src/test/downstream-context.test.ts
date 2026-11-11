/**
 * The downstream-context A/B (GH 1990): the swe and code-reviewer context
 * hooks over a seeded trajectory DB and a git repo, enrollment, the report's
 * three cells, and the hooks' silence on a bad payload, an unreadable DB and
 * an empty index.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDB } from './helpers.js';
import type { TrajectoryDB } from '../db.js';
import { downstreamContextArm, enrollDownstreamContextAb, type DownstreamAbStore } from '../downstream-context-ab.js';
import { downstreamContextAbReport, formatDownstreamContextAbReport, DOWNSTREAM_AB_METRICS } from '../downstream-context-ab-report.js';
import { DOWNSTREAM_CONTEXT_AB_KEY, parseDownstreamContextAb } from '../tools/config.js';
import { capSections, directDownstream, MAX_CHARS, MAX_REFS, symbolsInRanges } from '../hooks/lib/downstream.js';
import { sweDownstreamContext } from '../hooks/swe-downstream-context.js';
import { oldSideSpans, pendingReviewerTask, reviewerDownstreamContext } from '../hooks/reviewer-downstream-context.js';
import { findGate } from '../hooks/registry.js';

const ON_TASK = 2;
const OFF_TASK = 4;
const NOW = '2026-11-01T00:00:00.000Z';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
}

function context(stdout: string, event: string): string {
  const out = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string; permissionDecision?: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, event);
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  return out.hookSpecificOutput.additionalContext;
}

describe('GH 1990: downstream-context hooks over a seeded DB', () => {
  let base: string;
  let repo: string;
  let dbFile: string;
  let db: TrajectoryDB;
  let env: NodeJS.ProcessEnv;

  const injected = (): Array<{ task_id: number; role: string; path?: string }> =>
    db.all<{ c: string }>(`SELECT content_json AS c FROM audit WHERE event_type = 'downstream_context_injected' ORDER BY id`).map((r) => JSON.parse(r.c));
  const enrolled = (): Array<{ task_id: number; arm: string }> =>
    db.all<{ c: string }>(`SELECT content_json AS c FROM audit WHERE event_type = 'downstream_context_ab_enrolled' ORDER BY id`).map((r) => JSON.parse(r.c));
  const setAb = (value: string | null): void => {
    db.run(`DELETE FROM plugin_config WHERE key = ?`, [DOWNSTREAM_CONTEXT_AB_KEY]);
    if (value !== null) db.run(`INSERT INTO plugin_config (key, value_json) VALUES (?, ?)`, [DOWNSTREAM_CONTEXT_AB_KEY, value]);
  };
  const edit = (agentId: string, file: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ hook_event_name: 'PreToolUse', agent_id: agentId, agent_type: 'tmb:swe', cwd: repo, tool_name: 'Edit', tool_input: { file_path: join(repo, file), old_string: 'a', new_string: 'b' }, ...extra });

  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gh1990-')));
    repo = join(base, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    git(base, 'init', '-q', '-b', 'main', repo);
    writeFileSync(join(repo, 'src/a.ts'), 'export function foo(x: number): number {\n  return x + 1;\n}\n\nexport function solo(): void {}\n');
    writeFileSync(join(repo, 'src/b.ts'), "import { foo } from './a.js';\nexport function bar(): number {\n  return foo(1);\n}\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'feat/on');
    writeFileSync(join(repo, 'src/a.ts'), 'export function foo(x: number): string {\n  return String(x + 1);\n}\n\nexport function solo(): void {}\n');
    git(repo, 'commit', '-q', '-am', 'reshape foo');
    git(repo, 'checkout', '-q', 'main');

    dbFile = join(base, 'trajectory.db');
    db = tempDB({ path: dbFile });
    db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('r', ?, 'main')`, [repo]);
    db.run(`INSERT INTO issues (id, objective, created_at, updated_at, repo) VALUES (1, 'o', ?, ?, 'r')`, [NOW, NOW]);
    for (const id of [ON_TASK, OFF_TASK, 6, 7]) {
      db.run(
        `INSERT INTO tasks (id, issue_id, branch_id, description, status, repo, files, worktree_path, created_at, updated_at) VALUES (?, 1, ?, 'd', 'running', 'r', '["src/a.ts"]', ?, ?, ?)`,
        [id, id === ON_TASK ? 'feat/on' : `feat/t${id}`, repo, NOW, NOW],
      );
    }
    for (const [id, agent, task] of [[1, 'swe-on', ON_TASK], [2, 'swe-on-2', ON_TASK], [3, 'swe-off', OFF_TASK], [4, 'swe-7', 7]] as const) {
      db.run(`INSERT INTO agent_runs (id, task_id, issue_id, agent_type, spawn_id, started_at, repo) VALUES (?, ?, 1, 'swe', ?, ?, 'r')`, [id, task, agent, NOW]);
    }
    db.run(`INSERT INTO wm_symbols (id, repo, path, kind, qualified_name, start_line, end_line, body_hash) VALUES (10, 'r', 'src/a.ts', 'function', 'foo', 1, 3, 'h')`);
    db.run(`INSERT INTO wm_symbols (id, repo, path, kind, qualified_name, start_line, end_line, body_hash) VALUES (11, 'r', 'src/a.ts', 'function', 'solo', 5, 5, 'h')`);
    db.run(`INSERT INTO wm_symbols (id, repo, path, kind, qualified_name, start_line, end_line, body_hash) VALUES (20, 'r', 'src/b.ts', 'function', 'bar', 2, 4, 'h')`);
    db.run(`INSERT INTO wm_symbols (id, repo, path, kind, qualified_name, start_line, end_line, body_hash) VALUES (30, 'r', 'src/test/a.test.ts', 'function', 't', 1, 2, 'h')`);
    db.run(`INSERT INTO wm_edges (src_id, dst_id, dst_name, kind, resolution) VALUES (20, 10, 'foo', 'calls', 'exact'), (30, 10, 'foo', 'calls', 'exact')`);
    env = { PATH: process.env.PATH, HOME: join(base, 'home'), TRAJECTORY_DB_PATH: dbFile, CLAUDE_PROJECT_DIR: base, LC_ALL: 'C' };
  });
  after(() => {
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('GH 1990: the arm is on when floor(id / 2) is odd', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(downstreamContextArm), ['off', 'on', 'on', 'off', 'off', 'on', 'on']);
  });

  it('GH 1990: the key unset leaves the swe edit silent and enrolls nothing', () => {
    setAb(null);
    assert.equal(sweDownstreamContext(edit('swe-on', 'src/a.ts'), env).stdout, '');
    setAb('{}');
    assert.equal(sweDownstreamContext(edit('swe-on', 'src/a.ts'), env).stdout, '');
    assert.deepEqual(injected(), []);
    assert.deepEqual(enrolled(), []);
  });

  it('GH 1990: swe\'s first edit of an indexed file on an arm-on task names its callers, tests excluded, once', () => {
    setAb(JSON.stringify({ label: 'L', target: 10, tools_shipped_at: '2026-10-01T00:00:00Z' }));
    const text = context(sweDownstreamContext(edit('swe-on', 'src/a.ts'), env).stdout, 'PreToolUse');
    assert.match(text, /direct downstream of src\/a\.ts/);
    assert.match(text, /- src\/b\.ts:2 bar \(calls foo\)/);
    assert.doesNotMatch(text, /a\.test\.ts/);
    assert.equal(sweDownstreamContext(edit('swe-on', 'src/a.ts'), env).stdout, '', 'a second edit');
    assert.equal(sweDownstreamContext(edit('swe-on', 'src/a.ts', { tool_name: 'Write', tool_input: { file_path: join(repo, 'src/a.ts'), content: '' } }), env).stdout, '', 'a second edit by Write');
    const rows = injected();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].task_id, ON_TASK);
    assert.equal(rows[0].role, 'swe');
    assert.equal(rows[0].path, 'src/a.ts');
    assert.deepEqual(enrolled(), [{ label: 'L', arm: 'on', task_id: ON_TASK }]);
  });

  it('GH 1990: the arm off, a non-swe caller, a file without downstream and a non-edit tool stay silent', () => {
    assert.equal(sweDownstreamContext(edit('swe-off', 'src/a.ts'), env).stdout, '', 'arm off');
    assert.equal(sweDownstreamContext(edit('rev', 'src/a.ts', { agent_type: 'tmb:code-reviewer' }), env).stdout, '', 'code-reviewer');
    assert.equal(sweDownstreamContext(edit('', 'src/a.ts', { agent_type: undefined }), env).stdout, '', 'bro');
    assert.equal(sweDownstreamContext(edit('swe-on-2', 'src/b.ts'), env).stdout, '', 'no downstream');
    assert.equal(sweDownstreamContext(edit('swe-on-2', 'src/a.ts', { tool_name: 'Read' }), env).stdout, '', 'Read');
    assert.equal(injected().length, 1);
    assert.deepEqual(enrolled().map((r) => [r.task_id, r.arm]), [[ON_TASK, 'on'], [OFF_TASK, 'off']]);
  });

  it('GH 1990: enrollment writes one row per task and stops at the target', () => {
    sweDownstreamContext(edit('swe-off', 'src/b.ts'), env);
    assert.equal(enrolled().filter((r) => r.task_id === OFF_TASK).length, 1);
    setAb(JSON.stringify({ label: 'L', target: 2, tools_shipped_at: '2026-10-01T00:00:00Z' }));
    assert.equal(sweDownstreamContext(edit('swe-7', 'src/a.ts'), env).stdout, '', 'task 7 is past the target');
    assert.equal(enrolled().length, 2);
    setAb(JSON.stringify({ label: 'L', target: 10, tools_shipped_at: '2026-10-01T00:00:00Z' }));
  });

  it('GH 1990: a code-reviewer start on an arm-on task names the changed symbols and their callers', async () => {
    const transcript = join(base, 'parent.jsonl');
    const call = (id: string, prompt: string): string =>
      JSON.stringify({ message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: 'tmb:code-reviewer', prompt } }] } });
    writeFileSync(transcript, `${call('u1', 'review task_id=4')}\n${JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'u1' }] } })}\n${call('u2', `review task_id=${ON_TASK}`)}\n`);
    const start = JSON.stringify({ hook_event_name: 'SubagentStart', agent_id: 'rev-1', agent_type: 'tmb:code-reviewer', transcript_path: transcript, cwd: repo });
    const text = context((await reviewerDownstreamContext(start, env)).stdout, 'SubagentStart');
    assert.match(text, new RegExp(`task ${ON_TASK}'s diff`));
    assert.match(text, /Changed symbols \(1\)/);
    assert.match(text, /- src\/a\.ts:1 foo/);
    assert.doesNotMatch(text, /solo/);
    assert.match(text, /- src\/b\.ts:2 bar \(calls foo\)/);
    const rows = injected().filter((r) => r.role === 'code-reviewer');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].task_id, ON_TASK);
    assert.equal((await reviewerDownstreamContext(start.replace('tmb:code-reviewer', 'tmb:swe'), env)).stdout, '', 'a swe start');
    const off = JSON.stringify({ hook_event_name: 'SubagentStart', agent_id: 'rev-2', agent_type: 'tmb:code-reviewer', prompt: `task_id=${OFF_TASK}` });
    assert.equal((await reviewerDownstreamContext(off, env)).stdout, '', 'arm off');
  });

  it('GH 1990: a diff of more than 1000 hunks still gives the code-reviewer its changed symbols and their callers', async () => {
    const BIG_TASK = 10;
    const hunks = 1500;
    const spans = new Map<string, Array<[number, number]>>([
      ['dist/big.js', Array.from({ length: hunks }, (_, i): [number, number] => [i * 3 + 100, i * 3 + 101])],
      ['src/a.ts', [[2, 2]]],
    ]);
    assert.deepEqual(symbolsInRanges(dbFile, 'r', spans, env)?.map((s) => s.qualified_name), ['foo']);

    const big = Array.from({ length: hunks * 3 }, (_, i) => `const v${i} = ${i};`);
    git(repo, 'checkout', '-q', 'main');
    mkdirSync(join(repo, 'dist'), { recursive: true });
    writeFileSync(join(repo, 'dist/big.js'), `${big.join('\n')}\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'big dist');
    git(repo, 'checkout', '-q', '-b', 'feat/big');
    writeFileSync(join(repo, 'dist/big.js'), `${big.map((l, i) => (i % 3 === 0 ? `${l} // rebuilt` : l)).join('\n')}\n`);
    writeFileSync(join(repo, 'src/a.ts'), 'export function foo(x: number): string {\n  return String(x + 1);\n}\n\nexport function solo(): void {}\n');
    git(repo, 'commit', '-q', '-am', 'rebuild dist and reshape foo');
    git(repo, 'checkout', '-q', 'main');
    assert.ok(git(repo, 'diff', '-U0', 'main', 'feat/big').split('\n').filter((l) => l.startsWith('@@ ')).length > 1000);
    db.run(
      `INSERT INTO tasks (id, issue_id, branch_id, description, status, repo, files, worktree_path, created_at, updated_at) VALUES (?, 1, 'feat/big', 'd', 'running', 'r', '["src/a.ts"]', ?, ?, ?)`,
      [BIG_TASK, repo, NOW, NOW],
    );

    const start = JSON.stringify({ hook_event_name: 'SubagentStart', agent_id: 'rev-big', agent_type: 'tmb:code-reviewer', prompt: `task_id=${BIG_TASK}`, cwd: repo });
    const text = context((await reviewerDownstreamContext(start, env)).stdout, 'SubagentStart');
    assert.match(text, new RegExp(`task ${BIG_TASK}'s diff`));
    assert.match(text, /Changed symbols \(1\)/);
    assert.match(text, /- src\/a\.ts:1 foo/);
    assert.match(text, /- src\/b\.ts:2 bar \(calls foo\)/);
    assert.equal(injected().filter((r) => r.role === 'code-reviewer' && r.task_id === BIG_TASK).length, 1);
  });

  it('GH 1990: both hooks exit 0 silent on a bad payload, an unreadable DB and an empty index', async () => {
    for (const bad of ['', '{not json', '[]', 'null', '{"tool_name":"Edit"}']) {
      assert.deepEqual(sweDownstreamContext(bad, env), { stdout: '', code: 0 }, bad);
      assert.deepEqual(await reviewerDownstreamContext(bad, env), { stdout: '', code: 0 }, bad);
    }
    const garbage = join(base, 'garbage.db');
    writeFileSync(garbage, 'not a database');
    const broken = { ...env, TRAJECTORY_DB_PATH: garbage };
    assert.deepEqual(sweDownstreamContext(edit('swe-on-2', 'src/a.ts'), broken), { stdout: '', code: 0 });
    assert.deepEqual(await reviewerDownstreamContext(JSON.stringify({ agent_id: 'x', agent_type: 'tmb:code-reviewer', prompt: `task_id=${ON_TASK}` }), broken), { stdout: '', code: 0 });
    const missing = { ...env, TRAJECTORY_DB_PATH: join(base, 'absent', 'none.db') };
    assert.deepEqual(sweDownstreamContext(edit('swe-on-2', 'src/a.ts'), missing), { stdout: '', code: 0 });
    db.run(`CREATE TEMP TABLE keep AS SELECT * FROM wm_edges`);
    db.run(`DELETE FROM wm_edges`);
    try {
      assert.deepEqual(sweDownstreamContext(edit('swe-on-2', 'src/a.ts'), env), { stdout: '', code: 0 }, 'empty index');
    } finally {
      db.run(`INSERT INTO wm_edges SELECT * FROM keep`);
    }
  });

  it('GH 1990: the hooks route as advisory parts', () => {
    assert.equal(findGate('swe-downstream-context'), sweDownstreamContext);
    assert.equal(findGate('reviewer-downstream-context'), reviewerDownstreamContext);
  });
});

describe('GH 1990: downstream-context helpers', () => {
  it('GH 2886: directDownstream drops callers by their stored wm_files lane, else by the default rules', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gh2886-')));
    const dbFile = join(base, 'trajectory.db');
    const db = tempDB({ path: dbFile });
    try {
      const callers: Array<[number, string]> = [[20, 'src/b.ts'], [30, 'src/test/a.test.ts'], [40, 'qa/check.ts'], [50, 'tests/kept.ts'], [60, 'pkg/foo_test.go']];
      db.run(`INSERT INTO wm_symbols (id, repo, path, kind, qualified_name, start_line, end_line, body_hash) VALUES (10, 'r', 'src/a.ts', 'function', 'foo', 1, 3, 'h')`);
      for (const [id, path] of callers) {
        db.run(`INSERT INTO wm_symbols (id, repo, path, kind, qualified_name, start_line, end_line, body_hash) VALUES (?, 'r', ?, 'function', ?, 1, 2, 'h')`, [id, path, `c${id}`]);
        db.run(`INSERT INTO wm_edges (src_id, dst_id, dst_name, kind, resolution) VALUES (?, 10, 'foo', 'calls', 'exact')`, [id]);
      }
      for (const [path, lane] of [['qa/check.ts', 'test'], ['tests/kept.ts', 'product']]) {
        db.run(`INSERT INTO wm_files (repo, path, dir, updated_at, lane) VALUES ('r', ?, ?, ?, ?)`, [path, path.split('/')[0], NOW, lane]);
      }
      const env = { PATH: process.env.PATH, HOME: join(base, 'home'), LC_ALL: 'C' };
      const ds = directDownstream(dbFile, 'r', [10], env);
      assert.deepEqual(ds?.refs.map((r) => r.path), ['src/b.ts', 'tests/kept.ts']);
    } finally {
      db.close();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('GH 1990: capSections caps the refs and the chars, showing the total', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `- src/f${i}.ts:${i} sym${i} (calls foo)`);
    const { text, shown } = capSections('head', [{ title: 'Refs', lines }]);
    assert.ok(text.length <= MAX_CHARS + 200, String(text.length));
    assert.ok(shown[0]! <= MAX_REFS);
    assert.match(text, new RegExp(`of 50`));
  });

  it('GH 1990: oldSideSpans maps -U0 hunks to old-side spans, insertions to their gap', () => {
    const diff = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -3,2 +3,4 @@', '@@ -10 +12 @@', '@@ -20,0 +23,2 @@', '--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1,3 @@'].join('\n');
    assert.deepEqual([...oldSideSpans(diff)], [['x.ts', [[3, 4], [10, 10], [21, 20]]]]);
  });

  it('GH 1990: pendingReviewerTask takes the one unanswered code-reviewer spawn, none when two tasks are open', () => {
    const use = (id: string, task: number, type = 'tmb:code-reviewer'): string => JSON.stringify({ message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: type, prompt: `task_id=${task}` } }] } });
    assert.equal(pendingReviewerTask([use('a', 5), use('b', 9, 'tmb:swe')].join('\n')), 5);
    assert.equal(pendingReviewerTask([use('a', 5), use('b', 6)].join('\n')), null);
    assert.equal(pendingReviewerTask('garbage\n'), null);
  });

  it('GH 1990: the config is off when unset, {} or malformed', () => {
    assert.equal(parseDownstreamContextAb(undefined), null);
    assert.equal(parseDownstreamContextAb('{}'), null);
    assert.equal(parseDownstreamContextAb('{"label":"L","target":0,"tools_shipped_at":"2026-01-01"}'), null);
    assert.equal(parseDownstreamContextAb('{"label":"L","target":3,"tools_shipped_at":"never"}'), null);
    assert.deepEqual(parseDownstreamContextAb('{"label":"L","target":3,"tools_shipped_at":"2026-01-01T00:00:00Z"}'), { label: 'L', target: 3, tools_shipped_at: '2026-01-01T00:00:00Z' });
  });

  it('GH 1990: enrollment keeps a recorded arm and writes once', () => {
    const rows: Array<[string, string, number]> = [];
    const store: DownstreamAbStore = {
      config: () => ({ label: 'L', target: 5, tools_shipped_at: '2026-01-01T00:00:00Z' }),
      enrolledArm: (label, task) => (rows.find((r) => r[0] === label && r[2] === task)?.[1] as 'on' | 'off' | undefined) ?? 'none',
      enrolledCount: (label) => rows.filter((r) => r[0] === label).length,
      enroll: (label, arm, task) => (rows.push([label, arm, task]), true),
    };
    assert.equal(enrollDownstreamContextAb(store, 2), 'on');
    assert.equal(enrollDownstreamContextAb(store, 2), 'on');
    assert.equal(enrollDownstreamContextAb(store, 4), 'off');
    assert.equal(rows.length, 2);
    assert.equal(enrollDownstreamContextAb(store, 0), null);
  });
});

describe('GH 1990: the downstream-context A/B report', () => {
  it('GH 1990: the report gives three cells with four metrics from a seeded DB', () => {
    const db = tempDB();
    try {
      db.run(`INSERT INTO issues (id, objective, created_at, updated_at) VALUES (1, 'o', ?, ?)`, [NOW, NOW]);
      const task = (id: number, status: string, completed: string): void => {
        db.run(`INSERT INTO tasks (id, issue_id, branch_id, description, status, files, created_at, updated_at, completed_at) VALUES (?, 1, ?, 'd', ?, '["src/a.ts"]', ?, ?, ?)`, [id, `b${id}`, status, completed, completed, completed]);
      };
      task(1, 'closed', '2026-09-01T00:00:00Z');
      task(3, 'closed', '2026-09-02T00:00:00Z');
      task(5, 'closed', '2026-10-05T00:00:00Z');
      task(2, 'closed', '2026-10-06T00:00:00Z');
      task(4, 'closed', '2026-10-07T00:00:00Z');
      const run = (task: number, type: string, tokens: number): void => {
        db.run(
          `INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, started_at, completed_at) VALUES (?, 1, ?, ?, 0, 0, 0, '2026-10-06T01:00:00Z', '2026-10-06T02:00:00Z')`,
          [task, type, tokens],
        );
      };
      run(1, 'swe', 100);
      run(3, 'swe', 300);
      run(2, 'swe', 50);
      run(2, 'code-reviewer', 50);
      run(4, 'swe', 400);
      const attempt = (task: number, n: number, verdict: string): void => {
        db.run(`INSERT INTO validation_attempts (task_id, attempt_n, verdict, mcp_available, created_at) VALUES (?, ?, ?, 1, ?)`, [task, n, verdict, NOW]);
      };
      attempt(1, 1, 'pass');
      attempt(3, 1, 'fail');
      attempt(3, 2, 'pass');
      attempt(2, 1, 'pass');
      attempt(4, 1, 'fail');
      db.run(`INSERT INTO review_findings (id, task_id, attempt_n, probe_cmd, expected, observed, created_at) VALUES ('F4-1', 4, 1, 'grep foo src/b.ts', 'bar updated', 'src/b.ts still calls foo as number', ?), ('F4-2', 4, 1, 'grep x src/a.ts', 'x', 'y', ?)`, [NOW, NOW]);
      db.run(`INSERT INTO review_findings (id, task_id, attempt_n, probe_cmd, expected, observed, created_at) VALUES ('F3-1', 3, 1, 'grep foo lib/c.ts', 'c', 'd', ?)`, [NOW]);
      const wm = (from: string, at: string): void => {
        db.run(`INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (1, ?, 'wm_tool_called', 's', '{}', ?)`, [from, at]);
      };
      wm('swe', '2026-10-06T01:30:00Z');
      wm('swe', '2026-10-06T01:40:00Z');
      wm('code-reviewer', '2026-10-06T01:50:00Z');
      wm('swe', '2026-10-09T00:00:00Z');
      wm('bro', '2026-10-06T01:30:00Z');
      for (const [t, arm] of [[2, 'on'], [4, 'off']] as const) {
        db.run(`INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (1, 'hook:x', 'downstream_context_ab_enrolled', 's', ?, ?)`, [JSON.stringify({ label: 'L', arm, task_id: t }), NOW]);
      }
      const report = downstreamContextAbReport(db, { label: 'L', target: 10, tools_shipped_at: '2026-10-01T00:00:00Z' });
      assert.deepEqual(report.cells.map((c) => [c.cell, c.task_ids]), [['baseline', [1, 3]], ['hooks-off', [4]], ['hooks-on', [2]]]);
      for (const c of report.cells) assert.deepEqual(Object.keys(c.metrics), [...DOWNSTREAM_AB_METRICS]);
      const [baseline, off, on] = report.cells;
      assert.equal(baseline!.metrics.tokens.median, 200);
      assert.equal(baseline!.metrics.first_pass.mean, 0.5);
      assert.equal(baseline!.metrics.caller_bugs.mean, 0.5);
      assert.equal(off!.metrics.caller_bugs.median, 1);
      assert.equal(off!.metrics.first_pass.mean, 0);
      assert.equal(on!.metrics.tokens.median, 100);
      assert.equal(on!.metrics.first_pass.mean, 1);
      assert.equal(on!.metrics.wm_calls_per_run.median, 1.5);
      const text = formatDownstreamContextAbReport(report);
      assert.match(text, /^downstream-context A\/B 'L'/);
      assert.match(text, /hooks-on: 1 task\(s\) \[2\]/);
    } finally {
      db.close();
    }
  });
});
