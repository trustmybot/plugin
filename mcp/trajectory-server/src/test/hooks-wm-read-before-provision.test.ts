/**
 * wm-read-before-provision (GH 2329, GH 2958): a task_provision call is
 * allowed silently only when the session transcript holds an assistant
 * world-model read tool_use within the last 60 minutes that covers one of
 * `task.files[]` (by the read's path, by a path in its input, or by a path in
 * its tool_result text); every other call is denied with one
 * wm_read_missing_before_provision audit row and a world_model_get call to
 * run. A repo with no wm_files rows, or a DB that does not resolve, is
 * allowed with the nudge. The gate is registered as enforcement for
 * task_provision alone in the trajectory-server group, and the router passes
 * its deny on. Each case runs `node dist/hooks.js` in a sandbox with its own
 * HOME and a temp trajectory DB.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, beforeEach, describe, it } from 'node:test';
import { isAuditEventType, auditEventWriters } from '../audit-events.js';
import { findGate, routerGates } from '../hooks/registry.js';
import {
  EVENT_TYPE,
  GATE_NAME,
  hasRecentWmRead,
  missingReason,
  normalizePath,
  readCall,
  WINDOW_MINUTES,
  wmReadBeforeProvision,
} from '../hooks/wm-read-before-provision.js';
import { jsonValues, makeSandbox, PLUGIN_ROOT, runGate, type Sandbox } from './hook-sandbox.js';

const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const NOW = '2026-11-08T10:00:00.000Z';
const MCP = 'mcp__plugin_tmb_trajectory-server__';
const FILES = ['src/world-model/freshness.ts', 'src/hooks/'];

type Output = { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string; permissionDecision?: string; permissionDecisionReason?: string } };

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

let ids = 0;
function toolUse(name: string, at: string, input: unknown = {}, type = 'assistant', id = `toolu_${++ids}`): string {
  return JSON.stringify({ type, timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
}

function toolResult(id: string, text: string, asBlocks = false): string {
  const content = asBlocks ? [{ type: 'text', text }] : text;
  return JSON.stringify({ type: 'user', timestamp: minutesAgo(1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
}

function payload(transcript: string | undefined, opts: { tool?: string; issueId?: unknown; files?: unknown; repo?: unknown } = {}): string {
  const task: Record<string, unknown> = { description: 'd' };
  if (opts.files !== undefined) task['files'] = opts.files;
  else task['files'] = FILES;
  if (opts.repo !== undefined) task['repo'] = opts.repo;
  else task['repo'] = 'app';
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'sess-2958',
    ...(transcript === undefined ? {} : { transcript_path: transcript }),
    tool_name: `${MCP}${opts.tool ?? 'task_provision'}`,
    tool_input: { agent: 'bro', issue_id: opts.issueId ?? 7, branch_id: 'feat/x', task },
  });
}

describe('wm-read-before-provision (GH 2329, GH 2958)', () => {
  let sb: Sandbox;
  let proj: string;
  let db: string;
  let seq = 0;

  const transcript = (...lines: string[]): string => {
    seq += 1;
    const path = join(sb.dir, `t-${seq}.jsonl`);
    writeFileSync(path, lines.length === 0 ? '' : `${lines.join('\n')}\n`);
    return path;
  };
  const env = (): NodeJS.ProcessEnv => ({ ...sb.env, CLAUDE_PROJECT_DIR: proj, TRAJECTORY_DB_PATH: db, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT });
  const run = (input: string) => runGate(GATE_NAME, { cwd: proj, input, env: env() });
  const rows = (): { issue_id: number; from_node: string; content_json: string }[] => {
    const d = new DatabaseSync(db);
    try {
      return d.prepare('SELECT issue_id, from_node, content_json FROM audit WHERE event_type = ? ORDER BY id').all(EVENT_TYPE) as { issue_id: number; from_node: string; content_json: string }[];
    } finally {
      d.close();
    }
  };
  const output = (stdout: string): Output => {
    const out = jsonValues(stdout)[0] as Output | undefined;
    assert.ok(out, 'an output');
    assert.equal(out.hookSpecificOutput?.hookEventName, 'PreToolUse');
    return out;
  };
  const nudged = (stdout: string): string => {
    const out = output(stdout);
    assert.equal(out.hookSpecificOutput?.permissionDecision, undefined, 'no permission decision');
    const context = out.hookSpecificOutput?.additionalContext ?? '';
    assert.match(context, /world-model read/);
    assert.match(context, /tmb_planning §1/);
    return context;
  };
  const denied = (stdout: string): string => {
    const out = output(stdout);
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
    assert.equal(out.hookSpecificOutput?.additionalContext, undefined);
    return out.hookSpecificOutput?.permissionDecisionReason ?? '';
  };
  const silent = (input: string): void => {
    const r = run(input);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(rows().length, 0);
  };

  before(() => {
    sb = makeSandbox(GATE_NAME);
    proj = join(sb.dir, 'proj');
    db = join(proj, '.claude/tmb/trajectory.db');
    mkdirSync(join(proj, '.claude/tmb'), { recursive: true });
    const d = new DatabaseSync(db);
    try {
      d.exec(SCHEMA);
      d.prepare("INSERT OR IGNORE INTO issues (id, objective, status, created_at, updated_at) VALUES (-1, 'system', 'open', ?, ?)").run(NOW, NOW);
      d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (7, 'wm', 'open', ?, ?)").run(NOW, NOW);
      d.prepare("INSERT INTO repos (name, path) VALUES ('app', '/tmp/app'), ('cold', '/tmp/cold')").run();
      d.prepare("INSERT INTO wm_files (repo, path, dir, updated_at) VALUES ('app', 'src/world-model/freshness.ts', 'src/world-model', ?)").run(NOW);
    } finally {
      d.close();
    }
  });

  after(() => sb.remove());

  beforeEach(() => {
    const d = new DatabaseSync(db);
    try {
      d.prepare('DELETE FROM audit WHERE event_type = ?').run(EVENT_TYPE);
    } finally {
      d.close();
    }
  });

  for (const tool of ['world_model_get', 'world_model_search', 'world_model_symbol', 'world_model_concepts', 'world_model_concept_get', 'scope_suggest']) {
    it(`SC2: a ${tool} read inside the window naming a files[] path in its input is a silent allow`, () => {
      silent(payload(transcript(toolUse('Read', minutesAgo(1)), toolUse(`${MCP}${tool}`, minutesAgo(WINDOW_MINUTES - 5), { query: 'x src/world-model/freshness.ts' }), toolUse('Bash', minutesAgo(1)))));
    });
  }

  it('SC2: a read whose path is a directory prefix of a files[] entry is a silent allow', () => {
    silent(payload(transcript(toolUse(`${MCP}world_model_get`, minutesAgo(2), { agent: 'bro', path: 'src/world-model/' }))));
  });

  it('SC2: a read of a file under a files[] directory entry is a silent allow', () => {
    silent(payload(transcript(toolUse(`${MCP}world_model_symbol`, minutesAgo(2), { agent: 'bro', path: './src/hooks/gate.ts', qualified_name: 'ALLOW' }))));
  });

  it('SC2: a read whose tool_result text names a files[] path is a silent allow, as a string or as text blocks', () => {
    silent(payload(transcript(toolUse(`${MCP}world_model_search`, minutesAgo(3), { query: 'freshness' }, 'assistant', 'toolu_res1'), toolResult('toolu_res1', '{"hits":[{"path":"src/world-model/freshness.ts"}]}'))));
    silent(payload(transcript(toolUse(`${MCP}world_model_search`, minutesAgo(3), { query: 'gate' }, 'assistant', 'toolu_res2'), toolResult('toolu_res2', '{"hits":[{"path":"src/hooks/gate.ts"}]}', true))));
  });

  it('SC2: a task with no files[] is allowed on any recent read', () => {
    silent(payload(transcript(toolUse(`${MCP}world_model_get`, minutesAgo(1))), { files: [] }));
  });

  const missing: readonly (readonly [string, () => string, string])[] = [
    ['no world-model tool_use', () => payload(transcript(toolUse('Read', minutesAgo(1)), toolUse(`${MCP}task_list`, minutesAgo(1)))), 'no_read'],
    ['only a read older than 60 minutes', () => payload(transcript(toolUse(`${MCP}world_model_get`, minutesAgo(WINDOW_MINUTES + 1), { path: 'src/hooks' }), toolUse('Read', minutesAgo(1)))), 'no_read'],
    ['a world-model call by a user line, not an assistant tool_use', () => payload(transcript(toolUse(`${MCP}world_model_get`, minutesAgo(1), { path: 'src/hooks' }, 'user'))), 'no_read'],
    ['a world-model name that only starts the same', () => payload(transcript(toolUse(`${MCP}world_model_getx`, minutesAgo(1), { path: 'src/hooks' }))), 'no_read'],
    ['unparsable lines only', () => payload(transcript(`{"type":"assistant","timestamp":"${minutesAgo(1)}","message":{"content":[{"type":"tool_use","name":"${MCP}world_model_get"`, 'not json')), 'no_read'],
    ['a recent read of another directory', () => payload(transcript(toolUse(`${MCP}world_model_get`, minutesAgo(1), { path: 'src/tools' }))), 'no_covering_read'],
    ['a recent root read whose result lists only top-level dirs', () => payload(transcript(toolUse(`${MCP}world_model_get`, minutesAgo(1), { agent: 'bro' }, 'assistant', 'toolu_root'), toolResult('toolu_root', '{"tree":[{"path":"src"},{"path":"docs"}]}'))), 'no_covering_read'],
    ['a recent read whose result names only a longer sibling path', () => payload(transcript(toolUse(`${MCP}world_model_search`, minutesAgo(1), { query: 'q' }, 'assistant', 'toolu_sib'), toolResult('toolu_sib', '"src/world-model/freshness.ts.map" "lib/src/hooks"'))), 'no_covering_read'],
    ['a tool_result naming a files[] path but answering another tool_use', () => payload(transcript(toolUse(`${MCP}world_model_search`, minutesAgo(1), { query: 'q' }, 'assistant', 'toolu_mine'), toolResult('toolu_other', 'src/world-model/freshness.ts'))), 'no_covering_read'],
    ['a missing transcript_path', () => payload(undefined), 'transcript_unreadable'],
    ['a transcript_path that does not exist', () => payload(join(sb.dir, 'absent.jsonl')), 'transcript_unreadable'],
  ];
  for (const [name, input, reason] of missing) {
    it(`SC1: ${name} denies, naming a world_model_get on a files[] directory, and writes one audit row (${reason})`, () => {
      const r = run(input());
      assert.equal(r.status, 0, r.stderr);
      const text = denied(r.stdout);
      assert.match(text, /tmb_planning §1/);
      assert.ok(text.endsWith(" Allowed form: world_model_get(repo='app', path='src/world-model')"), text);
      const got = rows();
      assert.equal(got.length, 1);
      assert.equal(got[0].issue_id, 7);
      assert.equal(got[0].from_node, `hook:${GATE_NAME}`);
      assert.deepEqual(JSON.parse(got[0].content_json), { tool: `${MCP}task_provision`, session_id: 'sess-2958', window_minutes: WINDOW_MINUTES, reason });
    });
  }

  it('SC1: an unknown or missing issue_id files the row under the system issue -1', () => {
    denied(run(payload(undefined, { issueId: 'not-a-number' })).stdout);
    const got = rows();
    assert.equal(got.length, 1);
    assert.equal(got[0].issue_id, -1);
  });

  it('SC2: a repo with no wm_files rows is allowed with the nudge and writes no row', () => {
    const r = run(payload(undefined, { repo: 'cold' }));
    assert.equal(r.status, 0, r.stderr);
    nudged(r.stdout);
    assert.equal(rows().length, 0);
  });

  it('a DB that does not resolve is allowed with the nudge', () => {
    const r = runGate(GATE_NAME, { cwd: proj, input: payload(undefined), env: { ...env(), TRAJECTORY_DB_PATH: join(sb.dir, 'no.db') } });
    assert.equal(r.status, 0, r.stderr);
    nudged(r.stdout);
  });

  it('another tool and an unparsable payload are silent', () => {
    assert.equal(run(payload(undefined, { tool: 'task_list' })).stdout, '');
    assert.equal(run('not json').stdout, '');
    assert.equal(rows().length, 0);
  });

  it('hasRecentWmRead skips a future timestamp and an unparsable one', () => {
    const now = Date.parse(NOW);
    assert.equal(hasRecentWmRead(toolUse(`${MCP}world_model_get`, '2026-11-08T10:05:00.000Z'), now), false);
    assert.equal(hasRecentWmRead(toolUse(`${MCP}world_model_get`, 'yesterday'), now), false);
    assert.equal(hasRecentWmRead(toolUse(`${MCP}world_model_get`, '2026-11-08T09:00:00.000Z'), now), true);
    assert.equal(hasRecentWmRead(toolUse(`${MCP}world_model_get`, '2026-11-08T08:59:59.999Z'), now), false);
  });

  it('missingReason: a files[] entry at the repo root is covered by any recent read; paths compare posix without a trailing slash', () => {
    const now = Date.parse(NOW);
    const read = toolUse(`${MCP}world_model_get`, '2026-11-08T09:30:00.000Z', { path: 'docs' });
    assert.equal(missingReason(read, ['./'], now), null);
    assert.equal(missingReason(read, ['src\\a.ts'], now), 'no_covering_read');
    assert.equal(missingReason(read, ['docs\\guide.md'], now), null);
    assert.equal(normalizePath('./src\\hooks//'), 'src/hooks');
  });

  it('readCall names the first files[] entry\'s directory, the entry itself when it ends with /', () => {
    assert.equal(readCall('app', ['src/a/b.ts', 'x']), "world_model_get(repo='app', path='src/a')");
    assert.equal(readCall('app', ['src/hooks/']), "world_model_get(repo='app', path='src/hooks')");
    assert.equal(readCall('app', ['README.md']), "world_model_get(repo='app', path='')");
    assert.equal(readCall(null, []), 'world_model_get()');
  });

  it('SC1: registered as an enforcement, TS-only gate on task_provision alone in the trajectory-server group', () => {
    assert.equal(findGate(GATE_NAME), wmReadBeforeProvision);
    const registered = routerGates('PreToolUse', `${MCP}task_provision`).filter((g) => g.name === GATE_NAME);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].kind, 'enforcement');
    assert.equal(registered[0].tsOnly, true);
    assert.equal(registered[0].toolSuffix, 'task_provision');
    for (const tool of ['task_reopen', 'task_retry', 'task_list', 'world_model_get']) {
      assert.equal(routerGates('PreToolUse', `${MCP}${tool}`).some((g) => g.name === GATE_NAME), false, tool);
    }
    for (const tool of ['Bash', 'Write', 'Agent', 'Read']) assert.equal(routerGates('PreToolUse', tool).some((g) => g.name === GATE_NAME), false, tool);
    assert.equal(isAuditEventType(EVENT_TYPE), true);
    assert.deepEqual(auditEventWriters(EVENT_TYPE), ['hook']);
  });

  it('SC1: the PreToolUse router denies task_provision and runs no gate of it for task_reopen', () => {
    const viaRouter = runGate('PreToolUse', { cwd: proj, input: payload(undefined), env: env() });
    assert.equal(viaRouter.status, 0, viaRouter.stderr);
    assert.match(denied(viaRouter.stdout), /world_model_get\(repo='app', path='src\/world-model'\)/);
    assert.equal(rows().length, 1);
    const reopen = runGate('PreToolUse', { cwd: proj, input: payload(undefined, { tool: 'task_reopen' }), env: env() });
    assert.equal(reopen.status, 0, reopen.stderr);
    assert.doesNotMatch(reopen.stdout, /world-model read/);
    assert.equal(rows().length, 1);
  });
});
