// node:test suite for l6-chain-helpers.ts: the runs root (run-l6-chain.sh's self-test cases), HOME
// isolation and its leak check, the sandboxed step launch, seeds, snapshots, the doctor, the
// multi-turn step against a stub claude, and the chain summary. No test calls the real claude.
// Run: node --experimental-strip-types --experimental-sqlite --test tests/l5-l6/lib/l6-chain-helpers.test.ts

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';
import { l5ComposeTestPrompt, PLUGIN_ROOT } from './flow-helpers.ts';
import {
  DISABLE_PROJECT_TRAJECTORY_SERVER,
  l6cApplySeed,
  l6cAssertHomeClean,
  l6cClaudeArgs,
  l6cIsolateHome,
  l6cLaunchStep,
  l6cResolveRunsRoot,
  l6cRunStep,
  l6cScoreStep,
  l6cSnapshotDb,
  l6cTrajectoryDoctor,
  l6cUuid,
  l6cWriteChainSummary,
  lastAssistantText,
} from './l6-chain-helpers.ts';
import { STUBS_DIR } from './sandbox.ts';

const HAVE_SQLITE3 = spawnSync('sqlite3', ['-version']).status === 0;

const roots: string[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = 'tmb-l6c-test.'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function quietStderr<T>(fn: () => T): { value: T; stderr: string } {
  const write = process.stderr.write.bind(process.stderr);
  let stderr = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: fn(), stderr };
  } finally {
    process.stderr.write = write;
  }
}

function quietStdout<T>(fn: () => T): { value: T; stdout: string } {
  const write = process.stdout.write.bind(process.stdout);
  let stdout = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    return { value: fn(), stdout };
  } finally {
    process.stdout.write = write;
  }
}

