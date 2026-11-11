/**
 * The swe agent_runs identity lifecycle end to end (GH 1502, GH 1500, GH 1692):
 *   1. Spawn — the Agent spawn (agent-spawn-dispatch → record-swe-spawn) moves
 *      the pending task to running and opens one swe row carrying spawn_id
 *      tool_use:<id>, session_id and effort.
 *   2. Bind — the swe's task_brief (swe-brief-gate, then the handler) binds
 *      that row to its agent_id; repeated briefs keep one row.
 *   3. Live — a bound row is never swept_orphan, however old.
 *   4. Resume (GH 1742) — a failed stop, a resumed brief and a committed stop
 *      with a passing verification run at HEAD (GH 2866) leave the failed row
 *      and a completed row chained to it by resumed_from.
 *   5. Refused spawn (GH 1509) — an unbound row older than 90 s no longer
 *      blocks a respawn and is swept_orphan by it; PostToolUse(Agent) binds the
 *      row to tool_response.agentId; PermissionDenied(Agent) closes it and
 *      returns the task to pending; a bound row is never closed by any of them.
 * Each hook runs as `node dist/hooks.js <hook>` in a sandbox with its own HOME;
 * the cases share one DB and run in order.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { makeSandbox, PLUGIN_ROOT, runGate, type Sandbox } from './hook-sandbox.js';

const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const DIST = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist');
const NOW = '2026-06-16T19:00:00.000Z';
const PLUGIN_VERSION = (JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin/plugin.json'), 'utf8')) as { version: string }).version;
const GIT_ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.io', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.io' };
const OPEN_UNBOUND7 = "SELECT COUNT(*) FROM agent_runs WHERE agent_type='swe' AND completed_at IS NULL AND spawn_id GLOB 'tool_use:*' AND task_id=7";

describe('swe run identity: spawn, bind, live, resume and refused spawn', () => {
  let sb: Sandbox;
  let repo: string;
  let db: string;
  let env: NodeJS.ProcessEnv;
  let otherRoot: string;
  let spawnNote = '';
  let resets = 0;

  function git(dir: string, ...args: string[]): void {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...sb.env, ...GIT_ID } });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  }

  function q(sql: string): string {
    const d = new DatabaseSync(db, { enableForeignKeyConstraints: false });
    try {
      if (!/^\s*SELECT/i.test(sql)) {
        d.exec(sql);
        return '';
      }
      return (d.prepare(sql).all() as Record<string, unknown>[]).map((r) => Object.values(r).map((v) => (v === null ? '' : String(v))).join('|')).join('\n');
    } finally {
      d.close();
    }
  }

  /** An Agent tool payload for <task>; an empty <toolUseId> leaves the key out, and the spawn note ends the prompt so two otherwise identical spawns are two events. */
  function agentEvent(event: string, task: number, toolUseId: string, extra: Record<string, unknown> = {}, note = spawnNote): string {
    const p: Record<string, unknown> = {
      hook_event_name: event,
      tool_name: 'Agent',
      session_id: 'sess-main',
      tool_input: { subagent_type: 'swe', effort: 'medium', prompt: `task_id=${task} You are swe.${note}` },
    };
    if (toolUseId !== '') p.tool_use_id = toolUseId;
    return JSON.stringify({ ...p, ...extra });
  }

  const gate = (name: string, input: string, e = env) => runGate(name, { cwd: repo, input, env: e }).stdout;
  const spawn = (task: number, toolUseId: string, note = spawnNote) => gate('agent-spawn-dispatch', agentEvent('PreToolUse', task, toolUseId, {}, note));
  const bind = (task: number, toolUseId: string, agentId: string) =>
    gate('swe-spawn-bind', agentEvent('PostToolUse', task, toolUseId, { tool_response: { status: 'async_launched', agentId } }));
  const refuse = (task: number, toolUseId: string) => gate('swe-spawn-rollback', agentEvent('PermissionDenied', task, toolUseId, { reason: 'auto mode refused' }));

  function brief(task: number, agentId: string, toolUseId: string): string {
    gate(
      'swe-brief-gate',
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__plugin_tmb_trajectory-server__task_brief',
        tool_use_id: toolUseId,
        agent_type: 'tmb:swe',
        agent_id: agentId,
        session_id: 'sess-main',
        tool_input: { agent: 'swe', task_id: task },
      }),
    );
    const script = `
      const [, dist, dbPath, task] = process.argv;
      const { TrajectoryDB } = await import(dist + '/db.js');
      const { compositeTools } = await import(dist + '/tools/composites.js');
      const db = new TrajectoryDB(dbPath);
      const res = await compositeTools(db, dbPath, null).handlers.task_brief({ agent: 'swe', task_id: Number(task) });
      db.close();
      process.stdout.write(res.isError ? 'error' : 'ok');
    `;
    const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', '--input-type=module', '-e', script, DIST, db, String(task)], {
      cwd: repo,
      encoding: 'utf8',
      env,
    });
    return r.stdout;
  }

  function stop(task: number, agentId: string, e = env): void {
    const tp = join(sb.dir, `transcript-${task}.jsonl`);
    writeFileSync(
      tp,
      [
        { type: 'user', timestamp: '2026-06-16T19:30:00.000Z', message: { role: 'user', content: `task_id=${task} You are swe.` } },
        { type: 'assistant', timestamp: '2026-06-16T19:30:04.000Z', message: { id: 'm1', usage: { input_tokens: 40, output_tokens: 4 }, content: [] } },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n',
    );
    gate(
      'swe-atomic-close',
      JSON.stringify({ agent_type: 'tmb:swe', agent_id: agentId, session_id: 'sess-main', agent_transcript_path: tp, hook_event_name: 'SubagentStop' }),
      e,
    );
  }

  /** Task 7 pending with no runs; each fixture's payloads carry their own spawn note, so the dispatcher never dedupes them against the previous fixture's. */
  function reset7(): void {
    q("DELETE FROM agent_runs WHERE task_id=7; UPDATE tasks SET status='pending' WHERE id=7;");
    resets += 1;
    spawnNote = ` fixture ${resets}`;
  }
  const backdate = (spawnId: string, seconds: number) =>
    q(`UPDATE agent_runs SET started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${seconds} seconds') WHERE spawn_id = '${spawnId}';`);

  before(() => {
    sb = makeSandbox('swe-run-identity');
    repo = join(sb.dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'dev');
    writeFileSync(join(repo, 'README.md'), 'init\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    db = join(repo, '.claude/tmb/trajectory.db');
    mkdirSync(join(repo, '.claude/tmb'), { recursive: true });
    q(SCHEMA);
    q(`INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'run identity', 'open', '${NOW}', '${NOW}');
       INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, spec_body, effort, created_at, updated_at) VALUES
         (7, 1, 'fix/7-identity', 'dev', 'd', 'pending', '## spec', 'medium', '${NOW}', '${NOW}'),
         (8, 1, 'fix/8-resume',   'dev', 'd', 'pending', '## spec', 'medium', '${NOW}', '${NOW}');`);
    env = { ...sb.env, TRAJECTORY_DB_PATH: db, CLAUDE_PROJECT_DIR: repo, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT };
    otherRoot = join(sb.dir, 'other-plugin');
    mkdirSync(join(otherRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(join(otherRoot, '.claude-plugin/plugin.json'), '{"name":"tmb","version":"0.0.1-other"}\n');
    for (const slug of ['7-identity', '8-resume']) {
      git(repo, 'branch', `fix/${slug}`, 'HEAD');
      git(repo, 'worktree', 'add', '-q', join(repo, '.claude/worktrees', slug), `fix/${slug}`);
    }
  });

  after(() => sb.remove());

  it('(a) an Agent spawn moves task 7 to running and opens one identified swe row', () => {
    spawn(7, 'toolu_spawn7');
    assert.equal(q('SELECT status FROM tasks WHERE id=7'), 'running', 'task 7 running');
    assert.equal(q("SELECT COUNT(*) FROM agent_runs WHERE task_id=7 AND agent_type='swe'"), '1', 'one swe row');
    assert.equal(q('SELECT spawn_id, session_id, effort, host FROM agent_runs WHERE task_id=7'), 'tool_use:toolu_spawn7|sess-main|medium|claude', 'spawn_id, session_id and effort set at spawn');
    assert.equal(q('SELECT root_dir FROM agent_runs WHERE task_id=7'), join(repo, '.claude/worktrees/7-identity'), 'root_dir is the task worktree');
    assert.equal(q('SELECT plugin_version FROM agent_runs WHERE task_id=7'), PLUGIN_VERSION, 'record-swe-spawn writes the manifest plugin_version (GH 1884)');
  });

  it('(b) two task_brief calls from one agent_id leave one row keyed by it', () => {
    assert.equal(brief(7, 'agent-7', 'toolu_brief1'), 'ok', 'first task_brief');
    assert.equal(brief(7, 'agent-7', 'toolu_brief2'), 'ok', 'second task_brief');
    assert.equal(q("SELECT COUNT(*) FROM agent_runs WHERE task_id=7 AND agent_type='swe'"), '1', 'still one swe row');
    assert.equal(q('SELECT spawn_id, session_id, effort, completed_at FROM agent_runs WHERE task_id=7'), 'agent-7|sess-main|medium|', 'bound to the agent_id, still open');
    assert.equal(q('SELECT plugin_version FROM agent_runs WHERE task_id=7'), PLUGIN_VERSION, 'binding the row keeps its plugin_version');
  });

  it('(e) no open unbound swe row survives spawn + brief', () => {
    assert.equal(q("SELECT COUNT(*) FROM agent_runs WHERE agent_type='swe' AND completed_at IS NULL AND spawn_id IS NULL"), '0', 'zero open spawn_id NULL swe rows');
  });

  it('(c) task_brief 11 minutes later keeps the bound row open', () => {
    q("UPDATE agent_runs SET started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-11 minutes') WHERE task_id=7;");
    assert.equal(brief(7, 'agent-7', 'toolu_brief3'), 'ok', 'task_brief after 11 minutes');
    assert.equal(q('SELECT COUNT(*) FROM agent_runs WHERE task_id=7'), '1', 'no new row');
    assert.equal(q('SELECT spawn_id, exit_reason, completed_at FROM agent_runs WHERE task_id=7'), 'agent-7||', 'not swept_orphan');
  });

  it('(d) failed stop, resume, committed stop leave the failed row and a chained completed row', () => {
    spawn(8, 'toolu_spawn8');
    assert.equal(brief(8, 'agent-8', 'toolu_brief4'), 'ok', 'task_brief binds');
    stop(8, 'agent-8', { ...env, CLAUDE_PLUGIN_ROOT: otherRoot });
    assert.equal(q('SELECT plugin_version FROM agent_runs WHERE task_id=8'), PLUGIN_VERSION, 'the stop of the open row under another version keeps its plugin_version');
    assert.equal(q('SELECT status FROM tasks WHERE id=8'), 'running', 'a stop without commits leaves the task running');
    assert.equal(q('SELECT exit_reason FROM agent_runs WHERE task_id=8'), 'failed', 'the first stop records failed');
    const first8 = q('SELECT id FROM agent_runs WHERE task_id=8');
    assert.equal(brief(8, 'agent-8', 'toolu_brief5'), 'ok', "the resumed spawn's task_brief");
    assert.equal(
      q("SELECT GROUP_CONCAT(COALESCE(exit_reason, '') || '|' || COALESCE(resumed_from, ''), '|') FROM (SELECT * FROM agent_runs WHERE task_id=8 ORDER BY id)"),
      `failed|||${first8}`,
      'the first row stays failed and an open row resumes from it',
    );
    const wt = join(repo, '.claude/worktrees/8-resume');
    writeFileSync(join(wt, 'w.txt'), 'w\n');
    git(wt, 'add', 'w.txt');
    git(wt, 'commit', '-qm', 'feat: w');
    const head = spawnSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: sb.env }).stdout.trim();
    const w = new DatabaseSync(db);
    try {
      w.prepare("INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out) VALUES (8, ?, 'gate', ?, ?, 0, 600, 0)").run(head, NOW, NOW);
    } finally {
      w.close();
    }
    stop(8, 'agent-8');
    assert.equal(q('SELECT status FROM tasks WHERE id=8'), 'completed', 'the committed stop completes the task');
    assert.equal(q('SELECT COUNT(*) FROM agent_runs WHERE task_id=8'), '2', 'two rows');
    assert.equal(
      q('SELECT spawn_id, exit_reason, resumed_from FROM agent_runs WHERE task_id=8 ORDER BY id DESC LIMIT 1'),
      `agent-8|completed|${first8}`,
      "the resumed row carries the latest stop's exit_reason",
    );
    assert.equal(
      q("SELECT GROUP_CONCAT(plugin_version, '|') FROM (SELECT plugin_version FROM agent_runs WHERE task_id=8 ORDER BY id)"),
      `${PLUGIN_VERSION}|${PLUGIN_VERSION}`,
      "task_brief's resumed insert carries the server's plugin_version",
    );
    assert.equal(q("SELECT COUNT(*) FROM agent_runs WHERE task_id=8 AND exit_reason='swept_orphan'"), '0', 'zero swept_orphan rows');
  });

  it("(f) no closed task's latest bound swe row reads failed (GH 1500)", () => {
    q("UPDATE tasks SET status='closed' WHERE id=8;");
    assert.equal(
      q(
        "SELECT COUNT(*) FROM agent_runs a JOIN tasks t ON t.id=a.task_id WHERE a.agent_type='swe' AND t.status='closed' AND a.exit_reason='failed' AND a.id=(SELECT MAX(id) FROM agent_runs WHERE task_id=a.task_id AND agent_type='swe' AND spawn_id IS NOT NULL)",
      ),
      '0',
      'GH 1500 query',
    );
  });

  it("(g) a refused spawn's unbound row older than 90 s is swept_orphan by the next spawn (GH 1509)", () => {
    reset7();
    spawn(7, 'tu-1');
    assert.equal(q('SELECT status FROM tasks WHERE id=7'), 'running', 'PREPARE moved task 7 to running');
    backdate('tool_use:tu-1', 91);
    assert.ok(!spawn(7, 'tu-2').includes('"deny"'), 'the second spawn passes require-task-spec');
    assert.equal(
      q("SELECT exit_reason, completed_at IS NOT NULL, usage_source FROM agent_runs WHERE spawn_id='tool_use:tu-1'"),
      'swept_orphan|1|unmeasured',
      'tu-1 swept_orphan with completed_at set',
    );
    assert.equal(q(OPEN_UNBOUND7), '1', "one open unbound swe row: the new spawn's");
    assert.equal(q('SELECT spawn_id FROM agent_runs WHERE task_id=7 AND completed_at IS NULL'), 'tool_use:tu-2', 'record-swe-spawn opened tu-2');
  });

  it('(h) without a tool_use_id: denied inside 90 s, swept after it', () => {
    reset7();
    spawn(7, '');
    const first = q('SELECT spawn_id FROM agent_runs WHERE task_id=7');
    assert.ok(first.includes('tool_use:sess-main:'), `session fallback spawn_id: ${first}`);
    assert.ok(spawn(7, '', `${spawnNote} retry 1`).includes('live swe run'), 'a respawn inside the 90 s window is denied');
    assert.equal(q('SELECT COUNT(*) FROM agent_runs WHERE task_id=7'), '1', 'the denied respawn opened no row');
    backdate(first, 91);
    assert.ok(!spawn(7, '', `${spawnNote} retry 2`).includes('"deny"'), 'a respawn after 90 s passes');
    assert.equal(q(`SELECT exit_reason, completed_at IS NOT NULL FROM agent_runs WHERE spawn_id='${first}'`), 'swept_orphan|1', 'the first row swept_orphan');
    assert.equal(q(OPEN_UNBOUND7), '1', 'one open unbound swe row');
  });

  it("(i) PostToolUse(Agent) binds the spawn's row to tool_response.agentId", () => {
    reset7();
    spawn(7, 'tu-1');
    bind(7, 'tu-1', 'ag-1');
    assert.equal(q('SELECT spawn_id, completed_at, exit_reason FROM agent_runs WHERE task_id=7'), 'ag-1||', 'tu-1 bound to ag-1, still open');
    assert.equal(brief(7, 'ag-1', 'toolu_brief6'), 'ok', "the swe's task_brief");
    assert.equal(q('SELECT COUNT(*), MAX(spawn_id) FROM agent_runs WHERE task_id=7'), '1|ag-1', 'task_brief keeps the one bound row');
  });

  it("(j) PermissionDenied(Agent) closes the refused spawn's row and returns the task to pending", () => {
    reset7();
    spawn(7, 'tu-1');
    refuse(7, 'tu-1');
    assert.equal(q("SELECT exit_reason, completed_at IS NOT NULL, usage_source FROM agent_runs WHERE spawn_id='tool_use:tu-1'"), 'swept_orphan|1|unmeasured', 'tu-1 swept_orphan');
    assert.equal(q('SELECT status FROM tasks WHERE id=7'), 'pending', 'task 7 pending');
    spawn(7, 'tu-2');
    q("UPDATE agent_runs SET tokens_in = 12, usage_source = 'transcript' WHERE spawn_id='tool_use:tu-2';");
    refuse(7, 'tu-2');
    assert.equal(
      q("SELECT exit_reason, usage_source, tokens_in FROM agent_runs WHERE spawn_id='tool_use:tu-2'"),
      'swept_orphan|transcript|12',
      'a rolled-back row carrying usage keeps its source (GH 1673)',
    );
  });

  it('(k) a bound row an hour old is never closed by the sweep, PermissionDenied or SubagentStop', () => {
    reset7();
    q(`UPDATE tasks SET status='running' WHERE id=7;
       INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, spawn_id, host)
       VALUES (7, 1, 'swe', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours'), 'ag-1', 'claude');`);
    const bound = "SELECT COALESCE(completed_at, '') || '|' || COALESCE(exit_reason, '') FROM agent_runs WHERE spawn_id='ag-1'";
    assert.ok(spawn(7, 'tu-9').includes('live swe run'), 'require-task-spec still treats the bound row as live');
    gate('record-swe-spawn', agentEvent('PreToolUse', 7, 'tu-9'));
    assert.equal(q(bound), '|', "record-swe-spawn's sweep leaves ag-1 open");
    refuse(7, 'tu-9');
    assert.equal(q("SELECT exit_reason FROM agent_runs WHERE spawn_id='tool_use:tu-9'"), 'swept_orphan', 'PermissionDenied closes tu-9');
    assert.equal(q(bound), '|', 'PermissionDenied leaves ag-1 open');
    assert.equal(q('SELECT status FROM tasks WHERE id=7'), 'running', 'an open bound run keeps the task running');
    q(`INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, spawn_id, host) VALUES
         (7, 1, 'swe', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 minutes'), 'tool_use:tu-old', 'claude'),
         (7, 1, 'swe', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'ag-2', 'claude');`);
    stop(7, 'ag-2');
    assert.equal(q("SELECT usage_source FROM agent_runs WHERE spawn_id='ag-2'"), 'subagent_stop', 'SubagentStop metered ag-2');
    assert.equal(
      q("SELECT exit_reason, completed_at IS NOT NULL, usage_source FROM agent_runs WHERE spawn_id='tool_use:tu-old'"),
      'swept_orphan|1|unmeasured',
      'SubagentStop sweeps the unbound tool_use row older than 90 s',
    );
    assert.equal(q(bound), '|', 'SubagentStop leaves ag-1 open');
  });
});
