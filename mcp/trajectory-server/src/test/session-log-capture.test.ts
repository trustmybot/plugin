/**
 * session-log-capture (GH 1692): on UserPromptSubmit it appends a JSONL event
 * line to <workspace>/.claude/tmb/logs/<UTC date>-<session id>.jsonl, the id
 * from the payload, else the .current-session-id sentinel, else a generated
 * one, and is a silent no-op with no workspace DB. Each case runs
 * `node dist/hooks.js session-log-capture` in a sandbox with its own HOME.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makeSandbox, runGate, type Sandbox } from './hook-sandbox.js';

const GATE = 'session-log-capture';
const today = () => new Date().toISOString().slice(0, 10);

describe('session-log-capture: a JSONL line per prompt in the workspace logs', () => {
  let sb: Sandbox;

  before(() => {
    sb = makeSandbox(GATE);
  });

  after(() => sb.remove());

  function workspace(name: string): { ws: string; env: NodeJS.ProcessEnv } {
    const ws = join(sb.dir, name);
    mkdirSync(join(ws, '.claude/tmb/logs'), { recursive: true });
    writeFileSync(join(ws, '.claude/tmb/trajectory.db'), '');
    return { ws, env: { ...sb.env, TRAJECTORY_DB_PATH: join(ws, '.claude/tmb/trajectory.db') } };
  }

  const run = (ws: string, env: NodeJS.ProcessEnv, input: string) => {
    const r = runGate(GATE, { cwd: ws, env, input: `${input}\n` });
    return r.stdout + r.stderr;
  };

  it('creates the log file and appends a JSONL event line (stdin session_id)', () => {
    const { ws, env } = workspace('ws1');
    const out = run(ws, env, '{"prompt":"hello world","additionalContext":"some ctx","session_id":"test-session-001"}');
    assert.ok(out.includes('"continue": true'), 'emits continue');
    const log = join(ws, `.claude/tmb/logs/${today()}-test-session-001.jsonl`);
    assert.ok(existsSync(log), `log file created at ${log}`);
    const line = readFileSync(log, 'utf8').split('\n')[0];
    assert.ok(line.includes('"event":"user_prompt"'), 'event field present');
    assert.ok(line.includes('"prompt":"hello world"'), 'prompt captured');
    assert.ok(line.includes('"additional_context":"some ctx"'), 'additional_context captured');
    assert.ok(line.includes('"ts"'), 'timestamp field present');
  });

  it('appends multiple lines on repeated invocation', () => {
    const { ws, env } = workspace('ws2');
    run(ws, env, '{"prompt":"first","session_id":"test-session-002"}');
    run(ws, env, '{"prompt":"second","session_id":"test-session-002"}');
    const text = readFileSync(join(ws, `.claude/tmb/logs/${today()}-test-session-002.jsonl`), 'utf8');
    assert.equal(text.split('\n').length - 1, 2, 'two lines in log');
  });

  it('falls back to the sentinel file when no session_id is on stdin', () => {
    const { ws, env } = workspace('ws3');
    writeFileSync(join(ws, '.claude/tmb/.current-session-id'), 'sentinel-session-003');
    run(ws, env, '{"prompt":"sentinel fallback"}');
    const log = join(ws, `.claude/tmb/logs/${today()}-sentinel-session-003.jsonl`);
    assert.ok(existsSync(log), `log file at ${log} using the sentinel session_id`);
  });

  it('generates a fallback session_id when neither stdin nor the sentinel has one', () => {
    const { ws, env } = workspace('ws4');
    assert.ok(!existsSync(join(ws, '.claude/tmb/.current-session-id')), 'no sentinel');
    run(ws, env, '{"prompt":"auto session"}');
    const logs = readdirSync(join(ws, '.claude/tmb/logs')).filter((f) => f.startsWith(`${today()}-`) && f.endsWith('.jsonl'));
    assert.ok(logs.length >= 1, 'a log file for the auto-generated session_id');
  });

  it('is a silent no-op when no workspace is detected (no DB)', () => {
    const home = join(sb.dir, 'isolated-home');
    const cwd = join(sb.dir, 'isolated-cwd');
    mkdirSync(home);
    mkdirSync(cwd);
    assert.equal(run(cwd, { ...sb.env, HOME: home }, '{"prompt":"lost"}'), '', 'no output when no workspace detected');
  });
});
