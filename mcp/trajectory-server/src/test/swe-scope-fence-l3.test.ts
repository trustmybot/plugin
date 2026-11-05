/**
 * The swe-scope-fence l3 bash suite in node:test (GH 1692): the gate (and
 * swe-boundary for the heredoc case) runs as `node dist/hooks.js <gate>` from
 * a fixture worktree, CLAUDE_PROJECT_DIR pinned to the sandbox and PWD set.
 * Never denies: an out-of-scope Edit/Write gets a once-per-path-per-task note.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { ScopeFence } from '../hooks/lib/scope-fence.js';
import { makeSandbox, PLUGIN_ROOT, runGate, type Sandbox } from './hook-sandbox.js';
import { DENY, gateEnv, has, hasNot } from './git-push-guard-l3.js';

const HOOK_SRC = join(PLUGIN_ROOT, 'mcp/trajectory-server/src/hooks/swe-scope-fence.ts');

describe('swe-scope-fence l3', () => {
  let sb: Sandbox;
  let db: string;
  let wtA: string;
  let wtB: string;
  let wtRoot: string;
  let nonWt: string;

  const env = (cwd: string, extra: NodeJS.ProcessEnv = {}) => ({ ...gateEnv(sb, cwd), TRAJECTORY_DB_PATH: db, ...extra });

  function spawnTranscript(task: number): string {
    const tf = join(sb.dir, `spawn-${task}.jsonl`);
    writeFileSync(tf, `${JSON.stringify({ message: { content: [{ type: 'text', text: `task_id=${task}` }] } })}\n`);
    return tf;
  }

  const withTask = (task: number, input: object) => ({ ...input, agent_transcript_path: spawnTranscript(task) });
  const edit = (path: string) => ({ tool_name: 'Edit', agent_type: 'swe', tool_input: { file_path: path } });
  const write = (path: string) => ({ tool_name: 'Write', agent_type: 'swe', tool_input: { file_path: path } });

  function gate(name: string, cwd: string, input: object, extra: NodeJS.ProcessEnv = {}): string {
    const r = runGate(name, { cwd, input: JSON.stringify(input), env: env(cwd, extra) });
    return r.stdout + r.stderr;
  }

  /** The swe of the task whose branch slug is the worktree's name (none for an unknown slug), its shell in that worktree. */
  function runHook(worktree: string, input: object): string {
    const slug = worktree.slice(worktree.lastIndexOf('/') + 1);
    const d = new DatabaseSync(db);
    let task: number | undefined;
    try {
      const row = d.prepare("SELECT id FROM tasks WHERE substr(branch_id, instr(branch_id, '/') + 1) = ? LIMIT 1").get(slug) as { id: number } | undefined;
      task = row?.id;
    } finally {
      d.close();
    }
    return gate('swe-scope-fence', worktree, task === undefined ? input : withTask(task, input));
  }

  function allows(task: string, rel: string): string {
    const fence = new ScopeFence(env(sb.dir));
    fence.load(db, task);
    return fence.allows(rel) ? 'yes' : 'no';
  }

  before(() => {
    sb = makeSandbox('swe-scope-fence');
    db = join(sb.dir, 'trajectory.db');
    wtRoot = join(sb.dir, '.claude/worktrees');
    wtA = join(wtRoot, 'task-alpha');
    wtB = join(wtRoot, 'task-beta');
    nonWt = join(sb.dir, 'non-worktree');
    for (const d of [wtA, wtB, nonWt, ...['no-such-task', 'task-nofiles', 'task-rootfile', 'task-trailingslash'].map((s) => join(wtRoot, s))]) {
      mkdirSync(d, { recursive: true });
    }
    const d = new DatabaseSync(db);
    try {
      d.exec(`
        CREATE TABLE issues (
          id INTEGER PRIMARY KEY,
          objective TEXT NOT NULL DEFAULT 'test',
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'open',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY,
          issue_id INTEGER NOT NULL REFERENCES issues(id),
          branch_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          spec_body TEXT NOT NULL DEFAULT '',
          prompt_bearing INTEGER NOT NULL DEFAULT 0,
          files TEXT NOT NULL DEFAULT '[]'
        );
        INSERT INTO issues VALUES (1, 'test', '', 'open', datetime('now'), datetime('now'));
        ALTER TABLE tasks ADD COLUMN repo TEXT;
        CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT);
      `);
      const task = d.prepare("INSERT INTO tasks VALUES (?, 1, ?, 'running', '', 0, ?, NULL)");
      task.run(1, 'feat/task-alpha', '["scripts/hooks/","tests/l3-integration/hooks/my-hook.test.sh"]');
      task.run(2, 'feat/task-beta', '["src/api/","src/lib/util.ts","tests/unit/handler.test.ts"]');
      task.run(3, 'feat/task-nofiles', '[]');
      task.run(5, 'feat/task-rootfile', '["Makefile"]');
      task.run(6, 'feat/task-trailingslash', '["tests/"]');
      task.run(7, 'feat/allows-file', '["src/a/b.ts"]');
      task.run(8, 'feat/allows-dir', '["src/a"]');
      task.run(9, 'feat/allows-tests', '["tests/l1/x.sh"]');
      d.prepare("INSERT INTO repos VALUES ('proj', ?)").run(sb.dir);
    } finally {
      d.close();
    }
  });
  after(() => sb.remove());

  it('in-scope: file directly in a listed dir is silent', () => {
    const out = runHook(wtA, edit('scripts/hooks/my-hook.ts'));
    hasNot(out, DENY, 'in-scope edit is allowed');
    hasNot(out, 'outside this task', 'in-scope edit carries no note');
  });

  it('in-scope: file nested under a listed dir is silent', () => {
    hasNot(runHook(wtA, edit('scripts/hooks/subdir/helper.sh')), 'outside this task', 'nested file under a listed dir carries no note');
  });

  it('in-scope: Write tool (not just Edit) is silent', () => {
    hasNot(runHook(wtA, write('scripts/hooks/new-file.ts')), 'outside this task', 'Write in scope carries no note');
  });

  it('tests/: a tests/ sibling is in scope when files[] lists a tests/ path', () => {
    hasNot(runHook(wtA, edit('tests/l3-integration/hooks/other.test.sh')), 'outside this task', 'tests/ sibling carries no note');
  });

  it('out-of-scope: Edit to an unrelated dir is allowed with a note', () => {
    const out = runHook(wtA, edit('src/api/handler.ts'));
    hasNot(out, DENY, 'out-of-scope edit is allowed');
    has(out, 'additionalContext', 'the note is additionalContext');
    has(
      out,
      "src/api/handler.ts is outside this task's files[] (scripts/hooks, tests/l3-integration/hooks/my-hook.test.sh); list it and why in your report",
      'the note names the path and the listed dirs',
    );
  });

  it('out-of-scope: the same path again is silent', () => {
    hasNot(runHook(wtA, edit('src/api/handler.ts')), 'outside this task', 'a path is noted once per task');
    hasNot(runHook(wtA, write(join(wtA, 'src/api/handler.ts'))), 'outside this task', 'the absolute form of the same path is the same path');
  });

  it('out-of-scope: another task notes the same path afresh', () => {
    has(runHook(wtB, edit('scripts/hooks/something.ts')), "scripts/hooks/something.ts is outside this task's files[]", 'first write of this path for task beta');
    has(runHook(wtA, edit('docs/README.md')), "docs/README.md is outside this task's files[]", 'a new path for task alpha is noted');
    assert.equal(
      existsSync(join(sb.dir, 'locks/scope-notes/1')) && existsSync(join(sb.dir, 'locks/scope-notes/2')) ? 'yes' : '',
      'yes',
      "markers live per task under the state dir's locks/",
    );
  });

  it('subtree: ScopeFence.allows matches pathInFiles', () => {
    assert.equal(allows('7', 'src/a/c.ts'), 'no', 'a file entry does not cover its sibling');
    assert.equal(allows('7', 'src/a/b.ts'), 'yes', 'a file entry covers itself');
    assert.equal(allows('8', 'src/a/x/y.ts'), 'yes', 'a dir entry covers its subtree');
    assert.equal(allows('9', 'tests/z.sh'), 'yes', 'any tests/ entry covers all of tests/');
  });

  it('subtree: a listed dir covers its files, a listed file never its sibling', () => {
    hasNot(runHook(wtB, edit('src/api/other.ts')), 'outside this task', 'a file under a listed dir carries no note');
    has(runHook(wtB, edit('src/lib/other.ts')), "src/lib/other.ts is outside this task's files[]", 'a sibling of a listed file is noted');
  });

  it('root-file: the exact root file is in scope, another root file is noted', () => {
    const wt = join(wtRoot, 'task-rootfile');
    hasNot(runHook(wt, edit('Makefile')), 'outside this task', 'the listed root file carries no note');
    has(runHook(wt, edit('package.json')), "package.json is outside this task's files[] (Makefile)", 'another root file is noted');
  });

  it("trailing-slash: token 'tests/' covers tests/, notes the rest", () => {
    const wt = join(wtRoot, 'task-trailingslash');
    hasNot(runHook(wt, edit('tests/l3-integration/hooks/x.test.sh')), 'outside this task', 'tests/ is in scope');
    has(runHook(wt, edit('src/api/handler.ts')), "src/api/handler.ts is outside this task's files[] (tests)", 'a path outside tests/ is noted');
  });

  it('no-task: unknown worktree slug is silent', () => {
    assert.equal(runHook(join(wtRoot, 'no-such-task'), edit('anything/file.ts')), '', 'no output without a task row');
  });

  it('empty-files: task with empty typed files[] is silent', () => {
    assert.equal(runHook(join(wtRoot, 'task-nofiles'), edit('anything/file.ts')), '', 'no output without files[]');
  });

  it('non-worktree: a relative target joins the cwd; outside the worktree is silent', () => {
    assert.equal(gate('swe-scope-fence', nonWt, withTask(1, edit('anything/file.ts'))), '', 'outside the worktree, no note');
  });

  it('GH 1550: no spawn transcript is silent, whatever the cwd', () => {
    assert.equal(gate('swe-scope-fence', wtA, edit(join(wtA, 'lib/unidentified.ts'))), '', 'a cwd inside a worktree is not identity');
  });

  it('identity-derived: absolute out-of-scope target, shell outside any worktree (#597)', () => {
    has(gate('swe-scope-fence', nonWt, withTask(1, edit(join(wtA, 'lib/x.ts')))), "lib/x.ts is outside this task's files[]", 'the worktree comes from the task');
  });

  it('non-edit-tool: Bash is ignored (swe-boundary.sh notes Bash writes)', () => {
    const bash = { tool_name: 'Bash', agent_type: 'swe', tool_input: { command: 'echo x > elsewhere/y.ts' } };
    assert.equal(runHook(wtA, bash), '', 'Bash produces no output here');
  });

  it('GH 1279: a path a heredoc program writes outside files[] is noted once (swe-boundary.sh, same classifier)', () => {
    const command = ["python3 - <<'EOF'", "open('src/heredoc_out.py', 'w').write('x')", 'EOF'].join('\n');
    const input = withTask(1, { tool_name: 'Bash', agent_type: 'swe', tool_input: { command } });
    let out = gate('swe-boundary', wtA, input);
    hasNot(out, DENY, 'the note never denies');
    has(out, "src/heredoc_out.py is outside this task's files[] (scripts/hooks, tests/l3-integration/hooks/my-hook.test.sh)", 'the extracted path is noted');
    out = gate('swe-boundary', wtA, input);
    hasNot(out, 'outside this task', 'noted once per path');
  });

  it('DB read error: silent, never a deny', () => {
    const out = gate('swe-scope-fence', wtA, withTask(1, edit('src/db-error.ts')), { TRAJECTORY_DB_PATH: join(sb.dir, 'not-a-db/trajectory.db') });
    hasNot(out, DENY, 'a DB error never denies');
  });

  it('source: the hook carries no deny', () => {
    const code = readFileSync(HOOK_SRC, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(#|\/\/|\*|\/\*)/.test(l))
      .join('\n');
    hasNot(code, 'permissionDecision', 'the swe-scope-fence source never decides');
    hasNot(code, 'tmb_deny_db_unavailable', 'the swe-scope-fence source never fails closed');
    hasNot(code, 'denyDbUnavailable', 'the swe-scope-fence source never fails closed');
  });
});
