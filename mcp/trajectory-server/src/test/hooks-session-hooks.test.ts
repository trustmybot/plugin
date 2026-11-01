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
import { activationRoutine, HALT_TEXT, LocaleGrep } from '../hooks/activation-routine.js';
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
  const withDb = (use: (db: DatabaseSync) => void): void => {
    const db = new DatabaseSync(join(s, 'project/.claude/tmb/trajectory.db'));
    try {
      use(db);
    } finally {
      db.close();
    }
  };
  const seedRow = (toolUses: number | null, cacheRead: number | null, agentType = 'bro', session = SESSION): void => {
    withDb((db) => {
      db.prepare('INSERT INTO agent_runs (agent_type, session_id, tool_uses, cache_read_tokens) VALUES (?, ?, ?, ?)').run(agentType, session, toolUses, cacheRead);
    });
  };
  const run = (session = SESSION): { code: number; stdout: string; context: string } => {
    const r = activationRoutine(JSON.stringify({ prompt: 'hey bro', session_id: session }), env());
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } };
    return { code: r.code, stdout: r.stdout, context: out.hookSpecificOutput.additionalContext };
  };
  const baseline = (): string => {
    buildSandbox(s);
    return run().stdout;
  };
  const warningLines = (context: string): string[] => context.split('\n').filter((line) => line.startsWith('⚠️'));

  it('warns past 150 tool calls with the count, the limit and the action', () => {
    const clean = baseline();
    seedRow(151, 0);
    const r = run();
    assert.equal(r.code, 0);
    assert.deepEqual(warningLines(r.context), [`⚠️ This bro session is past its usage limits: 151 tool calls (limit 150). ${ACTION}`]);
    const cleanContext = (JSON.parse(clean) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    assert.ok(r.context.startsWith(cleanContext));
  });

  it('warns past 60000 context per call with the figure and the limit', () => {
    buildSandbox(s);
    seedRow(10, 700000);
    assert.deepEqual(warningLines(run().context), [`⚠️ This bro session is past its usage limits: 70000 context per call (limit 60000). ${ACTION}`]);
  });

  it('carries both limits on a single line', () => {
    buildSandbox(s);
    seedRow(200, 14000000);
    assert.deepEqual(warningLines(run().context), [
      `⚠️ This bro session is past its usage limits: 200 tool calls (limit 150), 70000 context per call (limit 60000). ${ACTION}`,
    ]);
  });

  const silent: [string, () => void][] = [
    ['no row', () => {}],
    ['exactly at both limits', () => seedRow(150, 9000000)],
    ['zero tool_uses', () => seedRow(0, 9000000)],
    [
      'NULL tool_uses in a table without the NOT NULL',
      () => {
        withDb((db) => db.exec('DROP TABLE agent_runs; CREATE TABLE agent_runs (id INTEGER PRIMARY KEY, agent_type TEXT, task_id INTEGER, session_id TEXT, tool_uses INTEGER, cache_read_tokens INTEGER)'));
        seedRow(null, 9000000);
      },
    ],
    ["another session's row", () => seedRow(500, 0, 'bro', 'other-session-01')],
    ['a swe row in this session', () => seedRow(500, 0, 'swe')],
  ];
  for (const [name, seed] of silent) {
    it(`output stays byte-identical with ${name}`, () => {
      const clean = baseline();
      seed();
      assert.equal(run().stdout, clean);
    });
  }

  it('a failed read keeps the normal context and exit 0, and never denies', () => {
    const clean = baseline();
    withDb((db) => db.exec('DROP TABLE agent_runs'));
    const r = run();
    assert.equal(r.code, 0);
    assert.equal(r.stdout, clean);
    assert.ok(!r.stdout.includes('permissionDecision'));
  });

  it('a session id that fails validation on any line never reaches the query', () => {
    buildSandbox(s);
    seedRow(500, 0);
    assert.deepEqual(warningLines(run(`${SESSION}\n' OR 1=1 --`).context), []);
  });
});

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