const STUB_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
const record = process.env.STUB_RECORD;
const calls = fs.existsSync(record) ? fs.readFileSync(record, 'utf8').split('\\n').filter(Boolean).length : 0;
fs.appendFileSync(record, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), debug: process.env.TMB_DEBUG_TRAJECTORY }) + '\\n');
const text = (process.env.STUB_TEXTS || '').split('|')[calls] || 'plain reply';
process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', duration_ms: 42 }) + '\\n');
process.stderr.write('stub stderr ' + calls + '\\n');
`;

function stubClaudeEnv(extra: NodeJS.ProcessEnv = {}): { env: NodeJS.ProcessEnv; record: string } {
  const bin = tempDir('tmb-l6c-bin.');
  writeFileSync(join(bin, 'claude'), STUB_CLAUDE);
  chmodSync(join(bin, 'claude'), 0o755);
  const record = join(bin, 'record.jsonl');
  return { env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, STUB_RECORD: record, ...extra }, record };
}

function calls(record: string): { argv: string[]; cwd: string; debug?: string }[] {
  if (!existsSync(record)) return [];
  return readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const mainCheckout = dirname(
  spawnSync('git', ['-C', import.meta.dirname, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).stdout.trim(),
);

describe('l6cResolveRunsRoot (run-l6-chain.sh:83-87)', () => {
  const env = { ...process.env };
  delete env.L6C_RUNS_DIR;
  delete env.CLAUDE_PROJECT_DIR;

  test('runs root under CLAUDE_PROJECT_DIR', () => {
    assert.equal(l6cResolveRunsRoot(PLUGIN_ROOT, { ...env, CLAUDE_PROJECT_DIR: '/proj/x' }), '/proj/x/.claude/tmb/l6-chain-runs');
  });

  test('runs root under the main checkout', () => {
    assert.equal(l6cResolveRunsRoot(PLUGIN_ROOT, env), `${mainCheckout}/.claude/tmb/l6-chain-runs`);
  });

  test('L6C_RUNS_DIR overrides', () => {
    assert.equal(l6cResolveRunsRoot(PLUGIN_ROOT, { ...env, L6C_RUNS_DIR: '/override/runs', CLAUDE_PROJECT_DIR: '/proj/x' }), '/override/runs');
  });
});

describe('l6cIsolateHome', () => {
  function clean(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...extra };
    return env;
  }

  test('HOME moves to <run_dir>/home (0700) and the real model cache stays reachable', () => {
    const root = tempDir();
    mkdirSync(join(root, 'real-home', '.cache', 'huggingface'), { recursive: true });
    const base = clean({ HOME: join(root, 'real-home') });
    const env = l6cIsolateHome(join(root, 'run'), base);
    const cache = join(root, 'real-home', '.cache', 'huggingface');
    assert.equal(env.HOME, join(root, 'run', 'home'));
    assert.equal(statSync(join(root, 'run', 'home')).mode & 0o777, 0o700);
    assert.deepEqual([env.TMB_MODEL_CACHE_DIR, env.HF_HOME, env.TRANSFORMERS_CACHE], [cache, cache, cache]);
    assert.equal(base.HOME, join(root, 'real-home'));
    assert.equal(base.TMB_MODEL_CACHE_DIR, undefined);
  });

  test('bun and mise caches go to <run_dir>/tool-state; mise installs and config point at the real HOME', () => {
    const root = tempDir();
    mkdirSync(join(root, 'real-home', '.local', 'share', 'mise'), { recursive: true });
    mkdirSync(join(root, 'real-home', '.config', 'mise'), { recursive: true });
    const run = join(root, 'run');
    const env = l6cIsolateHome(run, clean({ HOME: join(root, 'real-home') }));
    assert.equal(env.BUN_INSTALL_CACHE_DIR, `${run}/tool-state/bun-install-cache`);
    assert.equal(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH, `${run}/tool-state/bun-transpiler-cache`);
    assert.equal(env.MISE_STATE_DIR, `${run}/tool-state/mise-state`);
    assert.equal(env.MISE_CACHE_DIR, `${run}/tool-state/mise-cache`);
    assert.equal(env.MISE_DATA_DIR, `${root}/real-home/.local/share/mise`);
    assert.equal(env.MISE_CONFIG_DIR, `${root}/real-home/.config/mise`);
    assert.equal(env.TMB_MODEL_CACHE_DIR, undefined);
  });

  test('values already set win, and an existing home dir is re-chmodded', () => {
    const root = tempDir();
    mkdirSync(join(root, 'run', 'home'), { recursive: true, mode: 0o755 });
    const env = l6cIsolateHome(join(root, 'run'), clean({ HOME: join(root, 'real-home'), HF_HOME: '/hf', BUN_INSTALL_CACHE_DIR: '/bun' }));
    assert.deepEqual([env.TMB_MODEL_CACHE_DIR, env.HF_HOME, env.TRANSFORMERS_CACHE, env.BUN_INSTALL_CACHE_DIR], ['/hf', '/hf', '/hf', '/bun']);
    assert.equal(statSync(join(root, 'run', 'home')).mode & 0o777, 0o700);
    assert.equal(env.MISE_DATA_DIR, undefined);
  });
});

describe('l6cAssertHomeClean', () => {
  test('an absent HOME or one holding only .cache/huggingface is clean', () => {
    const root = tempDir();
    assert.equal(l6cAssertHomeClean(join(root, 'none')), 0);
    mkdirSync(join(root, 'home', '.cache', 'huggingface', 'models'), { recursive: true });
    writeFileSync(join(root, 'home', '.cache', 'huggingface', 'models', 'm.bin'), '');
    assert.equal(l6cAssertHomeClean(join(root, 'home')), 0);
  });

  test('any other entry fails and is listed relative to $HOME', () => {
    const root = tempDir();
    const home = join(root, 'home');
    mkdirSync(join(home, '.cache', 'huggingface'), { recursive: true });
    mkdirSync(join(home, '.cache', 'other'), { recursive: true });
    writeFileSync(join(home, '.bashrc'), '');
    const { value, stderr } = quietStderr(() => l6cAssertHomeClean(home));
    assert.equal(value, 1);
    assert.match(stderr, new RegExp(`the chain wrote under its isolated HOME ${home}`));
    assert.match(stderr, /^ {2}\$HOME\/\.bashrc$/m);
    assert.match(stderr, /^ {2}\$HOME\/\.cache\/other$/m);
    assert.doesNotMatch(stderr, /huggingface$/m);
    assert.doesNotMatch(stderr, /^ {2}\$HOME\/\.cache$/m);
  });
});

describe('l6cLaunchStep', () => {
  test('the runner sees the sandbox HOME and the chain HOME it restores afterwards', () => {
    const root = tempDir();
    const project = join(root, 'project');
    mkdirSync(project);
    let seen: NodeJS.ProcessEnv = {};
    let args: string[] = [];
    const restored = l6cLaunchStep(
      (p, row, out, env) => {
        seen = env;
        args = [p, row, out];
      },
      project,
      join(root, 'row'),
      join(root, 'turn.jsonl'),
      { PATH: process.env.PATH, HOME: join(root, 'chain-home'), GH_TOKEN: 'x' },
    );
    assert.deepEqual(args, [project, join(root, 'row'), join(root, 'turn.jsonl')]);
    assert.equal(seen.HOME, join(project, '_home'));
    assert.equal(seen.TMB_SANDBOX_ORIG_HOME, join(root, 'chain-home'));
    assert.equal(seen.PATH?.split(delimiter)[0], STUBS_DIR);
    assert.equal(restored.HOME, join(root, 'chain-home'));
    assert.equal(restored.PATH, process.env.PATH);
    assert.equal(restored.GH_TOKEN, undefined);
    assert.equal(existsSync(`${project}_remote.git`), false);
  });

  test('the remote is removed when the runner throws', () => {
    const root = tempDir();
    const project = join(root, 'project');
    mkdirSync(project);
    assert.throws(() =>
      l6cLaunchStep(
        () => {
          throw new Error('boom');
        },
        project,
        root,
        join(root, 'o'),
        { PATH: process.env.PATH, HOME: root },
      ),
    );
    assert.equal(existsSync(`${project}_remote.git`), false);
  });
});

describe('l6cApplySeed and l6cSnapshotDb', () => {
  test('an empty, null or missing seed returns 0 without touching the DB', () => {
    const project = tempDir();
    assert.equal(l6cApplySeed(project, ''), 0);
    assert.equal(l6cApplySeed(project, 'null'), 0);
    const { value, stderr } = quietStderr(() => l6cApplySeed(project, join(project, 'missing.sql')));
    assert.equal(value, 0);
    assert.match(stderr, /seed not found, skipping: .*missing\.sql/);
    assert.equal(existsSync(join(project, '.claude', 'tmb', 'trajectory.db')), false);
  });

  test('a seed runs against the DB and the snapshot dumps it', { skip: !HAVE_SQLITE3 && 'sqlite3 not installed' }, () => {
    const project = tempDir();
    mkdirSync(join(project, '.claude', 'tmb'), { recursive: true });
    const seed = join(project, 'seed.sql');
    writeFileSync(seed, "CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('seeded');\n");
    assert.equal(l6cApplySeed(project, seed), 0);
    const db = new DatabaseSync(join(project, '.claude', 'tmb', 'trajectory.db'));
    assert.deepEqual({ ...db.prepare('SELECT v FROM t').get() }, { v: 'seeded' });
    db.close();
    l6cSnapshotDb(project, join(project, 'snap.sql'));
    assert.match(readFileSync(join(project, 'snap.sql'), 'utf8'), /INSERT INTO t VALUES\('seeded'\);/);
  });

  test('a snapshot that cannot read the DB writes the failure note', () => {
    const project = tempDir();
    l6cSnapshotDb(project, join(project, 'snap.sql'));
    assert.equal(readFileSync(join(project, 'snap.sql'), 'utf8'), '-- snapshot failed: trajectory.db missing or unreadable\n');
  });
});

describe('l6cTrajectoryDoctor', () => {
  test('an unhealthy DB returns non-zero and prints the indented report', () => {
    const root = tempDir();
    const report = join(root, 'doctor.json');
    const { value, stdout } = quietStdout(() => l6cTrajectoryDoctor(join(root, 'missing.db'), report));
    assert.notEqual(value, 0);
    assert.ok(existsSync(report));
    assert.match(stdout, new RegExp(`✗ trajectory_doctor: ${root}/missing.db is unhealthy \\(exit ${value}\\)`));
  });
});

describe('l6cUuid', () => {
  test('emits a lowercase UUID, fresh each call', () => {
    const a = l6cUuid();
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notEqual(a, l6cUuid());
  });
});

describe('l6cClaudeArgs', () => {
  test('a fresh --session-id first, the project-scoped trajectory-server disabled, the prompt last', () => {
    const args = l6cClaudeArgs('/plugin', 'hello', 'sid');
    assert.deepEqual(args.slice(0, 4), ['--session-id', 'sid', '--plugin-dir', '/plugin']);
    assert.equal(args[args.indexOf('--settings') + 1], '{"disabledMcpjsonServers":["trajectory-server"]}');
    assert.equal(DISABLE_PROJECT_TRAJECTORY_SERVER, '{"disabledMcpjsonServers":["trajectory-server"]}');
    assert.deepEqual(args.slice(-2), ['-p', 'hello']);
  });
});

describe('lastAssistantText', () => {
  test('joins the text blocks of assistant events and keeps the last 4000 bytes', () => {
    const root = tempDir();
    const log = join(root, 'log.jsonl');
    const ev = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }, { type: 'tool_use' }] } });
    writeFileSync(log, `${ev('first')}\n${JSON.stringify({ type: 'user' })}\n${ev('x'.repeat(5000))}\n`);
    const text = lastAssistantText(log);
    assert.equal(Buffer.byteLength(text), 3999);
    assert.equal(lastAssistantText(join(root, 'none')), '');
  });
});

describe('l6cRunStep (stub claude)', () => {
  function row(script?: object): string {
    const dir = tempDir('tmb-l6c-row.');
    writeFileSync(join(dir, 'prompt.txt'), 'do the row\n');
    if (script) writeFileSync(join(dir, 'script.json'), JSON.stringify(script));
    return dir;
  }

  test('no script.json: one turn with the composed prompt, run in the project', () => {
    const project = tempDir();
    const out = join(project, 'turn.jsonl');
    const { env, record } = stubClaudeEnv();
    const { stderr } = quietStderr(() => l6cRunStep(project, row(), out, { pluginRoot: '/plugin', env }));
    const got = calls(record);
    assert.equal(got.length, 1);
    assert.equal(got[0].argv.at(-1), l5ComposeTestPrompt('do the row'));
    assert.equal(got[0].argv[got[0].argv.indexOf('--plugin-dir') + 1], '/plugin');
    assert.equal(got[0].argv[got[0].argv.indexOf('--settings') + 1], DISABLE_PROJECT_TRAJECTORY_SERVER);
    assert.equal(got[0].debug, '1');
    assert.equal(got[0].cwd, realpathSync(project));
    assert.match(stderr, /^ {2}\[claude-err\] stub stderr 0$/m);
    assert.equal(readFileSync(out, 'utf8').split('\n').filter(Boolean).length, 2);
    assert.equal(existsSync(`${out}.turn1`), false);
  });

  test('user_after_bro drives later turns, each a fresh session, until the replies run out', () => {
    const project = tempDir();
    const out = join(project, 'turn.jsonl');
    const { env, record } = stubClaudeEnv();
    quietStderr(() => l6cRunStep(project, row({ max_turns: 5, user_after_bro: ['second', 'third'] }), out, { env }));
    const got = calls(record);
    assert.deepEqual(
      got.map((c) => c.argv.at(-1)),
      [l5ComposeTestPrompt('do the row'), 'second', 'third'],
    );
    assert.equal(new Set(got.map((c) => c.argv[1])).size, 3);
    assert.equal(readFileSync(out, 'utf8').split('\n').filter(Boolean).length, 6);
  });

  test('max_turns caps the turns', () => {
    const project = tempDir();
    const { env, record } = stubClaudeEnv();
    quietStderr(() => l6cRunStep(project, row({ max_turns: 2, user_after_bro: ['a', 'b', 'c'] }), join(project, 'o.jsonl'), { env }));
    assert.equal(calls(record).length, 2);
  });

  test('a terminal_pattern match in bro text ends the step early', () => {
    const project = tempDir();
    const { env, record } = stubClaudeEnv({ STUB_TEXTS: 'still working|ALL DONE now|never' });
    const script = { max_turns: 5, user_after_bro: ['a', 'b', 'c'], terminal_pattern: 'ALL (DONE|FINISHED)' };
    quietStderr(() => l6cRunStep(project, row(script), join(project, 'o.jsonl'), { env }));
    assert.equal(calls(record).length, 2);
    assert.equal(existsSync(join(project, 'o.jsonl.turn2')), false);
  });
});

describe('l6cScoreStep', () => {
  test('returns the score-all fail count: 0 when every opt-in scorer config is absent', () => {
    const root = tempDir();
    assert.equal(l6cScoreStep(join(root, 'none'), 'step', join(root, 'none'), 'run'), 0);
  });
});

describe('l6cWriteChainSummary', () => {
  test('one table row per result line, notes defaulting to empty', () => {
    const root = tempDir();
    const runDir = join(root, 'run-42');
    mkdirSync(runDir);
    const results = join(root, 'results.jsonl');
    writeFileSync(
      results,
      [
        JSON.stringify({ id: '01', name: 'cold-start', status: 'pass', scorer_fails: 0, tokens: 100, duration_ms: 5, notes: 'ok' }),
        '',
        JSON.stringify({ id: '02', name: 'next', status: 'fail', scorer_fails: 2, tokens: 9, duration_ms: 7, notes: null }),
      ].join('\n') + '\n',
    );
    l6cWriteChainSummary(runDir, results);
    assert.equal(
      readFileSync(join(runDir, 'chain-summary.md'), 'utf8'),
      '# L6 chain summary — run-42\n\n' +
        '| #  | Row | Status | Scorer fails | Tokens | Duration (ms) | Notes |\n' +
        '|----|-----|--------|--------------|--------|----------------|-------|\n' +
        '| 01 | cold-start | pass | 0 | 100 | 5 | ok |\n' +
        '| 02 | next | fail | 2 | 9 | 7 |  |\n',
    );
  });
});
