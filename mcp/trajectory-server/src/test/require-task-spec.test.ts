/**
 * require-task-spec (GH 1692), the cases hooks-spawn-gates-parity.suite.ts's
 * corpus does not hold: status and live-run edges, the first task_id winning,
 * an absent DB, the WAL reads, the spec-shape contract (Writer:/Populated:/
 * Nullable:, its whitespace- and case-proof trigger, the waiver call and its
 * rows), the linked-worktree check, a relative repos.path under a DB whose
 * project is not CLAUDE_PROJECT_DIR, and the waiver rows the server's
 * task_create_batch and audit_append write. Each case runs
 * `node dist/hooks.js require-task-spec` in a sandbox with its own HOME.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { makeSandbox, PLUGIN_ROOT, runGate, type Sandbox } from './hook-sandbox.js';
import { REAL_SQLITE3, walDetach, walGateCases } from './wal-gate-cases.js';

const GATE = 'require-task-spec';
const DIST = dirname(dirname(fileURLToPath(import.meta.url)));
const DENY = '"permissionDecision":"deny"';
const BOTH = 'missing a Writer: and Populated: line';

const FIXTURE = `
  CREATE TABLE tasks (id INTEGER PRIMARY KEY, status TEXT NOT NULL, spec_body TEXT, files TEXT, issue_id INTEGER, branch_id TEXT);
  CREATE TABLE issues (id INTEGER PRIMARY KEY, repo TEXT);
  CREATE TABLE audit (id INTEGER PRIMARY KEY, issue_id INTEGER, branch_id TEXT, from_node TEXT, event_type TEXT, summary TEXT, content_json TEXT, repo TEXT, created_at TEXT);
  INSERT INTO issues VALUES (1, 'plugin');
  CREATE TABLE agent_runs (id INTEGER PRIMARY KEY, task_id INTEGER, agent_type TEXT NOT NULL, started_at TEXT, completed_at TEXT, spawn_id TEXT);
  INSERT INTO tasks (id, status, spec_body) VALUES (1, 'pending',     'Do the thing.');
  INSERT INTO tasks (id, status, spec_body) VALUES (2, 'pending',     '');
  INSERT INTO tasks (id, status, spec_body) VALUES (3, 'running',     'Reopened, no live swe.');
  INSERT INTO tasks (id, status, spec_body) VALUES (4, 'completed',   'Already done.');
  INSERT INTO tasks (id, status, spec_body) VALUES (5, 'in_progress', 'Mid-flight.');
  INSERT INTO tasks (id, status, spec_body) VALUES (6, 'running',     'swe still working.');
  INSERT INTO tasks (id, status, spec_body) VALUES (7, 'closed',      'Closed.');
  INSERT INTO tasks (id, status, spec_body) VALUES (8, 'running',     'Spawn recorded, never started.');
  INSERT INTO tasks (id, status, spec_body) VALUES (9, 'running',     'Spawn recorded just now.');
  INSERT INTO agent_runs VALUES (10, 3, 'swe', '2026-10-01T00:00:00.000Z', '2026-10-01T01:00:00.000Z', 'agent-10');
  INSERT INTO agent_runs VALUES (11, 3, 'bro', '2026-10-01T00:00:00.000Z', NULL, NULL);
  INSERT INTO agent_runs VALUES (12, 6, 'swe', '2026-10-11T09:00:00.000Z', NULL, 'agent-12');
  INSERT INTO agent_runs VALUES (13, 8, 'swe', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 minutes'), NULL, 'tool_use:toolu_13');
  INSERT INTO agent_runs VALUES (14, 9, 'swe', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minutes'), NULL, 'tool_use:toolu_14');
  INSERT INTO tasks VALUES (20, 'pending', '## Success Criteria
- the column exists', '["mcp/trajectory-server/src/schema.sql","mcp/trajectory-server/src/db.ts"]', 1, 'feat/col');
  INSERT INTO tasks VALUES (21, 'pending', '## Success Criteria
- \`Writer: task_update_status\`
- \`Populated: node --experimental-sqlite mcp/trajectory-server/dist/cli.js assert-sql db.copy "SELECT count(*) FROM tasks WHERE x IS NOT NULL" 1 --op ge\`', '["migrations/031.sql"]', 1, 'feat/col2');
  INSERT INTO tasks VALUES (22, 'pending', '## Success Criteria
Nullable: only set for legacy rows', '["mcp/trajectory-server/src/schema.sql"]', 1, 'feat/col3');
  INSERT INTO tasks VALUES (23, 'pending', '## Success Criteria
- the column exists', '["src/schema.sql"]', 1, 'feat/col4');
  INSERT INTO tasks VALUES (24, 'pending', '## Success Criteria
- README typo fixed', '["README.md","scripts/"]', 1, 'docs/typo');
  INSERT INTO tasks VALUES (25, 'pending', 'Add a new column ended_at.
## Success Criteria
Writer: bro_atomic_close', '["src/handlers.ts"]', 1, 'feat/col5');
  INSERT INTO tasks VALUES (26, 'pending', 'Touch the loader.', '["mcp/trajectory-server/src/DB.ts"]', 1, 'feat/dodge1');
  INSERT INTO tasks VALUES (27, 'pending', 'ADD  COLUMN ended_at to tasks.', '["src/handlers.ts"]', 1, 'feat/dodge2');
  INSERT INTO tasks VALUES (28, 'pending', 'ADD' || char(10) || 'COLUMN ended_at to tasks.', '["src/handlers.ts"]', 1, 'feat/dodge3');
  INSERT INTO tasks VALUES (29, 'pending', 'Add a new' || char(9) || 'field to the result.', '["src/handlers.ts"]', 1, 'feat/dodge4');
  INSERT INTO tasks VALUES (30, 'pending', 'Add a new-column for metering.', '["src/handlers.ts"]', 1, 'feat/dodge5');
  INSERT INTO tasks VALUES (31, 'pending', 'Ship it.', '["db/Migrations/040.sql"]', 1, 'feat/dodge6');
  INSERT INTO tasks VALUES (36, 'pending', 'ADD' || char(160) || 'COLUMN ended_at to tasks.', '["src/handlers.ts"]', 1, 'feat/dodge7');
  INSERT INTO tasks VALUES (37, 'pending', 'Add a new' || char(8239) || 'field and a new' || char(12288) || 'tool.', '["src/handlers.ts"]', 1, 'feat/dodge8');
  INSERT INTO tasks VALUES (32, 'pending', '## Success Criteria
1. Writer: task_update_status
2. Populated: node --experimental-sqlite mcp/trajectory-server/dist/cli.js assert-sql db.copy "SELECT count(*) FROM tasks" 1 --op ge', '["src/schema.sql"]', 1, 'feat/num');
  INSERT INTO tasks VALUES (33, 'pending', '## Success Criteria
- Writer: task_update_status
- Populated: node --experimental-sqlite mcp/trajectory-server/dist/cli.js assert-sql db.copy "SELECT count(*) FROM tasks" 1 --op ge', '["src/schema.sql"]', 1, 'feat/bullet');
  INSERT INTO tasks VALUES (34, 'pending', '## Success Criteria
- Writer:
- Populated: node --experimental-sqlite mcp/trajectory-server/dist/cli.js assert-sql db.copy "SELECT count(*) FROM tasks" 1 --op ge', '["src/schema.sql"]', 1, 'feat/empty');
  INSERT INTO tasks VALUES (35, 'pending', '## Success Criteria
- \`Writer: \`
- Nullable:', '["src/schema.sql"]', 1, 'feat/empty2');
  INSERT INTO tasks VALUES (60, 'pending', 'Ship it.', '["prisma/schema.prisma"]', 1, 'feat/shape60');
  INSERT INTO tasks VALUES (61, 'pending', 'Ship it.', '["db/migrate/20240101_x.rb"]', 1, 'feat/shape61');
  INSERT INTO tasks VALUES (62, 'pending', 'Ship it.', '["sql/seed.sql"]', 1, 'feat/shape62');
  INSERT INTO tasks VALUES (63, 'pending', 'Ship it.', '["src/db.ts"]', 1, 'feat/shape63');
  INSERT INTO tasks VALUES (64, 'pending', 'Ship it.', '["docs/migrations-guide.md"]', 1, 'feat/shape64');
  INSERT INTO tasks VALUES (65, 'pending', 'Ship it.', '["app/schematics/x.ts"]', 1, 'feat/shape65');
  INSERT INTO tasks VALUES (66, 'pending', 'Ship it.', '["src/mydb.ts"]', 1, 'feat/shape66');
`;

const SERVER_WRITERS = `
const dist = process.env.DIST;
const { TrajectoryDB } = await import(\`\${dist}/db.js\`);
const { taskTools } = await import(\`\${dist}/tools/tasks.js\`);
const { auditTools } = await import(\`\${dist}/tools/audit.js\`);
const { resetEmbeddingModelForTests } = await import(\`\${dist}/embeddings/model.js\`);
resetEmbeddingModelForTests(() => new Promise(() => {}));
const db = new TrajectoryDB(process.env.TRAJECTORY_DB_PATH);
db.run("INSERT INTO issues (objective, status, created_at, updated_at) VALUES (?, ?, ?, ?)", ["spec waiver", "open", new Date().toISOString(), new Date().toISOString()]);
const issueId = db.get("SELECT MAX(id) AS id FROM issues").id;
const spec = "Add a new column ended_at to tasks.\\n## Success Criteria\\n- SC1: the column exists";
const gates = {
  waive_scope_gate: true, waive_scope_gate_reason: "not under test here",
  waive_branch_gate: true, waive_branch_gate_reason: "not under test here",
  waive_intent_gate: true, waive_intent_gate_reason: "not under test here",
  waive_decision_gate: true, waive_decision_gate_reason: "not under test here",
  waive_registry_gate: true, waive_registry_gate_reason: "not under test here",
};
const batch = async (extra, branches) => {
  const r = await taskTools(db).handlers.task_create_batch({
    agent: "bro", issue_id: String(issueId), ...gates, ...extra,
    tasks: branches.map((b) => ({ branch_id: b, description: b, spec_body: spec })),
  });
  if (r.isError) throw new Error(r.content[0].text);
  const out = JSON.parse(r.content[0].text);
  return (out.tasks ?? out).map((t) => t.id);
};
const waived = await batch({ waive_spec_shape: true, waive_spec_shape_reason: "column lands with its writer in the next task" }, ["feat/w-a", "feat/w-b"]);
const [plain, manual] = await batch({}, ["feat/plain", "feat/manual"]);
const a = await auditTools(db).handlers.audit_append({
  agent: "bro", issue_id: issueId, branch_id: "feat/manual", from_node: "bro",
  event_type: "spec_shape_gate_waived", summary: "manual waiver",
  content_json: JSON.stringify({ task_id: manual, gate: "spec_shape", reason: "column lands with its writer in the next task" }),
});
if (a.isError) throw new Error(a.content[0].text);
db.close();
console.log([...waived, plain, manual].join(" "));
process.exit(0);
`;

const swe = (prompt: string) => JSON.stringify({ tool_input: { subagent_type: 'swe', prompt } });

function sql(db: string, text: string): void {
  const d = new DatabaseSync(db);
  try {
    d.exec(text);
  } finally {
    d.close();
  }
}

function scalar(db: string, text: string): string {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return String(Object.values(d.prepare(text).get() as Record<string, unknown>)[0]);
  } finally {
    d.close();
  }
}

describe('require-task-spec: swe spawns need a pending or idle running task with a spec', () => {
  let sb: Sandbox;
  let project: string;
  let db: string;

  before(() => {
    sb = makeSandbox(GATE);
    project = join(sb.dir, 'project');
    mkdirSync(project);
    db = join(sb.dir, 'trajectory.db');
    sql(db, FIXTURE);
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { env: sb.env, encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    };
    const makeRepo = (dir: string) => {
      git('init', '-q', '-b', 'main', dir);
      git('-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t.t', 'commit', '-q', '--allow-empty', '-m', 'base');
    };
    const gitapp = join(sb.dir, 'gitapp');
    makeRepo(gitapp);
    git('-C', gitapp, 'branch', 'fix/has-wt');
    git('-C', gitapp, 'branch', 'fix/no-wt');
    git('-C', gitapp, 'worktree', 'add', '-q', join(gitapp, '.claude/worktrees/has-wt'), 'fix/has-wt');
    const mainapp = join(sb.dir, 'mainapp');
    makeRepo(mainapp);
    git('-C', mainapp, 'checkout', '-q', '-b', 'fix/on-main');
    sql(
      db,
      `ALTER TABLE tasks ADD COLUMN repo TEXT;
      CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL);
      INSERT INTO repos VALUES ('gitapp', '${gitapp}');
      INSERT INTO repos VALUES ('mainapp', '${mainapp}');
      INSERT INTO tasks (id, status, spec_body, branch_id, repo) VALUES (70, 'pending', 'Do the thing.', 'fix/no-wt', 'gitapp');
      INSERT INTO tasks (id, status, spec_body, branch_id, repo) VALUES (71, 'pending', 'Do the thing.', 'fix/has-wt', 'gitapp');
      INSERT INTO tasks (id, status, spec_body, branch_id, repo) VALUES (72, 'pending', 'Do the thing.', 'fix/on-main', 'mainapp');
      INSERT INTO tasks (id, status, spec_body, branch_id, repo) VALUES (74, 'running', 'Do the thing.', 'fix/no-wt', 'gitapp');
      INSERT INTO tasks (id, status, spec_body, branch_id, repo) VALUES (76, 'running', 'Do the thing.', 'fix/has-wt', 'gitapp');`,
    );
    makeRepo(join(sb.dir, 'ws/relapp'));
  });

  after(() => sb.remove());

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...sb.env, CLAUDE_PROJECT_DIR: project, TRAJECTORY_DB_PATH: db, ...extra });
  const run = (prompt: string, extra: NodeJS.ProcessEnv = {}) => {
    const r = runGate(GATE, { cwd: sb.dir, input: swe(prompt), env: env(extra) });
    return r.stdout + r.stderr;
  };
  const denied = (out: string, phrase: string) => {
    assert.ok(out.includes(DENY), `permissionDecision deny: ${out}`);
    assert.ok(out.includes(phrase), `reason holds ${JSON.stringify(phrase)}: ${out}`);
  };

  it('an in_progress task is blocked, naming the status', () => denied(run('task_id=5 please do the thing'), 'status=in_progress'));

  it('a completed task is blocked, naming the status', () => denied(run('task_id=4 please do the thing'), 'status=completed'));

  it('a running task with no open swe run passes silently', () => assert.equal(run('task_id=3 please do the thing'), ''));

  it('a running task whose live swe run is bound is blocked, naming the run', () =>
    denied(run('task_id=6 please do the thing'), 'live swe run: agent_runs 12'));

  it('a running task whose only open run is unbound and older than 90 s passes silently', () =>
    assert.equal(run('task_id=8 please do the thing'), '', 'a spawn that never started does not block a respawn'));

  it('a running task with a fresh unbound spawn row is blocked', () =>
    assert.ok(run('task_id=9 please do the thing').includes('live swe run: agent_runs 14'), 'a just-recorded spawn is live'));

  it("the gate carries no 'open' task-status literal", () => {
    const source = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/hooks/require-task-spec.ts'), 'utf8');
    assert.doesNotMatch(source, /["']open["']/);
  });

  it('with several task_id tokens the first wins', () => assert.equal(run('task_id=1 and also task_id=4'), '', 'first token is valid'));

  it('a TRAJECTORY_DB_PATH with no file (project not onboarded) allows the spawn', () =>
    assert.equal(run('task_id=1', { TRAJECTORY_DB_PATH: join(sb.dir, 'nonexistent.db') }), ''));

  describe('WAL reads through the sqlite3 CLI', { skip: REAL_SQLITE3 === '' && 'needs the sqlite3 CLI' }, () => {
    let walDb: string;
    let walProj: string;
    before(() => {
      walProj = join(sb.dir, 'wal-project');
      walDb = join(walProj, '.claude/tmb/trajectory.db');
      mkdirSync(dirname(walDb), { recursive: true });
      sql(db, `VACUUM INTO '${walDb}'`);
    });
    walGateCases({
      label: GATE,
      gate: GATE,
      get db() {
        return walDb;
      },
      get proj() {
        return walProj;
      },
      input: swe('task_id=2 please do the thing'),
      expect: 'has empty spec_body',
      forbid: 'does not exist in the tasks table',
      get cwd() {
        return sb.dir;
      },
      env: () => env(),
      work: () => join(sb.dir, 'wal-work'),
    });
  });

  describe('the spec-shape contract', () => {
    it('a schema-touching task without Writer:/Populated: is blocked, naming both lines', () => denied(run('task_id=20 please do the thing'), BOTH));

    it('a schema-touching task with Writer: and Populated: passes silently', () => assert.equal(run('task_id=21 please do the thing'), ''));

    it('a schema-touching task with a Nullable: line passes silently', () => assert.equal(run('task_id=22 please do the thing'), ''));

    it('a spec_body adding a new column with Writer: only is blocked, naming Populated:', () =>
      denied(run('task_id=25 please do the thing'), 'missing a Populated: line'));

    for (const [id, what] of [
      [26, 'files[] names DB.ts'],
      [27, 'ADD  COLUMN'],
      [28, 'ADD<newline>COLUMN'],
      [29, 'new<tab>field'],
      [30, 'new-column'],
      [31, 'files[] names Migrations/'],
      [36, 'ADD<nbsp>COLUMN'],
      [37, 'new<narrow nbsp>field'],
    ] as const) {
      it(`the trigger is whitespace- and case-proof: ${what} without the lines is blocked`, () => denied(run(`task_id=${id} please do the thing`), BOTH));
    }

    it('numbered-list Writer:/Populated: lines pass silently', () => assert.equal(run('task_id=32 please do the thing'), ''));

    it('bulleted Writer:/Populated: lines pass silently', () => assert.equal(run('task_id=33 please do the thing'), ''));

    it('an empty Writer: value does not count', () => denied(run('task_id=34 please do the thing'), 'missing a Writer: line'));

    it('an empty Nullable: value and a backticked empty Writer: do not count', () => denied(run('task_id=35 please do the thing'), BOTH));

    it('the deny tells bro the audit_append waiver call for this task', () => {
      const out = run('task_id=23 please do the thing');
      denied(out, 'audit_append(event_type=\\"spec_shape_gate_waived\\"');
      assert.ok(out.includes('issue_id=1, branch_id=\\"feat/col4\\"'), "reason names the task's issue and branch");
      assert.ok(out.includes('\\"task_id\\":23,\\"gate\\":\\"spec_shape\\"'), 'reason names the content_json keys');
    });

    it('a waiver row for another task, another gate or a short reason does not allow', () => {
      sql(
        db,
        `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json) VALUES
          (1, 'bro', 'spec_shape_gate_waived', 'other task', '{"task_id":20,"gate":"spec_shape","reason":"column dropped next task"}'),
          (1, 'bro', 'spec_shape_gate_waived', 'batch waiver', '{"task_id":23,"reason":"column dropped next task"}'),
          (1, 'bro', 'spec_shape_gate_waived', 'short', '{"task_id":23,"gate":"spec_shape","reason":"short"}');`,
      );
      assert.ok(run('task_id=23 please do the thing').includes(DENY));
    });

    it('an otherwise valid waiver row written by code-reviewer does not allow', () => {
      sql(
        db,
        `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json) VALUES
          (1, 'feat/col4', 'code-reviewer', 'spec_shape_gate_waived', 'waive', '{"task_id":"23","gate":"spec_shape","reason":"column is dropped again in the next task"}');`,
      );
      assert.ok(run('task_id=23 please do the thing').includes(DENY));
    });

    it('a bro-recorded spec_shape_gate_waived row for the task allows, and the hook writes nothing', () => {
      sql(
        db,
        `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json) VALUES
          (1, 'feat/col4', 'bro', 'spec_shape_gate_waived', 'waive', '{"task_id":"23","gate":"spec_shape","reason":"column is dropped again in the next task"}');`,
      );
      const beforeCount = scalar(db, 'SELECT count(*) FROM audit');
      assert.equal(run('task_id=23 please do the thing'), '', 'waived spawn passes silently');
      assert.equal(scalar(db, 'SELECT count(*) FROM audit'), beforeCount, 'no audit row written by the hook');
    });

    it('a non-schema task without the lines passes silently', () => assert.equal(run('task_id=24 please do the thing'), ''));

    for (const id of [60, 61, 62, 63]) {
      it(`generic schema shape task ${id} without Writer:/Populated: is blocked`, () => assert.ok(run(`task_id=${id} please do the thing`).includes(DENY)));
    }

    for (const id of [64, 65, 66]) {
      it(`non-schema lookalike path task ${id} passes silently`, () => assert.equal(run(`task_id=${id} please do the thing`), ''));
    }
  });

  describe('the linked-worktree check', () => {
    it('a pending task in a git repo with no linked worktree is blocked with the task_reopen next step', () => {
      const out = run('task_id=70 please do the thing');
      denied(out, 'task_reopen(task_id=70');
      assert.ok(out.includes('fix/no-wt'), 'reason names the branch');
      assert.ok(out.includes(join(sb.dir, 'gitapp/.claude/worktrees/no-wt')), 'reason names the expected worktree path');
      assert.ok(!out.includes('switch the main checkout'), 'no main-checkout advice');
    });

    it('a pending task whose branch is checked out in a linked worktree passes silently', () => assert.equal(run('task_id=71 please do the thing'), ''));

    it('a pending task whose branch is checked out in the main checkout is blocked with switch-back advice', () => {
      const out = run('task_id=72 please do the thing');
      denied(out, 'switch the main checkout back');
      assert.ok(out.includes('task_reopen(task_id=72'), 'reason spells the task_reopen call');
    });

    it('a running task in a git repo with no linked worktree is blocked with the task_reopen next step (GH 2866)', () => {
      const out = run('task_id=74 please do the thing');
      denied(out, 'task_id=74 is running and branch fix/no-wt has no linked worktree');
      assert.ok(out.includes('task_reopen(task_id=74, reason='), 'reason spells the task_reopen call');
    });

    it('a running task whose branch is checked out in a linked worktree passes silently', () => assert.equal(run('task_id=76 please do the thing'), ''));

    it("GH 1553: a relative repos.path resolves against the DB's project root, not CLAUDE_PROJECT_DIR or the DB's dir", () => {
      const wsDb = join(sb.dir, 'ws/.claude/tmb/trajectory.db');
      mkdirSync(dirname(wsDb), { recursive: true });
      sql(db, `VACUUM INTO '${wsDb}'`);
      sql(
        wsDb,
        `INSERT INTO repos VALUES ('relapp', 'relapp');
        INSERT INTO tasks (id, status, spec_body, branch_id, repo) VALUES (75, 'pending', 'Do the thing.', 'fix/rel-no-wt', 'relapp');`,
      );
      const out = run('task_id=75 please do the thing', { TRAJECTORY_DB_PATH: wsDb });
      assert.ok(out.includes(DENY), 'the relative repo is gated as a git work tree');
      assert.ok(out.includes(join(sb.dir, 'ws/relapp/.claude/worktrees/rel-no-wt')), 'reason names the worktree under <project>/relapp');
    });
  });

  describe("the waiver rows the server's own writers record", () => {
    let serverDb: string;
    let ids: string[];
    before(() => {
      serverDb = join(sb.dir, 'server.db');
      const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', '--input-type=module', '-e', SERVER_WRITERS], {
        cwd: sb.dir,
        env: { ...env(), TRAJECTORY_DB_PATH: serverDb, DIST },
        encoding: 'utf8',
        timeout: 60_000,
      });
      assert.equal(r.status, 0, r.stderr);
      ids = r.stdout.trim().split(' ');
      assert.equal(ids.length, 4, r.stdout);
      walDetach(serverDb);
    });

    it('task_create_batch(waive_spec_shape) opens the gate for every task it created with no second write', () => {
      for (const id of ids.slice(0, 2)) {
        assert.equal(run(`task_id=${id} please do the thing`, { TRAJECTORY_DB_PATH: serverDb }), '', `task ${id} spawns without a manual audit row`);
      }
      assert.equal(
        scalar(serverDb, "SELECT count(*) FROM audit WHERE event_type = 'spec_shape_gate_waived' AND json_extract(content_json, '$.source') = 'task_create_batch'"),
        '2',
        'one row per waived task',
      );
    });

    it('a task created without the waiver and missing Writer:/Populated: is still denied', () =>
      denied(run(`task_id=${ids[2]} please do the thing`, { TRAJECTORY_DB_PATH: serverDb }), BOTH));

    it('a manual audit_append waiver row still opens the gate', () =>
      assert.equal(run(`task_id=${ids[3]} please do the thing`, { TRAJECTORY_DB_PATH: serverDb }), '', 'manual waiver passes silently'));
  });
});
