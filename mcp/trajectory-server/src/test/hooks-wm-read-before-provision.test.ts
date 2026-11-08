/**
 * wm-read-before-provision (GH 2329): a task_provision call is silent only
 * when the session transcript holds an assistant world-model read tool_use
 * within the last 60 minutes; no read, only an older one, an unparsable
 * transcript or none at all each allow the call with an additionalContext
 * nudge and one wm_read_missing_before_provision audit row. The gate is
 * registered for task_provision alone in the trajectory-server group, and
 * the router passes the nudge on. Each case runs `node dist/hooks.js` in a
 * sandbox with its own HOME and a temp trajectory DB.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, beforeEach, describe, it } from 'node:test';
import { isAuditEventType, auditEventWriters } from '../audit-events.js';
import { findGate, routerGates } from '../hooks/registry.js';
import { EVENT_TYPE, GATE_NAME, hasRecentWmRead, WINDOW_MINUTES, wmReadBeforeProvision } from '../hooks/wm-read-before-provision.js';
import { jsonValues, makeSandbox, PLUGIN_ROOT, runGate, type Sandbox } from './hook-sandbox.js';

const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const NOW = '2026-11-08T10:00:00.000Z';
const MCP = 'mcp__plugin_tmb_trajectory-server__';

type Output = { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string; permissionDecision?: string } };

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

function toolUse(name: string, at: string, type = 'assistant'): string {
  return JSON.stringify({ type, timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name, input: {} }] } });
}

function payload(transcript: string | undefined, tool = 'task_provision', issueId: unknown = 7): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'sess-2329',
    ...(transcript === undefined ? {} : { transcript_path: transcript }),
    tool_name: `${MCP}${tool}`,
    tool_input: { agent: 'bro', issue_id: issueId, objective: 'o' },
  });
}

describe('wm-read-before-provision (GH 2329)', () => {
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
  const nudged = (stdout: string): string => {
    const out = jsonValues(stdout)[0] as Output | undefined;
    assert.ok(out, 'an output');
    assert.equal(out.hookSpecificOutput?.permissionDecision, undefined, 'never a permission decision');
    assert.equal(out.hookSpecificOutput?.hookEventName, 'PreToolUse');
    const context = out.hookSpecificOutput?.additionalContext ?? '';
    assert.match(context, /world-model read/);
    assert.match(context, /tmb_planning §1/);
    return context;
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
    it(`SC1: a ${tool} read inside the window is a silent allow with no audit row`, () => {
      const r = run(payload(transcript(toolUse('Read', minutesAgo(1)), toolUse(`${MCP}${tool}`, minutesAgo(WINDOW_MINUTES - 5)), toolUse('Bash', minutesAgo(1)))));
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '');
      assert.equal(rows().length, 0);
    });
  }

  const missing: readonly (readonly [string, () => string, string])[] = [
    ['no world-model tool_use', () => payload(transcript(toolUse('Read', minutesAgo(1)), toolUse(`${MCP}task_list`, minutesAgo(1)))), 'no_read'],
    ['only a read older than 60 minutes', () => payload(transcript(toolUse(`${MCP}world_model_get`, minutesAgo(WINDOW_MINUTES + 1)), toolUse('Read', minutesAgo(1)))), 'no_read'],
    ['a world-model call by a user line, not an assistant tool_use', () => payload(transcript(toolUse(`${MCP}world_model_get`, minutesAgo(1), 'user'))), 'no_read'],
    ['a world-model name that only starts the same', () => payload(transcript(toolUse(`${MCP}world_model_getx`, minutesAgo(1)))), 'no_read'],
    ['unparsable lines only', () => payload(transcript(`{"type":"assistant","timestamp":"${minutesAgo(1)}","message":{"content":[{"type":"tool_use","name":"${MCP}world_model_get"`, 'not json')), 'no_read'],
    ['a missing transcript_path', () => payload(undefined), 'transcript_unreadable'],
    ['a transcript_path that does not exist', () => payload(join(sb.dir, 'absent.jsonl')), 'transcript_unreadable'],
  ];
  for (const [name, input, reason] of missing) {
    it(`SC2/SC3: ${name} allows with the nudge and writes one audit row (${reason})`, () => {
      const r = run(input());
      assert.equal(r.status, 0, r.stderr);
      nudged(r.stdout);
      const got = rows();
      assert.equal(got.length, 1);
      assert.equal(got[0].issue_id, 7);
      assert.equal(got[0].from_node, `hook:${GATE_NAME}`);
      assert.deepEqual(JSON.parse(got[0].content_json), { tool: `${MCP}task_provision`, session_id: 'sess-2329', window_minutes: WINDOW_MINUTES, reason });
    });
  }

  it('SC3: an unknown or missing issue_id files the row under the system issue -1', () => {
    run(payload(undefined, 'task_provision', 'not-a-number'));
    const got = rows();
    assert.equal(got.length, 1);
    assert.equal(got[0].issue_id, -1);
  });

  it('a failed audit write still allows with the nudge', () => {
    const r = runGate(GATE_NAME, { cwd: proj, input: payload(undefined), env: { ...env(), TRAJECTORY_DB_PATH: join(sb.dir, 'no.db') } });
    assert.equal(r.status, 0, r.stderr);
    nudged(r.stdout);
  });

  it('another tool and an unparsable payload are silent', () => {
    assert.equal(run(payload(undefined, 'task_list')).stdout, '');
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

  it('SC4: registered as an advisory, TS-only gate on task_provision alone in the trajectory-server group', () => {
    assert.equal(findGate(GATE_NAME), wmReadBeforeProvision);
    const registered = routerGates('PreToolUse', `${MCP}task_provision`).filter((g) => g.name === GATE_NAME);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].kind, 'advisory');
    assert.equal(registered[0].tsOnly, true);
    assert.equal(registered[0].toolSuffix, 'task_provision');
    for (const tool of ['task_reopen', 'task_retry', 'task_list', 'world_model_get']) {
      assert.equal(routerGates('PreToolUse', `${MCP}${tool}`).some((g) => g.name === GATE_NAME), false, tool);
    }
    for (const tool of ['Bash', 'Write', 'Agent', 'Read']) assert.equal(routerGates('PreToolUse', tool).some((g) => g.name === GATE_NAME), false, tool);
    assert.equal(isAuditEventType(EVENT_TYPE), true);
    assert.deepEqual(auditEventWriters(EVENT_TYPE), ['hook']);
  });

  it('SC4: the PreToolUse router allows task_provision with the nudge and runs no gate of it for task_reopen', () => {
    const viaRouter = runGate('PreToolUse', { cwd: proj, input: payload(undefined), env: env() });
    assert.equal(viaRouter.status, 0, viaRouter.stderr);
    nudged(viaRouter.stdout);
    assert.equal(rows().length, 1);
    const reopen = runGate('PreToolUse', { cwd: proj, input: payload(undefined, 'task_reopen'), env: env() });
    assert.equal(reopen.status, 0, reopen.stderr);
    assert.doesNotMatch(reopen.stdout, /world-model read/);
    assert.equal(rows().length, 1);
  });
});
