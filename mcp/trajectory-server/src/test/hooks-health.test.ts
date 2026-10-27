/**
 * The health and drift hook gates (GH 1692): their jq, bash and ps helpers,
 * and each documented divergence from scripts/hooks/<gate>.sh — the gate runs
 * where the .sh degrades for lack of jq or the sqlite3 CLI, and orders install
 * rows by bytes in every locale where the .sh's sort follows LC_ALL.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { eventName, mcpHealthCheck, NOT_DETECTED, sampleCount } from '../hooks/mcp-health-check.js';
import { deferredToolsDriftWarn, epochOperand, etimeSeconds, isCcCommand, newerJs } from '../hooks/deferred-tools-drift-warn.js';
import { noRemoteUrl, substratePreflight } from '../hooks/substrate-preflight.js';
import { candidateDirs, listsClaudeDir } from '../hooks/ensure-gitignore.js';
import { broTurnUsage, jqCompare, jqIntText } from '../hooks/bro-turn-usage.js';
import { duplicateInstalls, userInstalls } from '../hooks/lib/install.js';

const SCHEMA = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../src/schema.sql'), 'utf8');
const NO_COMMANDS = '/nonexistent-tmb-path';
const OLD = new Date('2020-01-01T00:00:00Z');
const NEW = new Date('2090-01-01T00:00:00Z');

function write(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

function trajectoryDb(path: string, repos: [string, string][] = []): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(SCHEMA);
    for (const [name, p] of repos) db.prepare('INSERT INTO repos (name, path) VALUES (?, ?)').run(name, p);
  } finally {
    db.close();
  }
}

let dir: string;
before(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-health-unit-')));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('mcp-health-check helpers', () => {
  it('sampleCount reads digits, defaults to 3 and samples nothing past int64', () => {
    assert.equal(sampleCount(undefined), 3);
    assert.equal(sampleCount(''), 3);
    assert.equal(sampleCount('2x'), 3);
    assert.equal(sampleCount('0'), 0);
    assert.equal(sampleCount('05'), 5);
    assert.equal(sampleCount('99999999999999999999'), 0);
  });

  it('eventName follows the jq alternatives per JSON value', () => {
    assert.equal(eventName('{"hook_event_name":"SessionStart","event":"x"}'), 'SessionStart');
    assert.equal(eventName('{"hookEventName":"Stop"}'), 'Stop');
    assert.equal(eventName('{"hook_event_name":false,"event":"E"}'), 'E');
    assert.equal(eventName('{}'), 'unknown');
    assert.equal(eventName('null'), 'unknown');
    assert.equal(eventName('not json'), 'unknown');
    assert.equal(eventName('{"hook_event_name":5} {"event":"A"}'), '5\nA');
  });
});

describe('deferred-tools-drift-warn helpers', () => {
  it('etimeSeconds reads [DD-][HH:]MM:SS base 10 and rejects non-digits', () => {
    assert.equal(etimeSeconds('01-02:03:04'), 93_784n);
    assert.equal(etimeSeconds('08:09'), 489n);
    assert.equal(etimeSeconds('09:08:07'), 32_887n);
    assert.throws(() => etimeSeconds('ab:cd'));
  });

  it('epochOperand parses as strtoq base 0', () => {
    assert.equal(epochOperand('1700000000'), 1_700_000_000n);
    assert.equal(epochOperand('0x10'), 16n);
    assert.equal(epochOperand('010'), 8n);
    assert.equal(epochOperand('-5'), -5n);
    assert.equal(epochOperand(' 12'), 12n);
    assert.equal(epochOperand('soon'), null);
    assert.equal(epochOperand('12s'), null);
  });

  it('isCcCommand matches the .sh case patterns', () => {
    for (const cmd of ['claude', 'claude --resume', '/usr/local/bin/claude', '/opt/claude -p x']) assert.ok(isCcCommand(cmd), cmd);
    for (const cmd of ['claudex', 'node claude.js', '-zsh', '']) assert.ok(!isCcCommand(cmd), cmd);
  });

  it('newerJs counts .js paths strictly newer than the reference, without following links', () => {
    const tools = join(dir, 'tools');
    write(join(tools, 'old.js'), '');
    write(join(tools, 'new.js'), '');
    write(join(tools, 'deep/x/new.js'), '');
    write(join(tools, 'new.txt'), '');
    utimesSync(join(tools, 'old.js'), OLD, OLD);
    for (const f of ['new.js', 'deep/x/new.js', 'new.txt']) utimesSync(join(tools, f), NEW, NEW);
    assert.equal(newerJs(tools, 1_700_000_000n * 1_000_000_000n), 2);
    assert.equal(newerJs(tools, BigInt(NEW.getTime()) * 1_000_000n), 0);
  });

  it('an arithmetic error in the elapsed time allows silently, as the .sh does', () => {
    const bin = join(dir, 'ps-octal');
    write(join(bin, 'ps'), '#!/bin/sh\necho 08\n', 0o755);
    const tools = join(dir, 'tools-arith');
    write(join(tools, 'new.js'), '');
    utimesSync(join(tools, 'new.js'), NEW, NEW);
    const r = deferredToolsDriftWarn('{}', { PATH: bin, TMB_MCP_PID_OVERRIDE: '5', TMB_TOOL_DIR_OVERRIDE: tools });
    assert.deepEqual(r, { stdout: '', code: 0 });
  });

  it('divergence: warns without jq on PATH, where the .sh exits 127', () => {
    const tools = join(dir, 'tools-nojq');
    write(join(tools, 'new.js'), '');
    utimesSync(join(tools, 'new.js'), NEW, NEW);
    const r = deferredToolsDriftWarn('{}', {
      PATH: NO_COMMANDS,
      TMB_MCP_PID_OVERRIDE: '9',
      TMB_MCP_START_OVERRIDE: '1700000000',
      TMB_TOOL_DIR_OVERRIDE: tools,
    });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } };
    assert.match(out.hookSpecificOutput.additionalContext, /^\[tmb deferred-tools drift\] 1 MCP tool source file\(s\).*\(PID 9\)/);
  });
});

describe('substrate-preflight helpers', () => {
  it('noRemoteUrl is the jq test printing false', () => {
    assert.equal(noRemoteUrl('[]'), true);
    assert.equal(noRemoteUrl('[{"url":""},{"url":null}]'), true);
    assert.equal(noRemoteUrl('[{"url":""},{"url":"git@x:y"}]'), false);
    assert.equal(noRemoteUrl('not json'), false);
  });

  it('names every missing probe in one banner, escaped as the .sh escapes it', () => {
    const r = substratePreflight('{}', { PATH: NO_COMMANDS });
    assert.equal(r.code, 0);
    const ctx = (JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    assert.ok(ctx.startsWith('TMB DEGRADED: missing jq — '), ctx);
    for (const bin of ['sqlite3', 'git', 'node']) assert.ok(ctx.includes(`missing ${bin} — `), bin);
  });
});

describe('ensure-gitignore helpers', () => {
  it('listsClaudeDir is grep -E ^\\.claude(/\\*?)?$ per line', () => {
    for (const text of ['.claude\n', 'x\n.claude/\n', '.claude/*']) assert.ok(listsClaudeDir(text), JSON.stringify(text));
    for (const text of ['.claude/\r\n', ' .claude', 'a/.claude', '.claude/**', '']) assert.ok(!listsClaudeDir(text), JSON.stringify(text));
  });

  it('divergence: reads the repos table without the sqlite3 CLI', () => {
    const project = join(dir, 'gi-project');
    trajectoryDb(join(project, '.claude/tmb/trajectory.db'), [
      ['rel', 'repos/données'],
      ['abs', join(dir, 'gi-abs')],
    ]);
    const dirs = candidateDirs({ PATH: NO_COMMANDS, CLAUDE_PROJECT_DIR: project, HOME: dir });
    assert.deepEqual(dirs, [project, `${project}/repos/données`, join(dir, 'gi-abs')]);
  });
});

describe('bro-turn-usage helpers', () => {
  it('jqIntText prints integers as jq 1.7 tostring does', () => {
    assert.equal(jqIntText(0), '0');
    assert.equal(jqIntText(-0), '-0');
    assert.equal(jqIntText(123), '123');
    assert.equal(jqIntText(1e16), '1e+16');
    assert.equal(jqIntText(123456789012345678901), '123456789012345680000');
    assert.equal(jqIntText(1e300), '1e+300');
  });

  it('jqCompare is jq order: null < false < true < numbers < strings by bytes < arrays < objects', () => {
    const sorted = [{}, [], 'é', 'z', 'Z', 2, 1, true, false, null].sort(jqCompare);
    assert.deepEqual(sorted, [null, false, true, 1, 2, 'Z', 'z', 'é', [], {}]);
    assert.ok(jqCompare([1, 'a'], [1, 'b']) < 0);
    assert.ok(jqCompare({ a: 1 }, { b: 0 }) < 0);
  });

  it('divergence: meters the session without jq or the sqlite3 CLI', () => {
    const db = join(dir, 'btu/.claude/tmb/trajectory.db');
    trajectoryDb(db);
    const transcript = join(dir, 'btu/transcript.jsonl');
    write(
      transcript,
      `${JSON.stringify({ timestamp: '2026-10-01T10:00:00Z', message: { id: 'm', model: 'claude-x', usage: { input_tokens: 2, output_tokens: 3 } } })}\n`,
    );
    const r = broTurnUsage(JSON.stringify({ session_id: 'unit-session', transcript_path: transcript }), {
      PATH: NO_COMMANDS,
      TRAJECTORY_DB_PATH: db,
      HOME: dir,
    });
    assert.deepEqual(r, { stdout: '', code: 0 });
    const read = new DatabaseSync(db, { readOnly: true });
    try {
      const row = read.prepare("SELECT tokens_in, tokens_out, model, root_dir FROM agent_runs WHERE agent_type = 'bro'").get();
      assert.deepEqual({ ...row }, { tokens_in: 2, tokens_out: 3, model: 'claude-x', root_dir: join(dir, 'btu') });
    } finally {
      read.close();
    }
  });
});

describe('install resolution', () => {
  const installs = (body: unknown): NodeJS.ProcessEnv => {
    const json = join(dir, `installs-${Math.random().toString(36).slice(2)}.json`);
    write(json, JSON.stringify(body));
    return { TMB_INSTALLED_JSON: json, HOME: join(dir, 'install-home'), LC_ALL: 'en_US.UTF-8', PATH: NO_COMMANDS };
  };

  it('divergence: duplicate copies sort by marketplace bytes in every locale', () => {
    const cache = join(dir, 'cache');
    mkdirSync(cache, { recursive: true });
    write(join(dir, 'install-home/.claude/settings.json'), '{"enabledPlugins":{"tmb@alpha":true,"tmb@Zeta":true}}');
    const env = installs({
      plugins: {
        'tmb@alpha': [{ scope: 'user', installPath: cache, version: '1.0.0' }],
        'tmb@Zeta': [{ scope: 'user', installPath: cache, version: '2.0.0' }],
      },
    });
    const rows = duplicateInstalls(join(dir, 'install-project'), env);
    assert.deepEqual(rows.map((r) => r.marketplace), ['Zeta', 'alpha']);
  });

  it('user installs run newest first without jq', () => {
    const cache = join(dir, 'cache');
    mkdirSync(cache, { recursive: true });
    const env = installs({
      plugins: {
        'tmb@a': [{ scope: 'user', installPath: cache, installedAt: '2026-01-01', version: '1' }],
        'tmb@b': [{ scope: 'user', installPath: cache, installedAt: '2026-02-01', version: '2' }],
        'tmb@c': [{ scope: 'user', installPath: join(dir, 'gone'), installedAt: '2026-03-01', version: '3' }],
      },
    });
    assert.deepEqual(userInstalls(env).map((r) => r.version), ['2', '1']);
  });
});

describe('mcp-health-check divergence', () => {
  it('notes a missing server without jq on PATH, where the .sh exits silently', () => {
    const bin = join(dir, 'pgrep-down');
    write(join(bin, 'pgrep'), '#!/bin/sh\nexit 1\n', 0o755);
    const r = mcpHealthCheck('{"hook_event_name":"SessionStart","session_id":"s"}', {
      PATH: bin,
      HOME: dir,
      CLAUDE_PROJECT_DIR: join(dir, 'no-project'),
      TMB_INSTALLED_JSON: join(dir, 'none.json'),
      TMB_MCP_HEALTH_SAMPLES: '1',
    });
    assert.equal(r.code, 0);
    const ctx = (JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    assert.equal(ctx, NOT_DETECTED);
  });
});
