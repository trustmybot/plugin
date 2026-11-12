/**
 * The activation-routine l3 bash suite in node:test (GH 1692): the
 * UserPromptSubmit gate runs as `node dist/hooks.js activation-routine` with
 * CLAUDE_PROJECT_DIR pinned and PWD set, a `pgrep` stub first on PATH that
 * matches its pattern against fake command lines, and a minimal DB. The cases
 * share that state and run in order, as the bash suite's did.
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { BRO_COMPACT_NUDGE_TOKENS_KEY } from '../tools/config.js';
import { contextOf, makeSandbox, PLUGIN_ROOT, runGate, type Sandbox } from './hook-sandbox.js';
import { gateEnv, has, hasNot, sql } from './git-push-guard-l3.js';

const SERVER_HERE = `node ${PLUGIN_ROOT}/mcp/trajectory-server/dist/index.js`;

describe('activation-routine l3', () => {
  let sb: Sandbox;
  let db: string;
  let procs: string;
  let mcpDown: string;
  let pgrepFail: string;
  let bin: string;
  const t: Record<'bro' | 'exited' | 'plain' | 'bareBro' | 'noAnnounce', string> = { bro: '', exited: '', plain: '', bareBro: '', noAnnounce: '' };

  const input = (prompt: string, transcript = '') => ({ prompt, transcript_path: transcript });

  /** The gate's stdout + stderr for <payload>. */
  function runHook(payload: object, env: NodeJS.ProcessEnv = {}): string {
    const base = gateEnv(sb, sb.dir);
    const r = runGate('activation-routine', {
      cwd: sb.dir,
      input: JSON.stringify(payload),
      env: { ...base, PATH: `${bin}${delimiter}${base.PATH}`, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, TRAJECTORY_DB_PATH: db, ...env },
    });
    return r.stdout + r.stderr;
  }

  const touch = (p: string) => writeFileSync(p, '');
  const lines = (...l: string[]) => l.map((x) => `${x}\n`).join('');

  /** <ctx> places the stable onboarded= marker before the volatile pending= one. */
  function assertOrder(ctx: string): void {
    const onboarded = ctx.indexOf('onboarded=');
    const pending = ctx.indexOf('pending=');
    assert.ok(onboarded >= 0 && pending >= 0, `could not locate markers: onboarded_pos=<${onboarded}> pending_pos=<${pending}> ctx=<${ctx}>`);
    assert.ok(onboarded < pending, `stable onboarded= at ${onboarded} should be before volatile pending= at ${pending}`);
  }

  before(() => {
    sb = makeSandbox('activation-routine');
    db = join(sb.dir, 'trajectory.db');
    procs = join(sb.dir, 'procs');
    mcpDown = join(sb.dir, 'mcp-down');
    pgrepFail = join(sb.dir, 'pgrep-fail');
    bin = join(sb.dir, 'bin');
    writeFileSync(procs, `${SERVER_HERE}\n`);
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'pgrep'),
      `#!/usr/bin/env bash
[ -e "${pgrepFail}" ] && { echo "pgrep: Cannot get process list" >&2; exit 3; }
[ -e "${mcpDown}" ] && exit 1
grep -nE -- "$2" "${procs}" | cut -d: -f1 | grep . || exit 1
`,
      { mode: 0o755 },
    );
    const d = new DatabaseSync(db);
    try {
      d.exec(`
        CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
        CREATE TABLE issues (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          objective TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          repo TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_id INTEGER NOT NULL,
          branch_id TEXT,
          from_node TEXT NOT NULL,
          event_type TEXT NOT NULL,
          summary TEXT NOT NULL,
          content_json TEXT,
          repo TEXT,
          created_at TEXT NOT NULL
        );
      `);
    } finally {
      d.close();
    }
    const transcript = (name: string, body: string) => {
      const p = join(sb.dir, `transcript-${name}.jsonl`);
      writeFileSync(p, body);
      return p;
    };
    t.bro = transcript('bro', lines('{"role":"assistant","content":"Entering bro mode."}'));
    t.exited = transcript('exited', lines('{"role":"assistant","content":"Entering bro mode."}', '{"role":"user","content":"exit bro mode"}'));
    t.plain = transcript('plain', lines('{"role":"user","content":"hello"}'));
    t.bareBro = transcript(
      'bare-bro',
      lines('{"role":"user","content":"thanks bro"}', '{"role":"assistant","content":"bro routes the work to swe; this is bro-mode territory."}'),
    );
    t.noAnnounce = transcript('no-announce', lines('{"role":"user","content":"@bro implement the cli"}', '{"role":"assistant","content":"On it. What scope?"}'));
  });
  after(() => sb.remove());

  it('plain prompt + no transcript: silent no-op', () => {
    assert.equal(runHook(input('just a normal claude question')), '', 'no output');
  });

  it('plain prompt + plain transcript: silent no-op', () => {
    assert.equal(runHook(input('still just regular work', t.plain)), '', 'no output');
  });

  it('word brother (or similar) does not false-trigger via \\bbro\\b', () => {
    assert.equal(runHook(input('my brother said hi')), '', 'no output for substring match');
  });

  it('transcript had bro mode but user later exited: no-op', () => {
    assert.equal(runHook(input('normal followup', t.exited)), '', 'no output once bro mode exited');
  });

  it("#276: bare 'bro' in transcript (no @sigil, no announce): no sticky no-op", () => {
    assert.equal(runHook(input('a normal question', t.bareBro)), '', "casual 'bro' mention must not make the session sticky-bro");
  });

  it('GH 1199: a subagent hand-back mentioning bro does not activate bro mode', () => {
    assert.equal(runHook(input('[Subagent hand-back] swe reports to bro: task done')), '', "a harness turn's bro word is not the Human's");
  });

  it('GH 1199: a hand-back in a sticky bro session still gets the activation context', () => {
    has(runHook(input('<agent-message from="swe">done</agent-message>', t.bro)), 'tmb activation routine', 'sticky bro mode is unaffected');
  });

  it('@bro greeting + empty DB state (no identity, no pending): emit FIRST CONTACT auto-fire signal', () => {
    const out = runHook(input('@bro hi'));
    has(out, '"hookEventName":"UserPromptSubmit"', 'JSON has correct event name');
    has(out, 'FIRST CONTACT', 'first-contact marker present in injected context');
    has(out, 'auto-fire /onboard', 'auto-fire instruction injected');
    has(out, 'pending=<none>', 'pending reported as none');
  });

  it('onboarded marker present (post-onboard, #95): emits onboarded=yes, NOT first-contact', () => {
    sql(db, "DELETE FROM plugin_config WHERE key='onboarded'");
    sql(db, "INSERT INTO plugin_config (key, value_json) VALUES ('onboarded', 'true')");
    const out = runHook(input('@bro hi'));
    has(out, 'onboarded=yes', 'onboarded marker present');
    hasNot(out, 'FIRST CONTACT', 'onboarded row should NOT trigger FIRST CONTACT auto-fire (#95 regression)');
    sql(db, "DELETE FROM plugin_config WHERE key='onboarded'");
  });

  it('@bro greeting + onboarded marker present: onboarded=yes (no name stored)', () => {
    sql(db, "INSERT INTO plugin_config (key, value_json) VALUES ('onboarded', 'true')");
    has(runHook(input('@bro hi')), 'onboarded=yes', 'onboarded reported');
  });

  it('@bro greeting + pending issue: emit issue id + objective', () => {
    sql(db, "INSERT INTO issues (objective, status) VALUES ('Wire activation routine hook', 'open')");
    has(runHook(input('@bro continue')), 'pending=#1: Wire activation routine hook', 'pending issue rendered');
  });

  it('sticky bro mode (transcript has Entering bro mode., no exit): non-bro prompt still triggers', () => {
    const out = runHook(input('what about pyproject.toml', t.bro));
    has(out, '"hookEventName":"UserPromptSubmit"', 'sticky bro fires hook');
    has(out, 'onboarded=yes', 'still pre-fetches onboarded marker');
  });

  it('REGRESSION: user said @bro in prior turn but assistant skipped announce → sticky still fires', () => {
    has(runHook(input('small, single-file', t.noAnnounce)), '"hookEventName":"UserPromptSubmit"', 'sticky fires without announce marker');
  });

  it('ordering: onboarded= (stable) appears before pending= (volatile) — post-onboard case', () => {
    sql(db, "DELETE FROM plugin_config WHERE key='onboarded'");
    sql(db, "INSERT INTO plugin_config (key, value_json) VALUES ('onboarded', 'true')");
    assertOrder(contextOf(runHook(input('@bro status'))));
  });

  it('ordering: onboarded= (stable) appears before pending= (volatile) — first-contact case', () => {
    sql(db, "DELETE FROM plugin_config WHERE key='onboarded'");
    assertOrder(contextOf(runHook(input('@bro hi'))));
  });

  it('additionalContext carries session_id=<payload id>', () => {
    const ctx = contextOf(runHook({ prompt: '@bro status', session_id: '3f2c9a10-7b4e-4d21-9c3a-0e5f6a7b8c9d' }));
    has(ctx, 'session_id=3f2c9a10-7b4e-4d21-9c3a-0e5f6a7b8c9d', 'payload session id injected');
  });

  it('a malformed or missing session_id is not injected', () => {
    hasNot(runHook({ prompt: '@bro status', session_id: 'bad id; rm -rf' }), 'session_id=', 'malformed id dropped');
    hasNot(runHook(input('@bro status')), 'session_id=', 'no id without one in the payload');
  });

  describe('GH 3029: /compact nudge past bro_compact_nudge_tokens', () => {
    const NUDGE = "this bro session's context is";
    const call = (id: string, input: number, cacheRead: number, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        type: 'assistant',
        ...extra,
        message: { id, model: 'claude-opus-5-5', usage: { input_tokens: input, cache_creation_input_tokens: 1000, cache_read_input_tokens: cacheRead } },
      });
    const usageTranscript = (name: string, lastContext: number) => {
      const p = join(sb.dir, `transcript-usage-${name}.jsonl`);
      writeFileSync(
        p,
        lines(
          '{"role":"assistant","content":"Entering bro mode."}',
          call('msg_early', 10, 500_000),
          call('msg_last', 10, lastContext - 1010),
          call('msg_side', 10, 900_000, { isSidechain: true }),
          JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 900_000 } } }),
        ),
      );
      return p;
    };
    const nudgeRows = (session: string): string[] => {
      const d = new DatabaseSync(db);
      try {
        return d
          .prepare("SELECT content_json FROM audit WHERE event_type='bro_compact_nudged' AND json_extract(content_json, '$.session_id') = ?")
          .all(session)
          .map((r) => String(r.content_json));
      } finally {
        d.close();
      }
    };
    const nudges = (session: string) => String(nudgeRows(session).length);
    const prompt = (session: string, transcript: string) => runHook({ prompt: 'carry on', session_id: session, transcript_path: transcript });
    const setThreshold = (valueJson: string | null) => {
      sql(db, 'DELETE FROM plugin_config WHERE key = ?', BRO_COMPACT_NUDGE_TOKENS_KEY);
      if (valueJson !== null) sql(db, 'INSERT INTO plugin_config (key, value_json) VALUES (?, ?)', BRO_COMPACT_NUDGE_TOKENS_KEY, valueJson);
    };

    it('a context above the default threshold nudges once, with one audit row; the next prompt does not', () => {
      setThreshold(null);
      const session = 'nudge-session-0001';
      const first = contextOf(prompt(session, usageTranscript('over', 90_000)));
      has(first, `${NUDGE} 90000 tokens, past bro_compact_nudge_tokens (80000)`, 'nudge names the last call context and the default threshold');
      has(first, '/compact', 'nudge asks for /compact');
      assert.equal(nudges(session), '1', 'one bro_compact_nudged row');
      assert.deepEqual(JSON.parse(nudgeRows(session)[0]), { session_id: session, context_tokens: 90_000, threshold: 80_000 });
      hasNot(contextOf(prompt(session, usageTranscript('over', 90_000))), NUDGE, 'second prompt of the session gets no nudge');
      assert.equal(nudges(session), '1', 'still one row after the second prompt');
    });

    it('a context at or under the threshold does not nudge', () => {
      setThreshold('90000');
      const session = 'nudge-session-0002';
      hasNot(contextOf(prompt(session, usageTranscript('at', 90_000))), NUDGE, 'context equal to the threshold');
      hasNot(contextOf(prompt(session, usageTranscript('under', 50_000))), NUDGE, 'context under the threshold');
      assert.equal(nudges(session), '0', 'no audit row');
    });

    it('threshold 0 turns the nudge off', () => {
      setThreshold('0');
      const session = 'nudge-session-0003';
      hasNot(contextOf(prompt(session, usageTranscript('off', 500_000))), NUDGE, 'no nudge when off');
      assert.equal(nudges(session), '0', 'no audit row');
      setThreshold(null);
    });

    it('no usage in the transcript or no session id: no nudge', () => {
      hasNot(contextOf(prompt('nudge-session-0004', t.bro)), NUDGE, 'transcript without usage');
      hasNot(contextOf(runHook({ prompt: 'carry on', transcript_path: usageTranscript('nosession', 500_000) })), NUDGE, 'no session id');
    });
  });

  it('bro mode + server running: no HALT', () => {
    hasNot(runHook(input('@bro status')), 'HALT', 'no HALT while the server runs');
  });

  it('bro mode + server absent: HALT + recovery pointer, DB context kept', () => {
    touch(mcpDown);
    const ctx = contextOf(runHook(input('@bro status')));
    has(ctx, 'Bro: HALT', 'HALT emitted');
    has(ctx, 'tmb_recovery §B', 'recovery pointer');
    has(ctx, 'onboarded=', 'pre-fetched state still injected');
  });

  it('non-bro prompt + server absent: silent', () => {
    assert.equal(runHook(input('just a normal question')), '', 'no output outside bro mode');
    rmSync(mcpDown, { force: true });
  });

  it('GH 1606: pgrep cannot list processes (exit 3): no HALT', () => {
    touch(pgrepFail);
    const out = runHook(input('@bro status'));
    hasNot(out, 'HALT', 'unknown liveness is not evidence of absence');
    has(out, 'onboarded=', 'pre-fetched state still injected');
    rmSync(pgrepFail, { force: true });
  });

  it('GH 1606: server running from another plugin root: no HALT', () => {
    writeFileSync(procs, 'node /elsewhere/tmb/1.2.0-dev.10/mcp/trajectory-server/dist/index.js\n');
    hasNot(runHook(input('@bro status'), { CLAUDE_PLUGIN_ROOT: '/elsewhere/tmb/1.2.0-dev.11' }), 'HALT', 'a server under another version dir counts as running');
    writeFileSync(procs, `${SERVER_HERE}\n`);
  });

  it("bro trigger but DB doesn't exist: silent no-op (graceful first-activation)", () => {
    rmSync(db, { force: true });
    assert.equal(runHook(input('@bro hi')), '', 'no output when DB missing');
  });

  it('bro trigger, DB missing, server absent: HALT alone', () => {
    touch(mcpDown);
    has(contextOf(runHook(input('@bro hi'))), 'Bro: HALT', 'HALT without a DB');
    rmSync(mcpDown, { force: true });
  });
});
