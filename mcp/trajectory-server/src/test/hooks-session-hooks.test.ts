/**
 * Unit tests of the TypeScript session and prompt hooks (GH 1692): the
 * divergences from their scripts/hooks/<gate>.sh that decision 703 allows
 * (no jq, no sqlite3 CLI, the persona's raw-text decoding, grep's word
 * table), and the helpers the parity corpus leans on.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:buffer';
import { activationRoutine, HALT_TEXT, LocaleGrep, pastContextLimit, recentContext } from '../hooks/activation-routine.js';
import { argsJson, debugTrajectory } from '../hooks/debug-trajectory.js';
import { jqNumberLiteral } from '../hooks/lib/jq.js';
import { commandOnPath, personaContext, personaEmit, personaInit } from '../hooks/lib/persona.js';
import { setlocaleUtf8 } from '../hooks/lib/project-env.js';
import { pluginHooksMarker } from '../hooks/plugin-hooks-marker.js';
import { CONTINUE, logLines, sessionLogCapture } from '../hooks/session-log-capture.js';
import { buildSandbox, snapshot } from './hooks-session-parity.suite.js';

describe('session hooks without jq or the sqlite3 CLI (decision 703)', () => {
  let base: string;
  let s: string;
  let emptyBin: string;
  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-session-hooks-')));
    s = join(base, 'sandbox');
    emptyBin = join(base, 'empty-bin');
    mkdirSync(emptyBin);
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    HOME: join(s, 'home'),
    CLAUDE_PROJECT_DIR: join(s, 'project'),
    CLAUDE_PLUGIN_ROOT: join(s, 'plugin'),
    PATH: emptyBin,
    LC_ALL: 'C',
    ...extra,
  });

  it('the PATH under test holds neither jq nor sqlite3', () => {
    assert.equal(commandOnPath('jq', env()), false);
    assert.equal(commandOnPath('sqlite3', env()), false);
  });

  it('plugin-hooks-marker writes the session marker, where the .sh exits without jq', () => {
    buildSandbox(s);
    assert.deepEqual(pluginHooksMarker('{"session_id":"nojq-session-01"}', env()), { stdout: '', code: 0 });
    const sessions = join(s, 'project/.claude/tmb/sessions');
    assert.ok(existsSync(join(sessions, 'nojq-session-01.plugin-hooks')));
    assert.ok(!existsSync(join(sessions, 'stale-session-0001.plugin-hooks')), 'stale marker pruned');
    assert.ok(existsSync(join(sessions, 'stale-session-0001.persona')), 'other suffixes kept');
  });

  it('session-log-capture logs the prompt, where the .sh leaves an empty log without jq', () => {
    buildSandbox(s);
    const r = sessionLogCapture('{"session_id":"nojq-log-01","prompt":"hi","additionalContext":"c"}', env());
    assert.equal(r.stdout, CONTINUE);
    const logs = join(s, 'project/.claude/tmb/logs');
    const [file] = readdirSync(logs);
    assert.match(file, /^\d{4}-\d\d-\d\d-nojq-log-01\.jsonl$/);
    const line = JSON.parse(readFileSync(join(logs, file), 'utf8')) as Record<string, string>;
    assert.deepEqual({ ...line, ts: '' }, { ts: '', event: 'user_prompt', prompt: 'hi', additional_context: 'c' });
  });

  it('activation-routine reads the DB through node:sqlite and emits, where the .sh exits without jq or sqlite3', () => {
    buildSandbox(s);
    const r = activationRoutine('{"prompt":"hey bro","session_id":"nojq-act-0001"}', env());
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(out.hookSpecificOutput.additionalContext, /onboarded=yes\. .* pending=#3: ship the \| bar thing\nover two lines session_id=nojq-act-0001$/s);
    assert.ok(!out.hookSpecificOutput.additionalContext.includes(HALT_TEXT), 'no pgrep on PATH: no HALT');
  });

  it('activation-routine HALT names the cli.js read fallback, where the .sh named a shell script (GH 1692)', () => {
    buildSandbox(s);
    const downBin = join(base, 'pgrep-down-bin');
    mkdirSync(downBin, { recursive: true });
    writeFileSync(join(downBin, 'pgrep'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const r = activationRoutine('{"prompt":"bro","session_id":"halt-cli-0001"}', env({ PATH: downBin }));
    const context = (JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    assert.ok(context.startsWith(HALT_TEXT), 'server down: HALT first');
    assert.ok(
      context.includes('(`node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" bro-sqlite-readonly`)'),
      'HALT cites the cli.js invocation',
    );
    assert.ok(!/readonly\.sh\b/.test(context), 'HALT no longer cites the deleted script');
  });

  it('debug-trajectory records the call through node:sqlite, where the .sh needs jq and sqlite3', () => {
    buildSandbox(s);
    const r = debugTrajectory(
      '{"tool_name":"Bash","tool_input":{"command":"ls","n":1.50}}',
      env({ TMB_EVAL_MODE: '1', TMB_DEBUG_TRAJECTORY: '1', CLAUDE_SESSION_ID: 'dbg-session-0001' }),
    );
    assert.deepEqual(r, { stdout: '', code: 0 });
    const db = new DatabaseSync(join(s, 'project/.claude/tmb/trajectory.db'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT step_n, tool_or_mcp_name, args_json FROM debug_trajectory WHERE session_id = ? ORDER BY step_n').all('dbg-session-0001');
      assert.deepEqual(rows.map((row) => ({ ...row })), [
        { step_n: 1, tool_or_mcp_name: 'Read', args_json: '{}' },
        { step_n: 2, tool_or_mcp_name: 'Bash', args_json: '{"command":"ls","n":1.50}' },
      ]);
    } finally {
      db.close();
    }
  });

  it('the parity snapshot sees the files a hook writes', () => {
    buildSandbox(s);
    const before = snapshot(s);
    pluginHooksMarker('{"session_id":"snap-session-01"}', env());
    const added = snapshot(s).filter((line) => !before.includes(line));
    assert.deepEqual(added, ['project/.claude/tmb/sessions/snap-session-01.plugin-hooks: ']);
  });
});

describe('persona raw text', () => {
  it('decodes invalid UTF-8 in the plugin CLAUDE.md as U+FFFD, where the .sh prints the raw bytes', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-persona-raw-')));
    try {
      mkdirSync(join(dir, 'plugin/.claude-plugin'), { recursive: true });
      mkdirSync(join(dir, 'project'));
      writeFileSync(join(dir, 'plugin/.claude-plugin/plugin.json'), '{"name":"tmb","version":"1.1.0"}');
      writeFileSync(join(dir, 'plugin/CLAUDE.md'), Buffer.from([0x62, 0x72, 0x6f, 0xff, 0x0a]));
      const persona = personaInit({ CLAUDE_PLUGIN_ROOT: join(dir, 'plugin'), CLAUDE_PROJECT_DIR: join(dir, 'project'), PATH: '' }, false);
      assert.ok(persona);
      const context = personaContext(persona, { CLAUDE_PROJECT_DIR: join(dir, 'project') });
      assert.ok(context?.endsWith('\n\nbro�'));
      assert.equal(personaEmit(persona, 'SessionStart', 'ctx'), 'ctx\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('activation-routine usage warning', () => {
  const SESSION = 'usage-session-01';
  const ACTION = 'Finish what is in flight, then end the session and resume cold from the DB.';
  let base: string;
  let s: string;
  let emptyBin: string;
  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-usage-warning-')));
    s = join(base, 'sandbox');
    emptyBin = join(base, 'empty-bin');
    mkdirSync(emptyBin);
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  const env = (): NodeJS.ProcessEnv => ({
    HOME: join(s, 'home'),
    CLAUDE_PROJECT_DIR: join(s, 'project'),
    CLAUDE_PLUGIN_ROOT: join(s, 'plugin'),
    PATH: emptyBin,
    LC_ALL: 'C',
  });
  const transcriptPath = (): string => join(base, 'transcript.jsonl');
  const writeTranscript = (lines: string[]): void => writeFileSync(transcriptPath(), lines.map((line) => `${line}\n`).join(''));
  const run = (transcript: string | null = transcriptPath()): { code: number; stdout: string; context: string } => {
    const r = activationRoutine(JSON.stringify({ prompt: 'hey bro', session_id: SESSION, ...(transcript === null ? {} : { transcript_path: transcript }) }), env());
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } };
    return { code: r.code, stdout: r.stdout, context: out.hookSpecificOutput.additionalContext };
  };
  const baseline = (): string => {
    buildSandbox(s);
    writeTranscript([]);
    return run().stdout;
  };
  const warningLines = (context: string): string[] => context.split('\n').filter((line) => line.startsWith('⚠️'));
  const warning = (mean: number, calls: number, first: number): string =>
    `⚠️ This bro session's recent context is past its limit: ${mean} mean input context over the last ${calls} calls (limit 120000; its first call took ${first}, the cold-start reference). ${ACTION}`;

  it('warns when the last 5 calls average past 120000, naming the mean, the limit and the first call', () => {
    const clean = baseline();
    writeTranscript([
      assistantLine('m0', 90000),
      ...[130000, 125000, 121000, 119000, 126000].map((context, i) => assistantLine(`m${i + 1}`, context)),
    ]);
    const r = run();
    assert.equal(r.code, 0);
    assert.deepEqual(warningLines(r.context), [warning(124200, 5, 90000)]);
    const cleanContext = (JSON.parse(clean) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    assert.ok(r.context.startsWith(cleanContext));
  });

  it('sums input, cache creation and cache read tokens, a missing field counting 0', () => {
    buildSandbox(s);
    writeTranscript([
      JSON.stringify({ type: 'assistant', message: { id: 'u1', usage: { input_tokens: 1000, cache_creation_input_tokens: 20000, cache_read_input_tokens: 110000 } } }),
      JSON.stringify({ type: 'assistant', message: { id: 'u2', usage: { cache_read_input_tokens: 129000 } } }),
    ]);
    assert.deepEqual(warningLines(run().context), [warning(130000, 2, 131000)]);
  });

  it('pre-compaction calls near 167000 followed by 5 calls near 90000 give no warning, however many tool calls', () => {
    const clean = baseline();
    const before = Array.from({ length: 300 }, (_, i) => assistantLine(`pre-${i}`, 167000 + (i % 3)));
    const after = [88000, 91000, 90000, 92000, 89000].map((context, i) => assistantLine(`post-${i}`, context));
    const toolCalls = Array.from({ length: 400 }, (_, i) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}` }] } }));
    writeTranscript([...before, ...toolCalls, ...after]);
    assert.equal(run().stdout, clean);
  });

  it('a mean exactly at 120000 gives no warning', () => {
    const clean = baseline();
    writeTranscript([110000, 130000, 120000, 125000, 115000].map((context, i) => assistantLine(`e${i}`, context)));
    assert.equal(run().stdout, clean);
  });

  it('fewer than 5 calls average what exists', () => {
    buildSandbox(s);
    writeTranscript([assistantLine('a', 121000), assistantLine('b', 123000)]);
    assert.deepEqual(warningLines(run().context), [warning(122000, 2, 121000)]);
  });

  it('lines of one message.id count once', () => {
    buildSandbox(s);
    const fourBlocks = (id: string, context: number): string[] => Array.from({ length: 4 }, () => assistantLine(id, context));
    writeTranscript([...[60000, 60000, 60000, 60000].map((context, i) => assistantLine(`d${i}`, context)), ...fourBlocks('high', 200000)]);
    assert.deepEqual(warningLines(run().context), []);
    writeTranscript([...[150000, 150000, 150000, 150000].map((context, i) => assistantLine(`d${i}`, context)), ...fourBlocks('low', 10000)]);
    assert.deepEqual(warningLines(run().context), [warning(122000, 5, 150000)]);
  });

  it('isSidechain lines are ignored', () => {
    const clean = baseline();
    writeTranscript([
      ...[90000, 90000, 90000, 90000, 90000].map((context, i) => assistantLine(`main${i}`, context)),
      ...[500000, 500000, 500000].map((context, i) => assistantLine(`side${i}`, context, { isSidechain: true })),
    ]);
    assert.equal(run().stdout, clean);
  });

  it('unparseable lines are ignored', () => {
    buildSandbox(s);
    writeTranscript([
      assistantLine('p1', 121000),
      '{"type":"assistant","message":{"id":"broken","usage":{"input_tokens":1',
      '{"type":"assistant" not json at all',
      assistantLine('p2', 125000),
    ]);
    assert.deepEqual(warningLines(run().context), [warning(123000, 2, 121000)]);
  });

  it('<synthetic> model lines are ignored', () => {
    buildSandbox(s);
    const synthetic = (id: string): string => JSON.stringify({ type: 'assistant', message: { id, model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } });
    writeTranscript([assistantLine('s1', 125000), synthetic('z1'), synthetic('z2'), assistantLine('s2', 127000), synthetic('z3')]);
    assert.deepEqual(warningLines(run().context), [warning(126000, 2, 125000)]);
  });

  it('measures a transcript longer than the maximum string length without throwing (F350-1)', () => {
    const unit = '{"type":"user"}\n';
    const line = `${JSON.stringify({ type: 'assistant', message: { id: 'x', usage: { input_tokens: 130000 } } })}\n`;
    const k = Math.ceil(constants.MAX_STRING_LENGTH / unit.length);
    const transcript = Buffer.alloc(k * unit.length + line.length);
    transcript.fill(unit, 0, k * unit.length);
    transcript.write(line, k * unit.length);
    const recent = recentContext(transcript);
    assert.deepEqual(recent, { mean: 130000, calls: 1, first: 130000 });
    assert.equal(pastContextLimit(recent), true);
  });

  it('a line whose top-level type is not assistant is ignored, even when it quotes one', () => {
    const clean = baseline();
    writeTranscript([JSON.stringify({ type: 'user', message: { content: assistantLine('quoted', 900000) }, toolUseResult: { type: 'assistant' } })]);
    assert.equal(run().stdout, clean);
  });

  const silent: [string, () => string | null][] = [
    ['no transcript_path', () => null],
    ['a missing transcript file', () => join(base, 'missing.jsonl')],
    ['an empty transcript', () => transcriptPath()],
    ['a directory as the transcript', () => base],
  ];
  for (const [name, path] of silent) {
    it(`output stays byte-identical with ${name}`, () => {
      const clean = baseline();
      assert.equal(run(path()).stdout, clean);
    });
  }

  it('the bro row usage plays no part', () => {
    const clean = baseline();
    const db = new DatabaseSync(join(s, 'project/.claude/tmb/trajectory.db'));
    try {
      db.prepare("INSERT INTO agent_runs (agent_type, session_id, tool_uses, cache_read_tokens) VALUES ('bro', ?, 500, 90000000)").run(SESSION);
    } finally {
      db.close();
    }
    assert.equal(run().stdout, clean);
  });
});

function assistantLine(id: string, context: number, extra: object = {}): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'assistant',
    message: { id, role: 'assistant', usage: { input_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: context - 3, output_tokens: 50 } },
    ...extra,
  });
}

describe("activation-routine's grep", () => {
  const c = new LocaleGrep(false);
  const utf8 = new LocaleGrep(true);
  const says = (grep: LocaleGrep, text: string): boolean => grep.test(Buffer.from(`${text}\n`), grep.regex('\\bbro\\b', true));

  it('reads \\b with ASCII word bytes in C and Unicode letters and digits under UTF-8', () => {
    assert.equal(says(c, 'ébro'), true);
    assert.equal(says(utf8, 'ébro'), false);
    assert.equal(says(utf8, '١bro'), false);
    for (const grep of [c, utf8]) {
      assert.equal(says(grep, 'Hey BRO!'), true);
      assert.equal(says(grep, 'bro_x'), false);
      assert.equal(says(grep, 'brother'), false);
    }
  });

  it('never matches a line with invalid UTF-8 under UTF-8', () => {
    const line = Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from(' Entering bro mode.\nok\n')]);
    assert.equal(c.test(line, c.regex('Entering bro mode.')), true);
    assert.equal(utf8.test(line, utf8.regex('Entering bro mode.')), false);
    assert.equal(utf8.test(line, utf8.regex('^ok$')), true);
  });

  it("counts letters newer than macOS's grep tables as word characters (U+A7CB), so bro next to one is no word", () => {
    assert.equal(says(utf8, 'Ɤbro'), false);
  });

  it('runs as grep does under setlocale: LC_ALL=UTF-8 alone fails it and grep runs in C', () => {
    assert.equal(setlocaleUtf8({ LC_ALL: 'en_US.UTF-8' }), true);
    assert.equal(setlocaleUtf8({ LC_ALL: 'UTF-8' }), false);
    assert.equal(setlocaleUtf8({ LC_CTYPE: 'UTF-8' }), true);
    assert.equal(setlocaleUtf8({ LC_ALL: 'C' }), false);
    assert.equal(setlocaleUtf8({}), false);
  });
});

describe('jq 1.7 number literals', () => {
  it('prints a literal as jq does', () => {
    const cases: [string, string][] = [
      ['0.00', '0.00'],
      ['7e1', '7E+1'],
      ['1.23e-7', '1.23E-7'],
      ['0.000001', '0.000001'],
      ['0.0000001', '1E-7'],
      ['123.456e3', '123456'],
      ['-0.0', '-0.0'],
      ['-0', '-0'],
      ['1e1000', '1E+1000'],
      ['12345678901234567890123456789012345678901234567890', '12345678901234567890123456789012345678901234567890'],
      ['0e5', '0E+5'],
      ['1.5e+0', '1.5'],
      ['100e-2', '1.00'],
    ];
    for (const [literal, printed] of cases) assert.equal(jqNumberLiteral(literal), printed, literal);
  });

  it('keeps literals in the session log and the debug args', () => {
    assert.equal(logLines('{"prompt":1.000,"additionalContext":[1E2,-0]}\n', 'T'), '{"ts":"T","event":"user_prompt","prompt":1.000,"additional_context":[1E+2,-0]}\n');
    assert.equal(argsJson('{"tool_input":{"n":1.50}} 5 {"tool_input":null}\n'), '{"n":1.50}\n{}');
  });
});
