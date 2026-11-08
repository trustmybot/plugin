// node:test suite for smoke-helpers.ts: the throwaway smoke DB, the MCP smoke against stub and
// real server entrypoints, and the auth and plugin-load smokes against a stub claude on PATH.
// The pre-flight's exit path runs in a child process. No test calls the real claude.
// Run: node --experimental-strip-types --experimental-sqlite --test tests/l5-l6/lib/smoke-helpers.test.ts

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  l5SmokeClaudeAuth,
  l5SmokeClaudePluginLoad,
  l5SmokeCleanupDb,
  l5SmokeIsolateDb,
  l5SmokeMcp,
} from './smoke-helpers.ts';

const roots: string[] = [];
after(() => {
  l5SmokeCleanupDb();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = 'tmb-smoke-test.'): string {
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

function fakePlugin(indexJs: string): string {
  const root = tempDir('tmb-smoke-plugin.');
  mkdirSync(join(root, 'mcp', 'trajectory-server', 'dist'), { recursive: true });
  writeFileSync(join(root, 'mcp', 'trajectory-server', 'dist', 'index.js'), indexJs);
  return root;
}

function stubClaude(body: string): { env: NodeJS.ProcessEnv; record: string } {
  const bin = tempDir('tmb-smoke-bin.');
  const record = join(bin, 'record.jsonl');
  writeFileSync(
    join(bin, 'claude'),
    `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), db: process.env.TRAJECTORY_DB_PATH }) + '\\n');\n${body}\n`,
  );
  chmodSync(join(bin, 'claude'), 0o755);
  return { env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, record };
}

function lastCall(record: string): { argv: string[]; db?: string } {
  return JSON.parse(readFileSync(record, 'utf8').trim().split('\n').at(-1) ?? '{}');
}

describe('l5SmokeIsolateDb', () => {
  test('points TRAJECTORY_DB_PATH at one throwaway DB per process, under $TMPDIR', () => {
    const tmp = tempDir();
    const a = l5SmokeIsolateDb({ TMPDIR: `${tmp}/` });
    const b = l5SmokeIsolateDb({ TMPDIR: '/elsewhere' });
    assert.equal(a.TRAJECTORY_DB_PATH, b.TRAJECTORY_DB_PATH);
    assert.match(a.TRAJECTORY_DB_PATH ?? '', new RegExp(`^${tmp}/l5-smoke-db\\.[^/]+/\\.claude/tmb/trajectory\\.db$`));
    assert.ok(existsSync(dirname(a.TRAJECTORY_DB_PATH ?? '')));
  });

  test('cleanup removes the throwaway dir and the next call makes a fresh one', () => {
    const first = l5SmokeIsolateDb().TRAJECTORY_DB_PATH ?? '';
    l5SmokeCleanupDb();
    assert.equal(existsSync(dirname(first)), false);
    const second = l5SmokeIsolateDb().TRAJECTORY_DB_PATH ?? '';
    assert.notEqual(second, first);
    assert.ok(existsSync(dirname(second)));
  });
});

describe('l5SmokeMcp', () => {
  test('a missing entrypoint fails', () => {
    const root = tempDir();
    const { value, stderr } = quietStderr(() => l5SmokeMcp(root));
    assert.equal(value, 1);
    assert.match(stderr, /MCP smoke: entrypoint missing at .*dist\/index\.js/);
  });

  test('a server that answers with a tools list passes, and runs against the throwaway DB', () => {
    const plugin = fakePlugin(
      "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{if(s.includes('tools/list'))process.stdout.write(JSON.stringify({result:{tools:[]},db:process.env.TRAJECTORY_DB_PATH})+'\\n')});",
    );
    assert.equal(l5SmokeMcp(plugin), 0);
  });

  test('a server with no tools list fails and shows its first lines', () => {
    const plugin = fakePlugin("console.log(Array.from({length:20},(_,i)=>'line'+i).join('\\n'));");
    const { value, stderr } = quietStderr(() => l5SmokeMcp(plugin));
    assert.equal(value, 1);
    assert.match(stderr, /server did not return a tools list/);
    assert.match(stderr, /^ {6}line9$/m);
    assert.doesNotMatch(stderr, /line10/);
  });
});

describe('l5SmokeClaudeAuth', () => {
  test('an unset token fails without calling claude', () => {
    const { env, record } = stubClaude("process.stdout.write('hi\\n');");
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const { value, stderr } = quietStderr(() => l5SmokeClaudeAuth(env));
    assert.equal(value, 1);
    assert.match(stderr, /CLAUDE_CODE_OAUTH_TOKEN is not set/);
    assert.equal(existsSync(record), false);
  });

  test('claude -p printing something passes', () => {
    const { env, record } = stubClaude("process.stdout.write('hi\\n');");
    assert.equal(l5SmokeClaudeAuth(env), 0);
    assert.deepEqual(lastCall(record).argv, ['-p', 'say hi in one word']);
  });

  test('empty output fails', () => {
    const { env } = stubClaude("process.stdout.write('\\n');");
    const { value, stderr } = quietStderr(() => l5SmokeClaudeAuth(env));
    assert.equal(value, 1);
    assert.match(stderr, /returned empty output \(token may be revoked\)/);
  });
});

describe('l5SmokeClaudePluginLoad', () => {
  test('claude --plugin-dir printing something passes, against the throwaway DB', () => {
    const { env, record } = stubClaude("process.stderr.write('loaded\\n');");
    assert.equal(l5SmokeClaudePluginLoad('/plugin', env), 0);
    const call = lastCall(record);
    assert.deepEqual(call.argv, ['--plugin-dir', '/plugin', '--dangerously-skip-permissions', '-p', 'say hi in one word']);
    assert.equal(call.db, l5SmokeIsolateDb().TRAJECTORY_DB_PATH);
  });

  test('empty output fails and names the plugin dir', () => {
    const { env } = stubClaude('');
    const { value, stderr } = quietStderr(() => l5SmokeClaudePluginLoad('/plugin', env));
    assert.equal(value, 1);
    assert.match(stderr, /Plugin-load smoke: claude --plugin-dir returned empty output\n {4}plugin_dir=\/plugin\n/);
  });
});

describe('l5PreFlightOrAbort', () => {
  const MODULE = join(import.meta.dirname, 'smoke-helpers.ts');
  const script = (pluginDir: string) =>
    `import { l5PreFlightOrAbort } from ${JSON.stringify(MODULE)}; const env = l5PreFlightOrAbort(${JSON.stringify(pluginDir)}); console.log('DB=' + env.TRAJECTORY_DB_PATH);`;

  function runPreFlight(pluginDir: string, env: NodeJS.ProcessEnv) {
    return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script(pluginDir)], {
      env,
      encoding: 'utf8',
    });
  }

  test('all three smokes pass: the banner lines and the isolated env come back', () => {
    const plugin = fakePlugin("process.stdout.write('{\"tools\":[]}\\n');");
    const { env } = stubClaude("process.stdout.write('hi\\n');");
    const r = runPreFlight(plugin, env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /=== Pre-flight substrate health \(fail-fast\) ===\n {2}\[1\/3\] MCP smoke .*✓\n {2}\[2\/3\] Auth smoke .*✓\n {2}\[3\/3\] Plugin-load smoke .*✓\n=== Pre-flight passed ===\n\n/);
    assert.match(r.stdout, /DB=.*l5-smoke-db\.[^/]+\/\.claude\/tmb\/trajectory\.db/);
    const dbDir = /DB=(.*)\/\.claude\/tmb\/trajectory\.db/.exec(r.stdout)?.[1] ?? '';
    assert.equal(existsSync(dbDir), false, 'the throwaway DB dir is removed on exit');
  });

  test('a failing smoke exits 1 before the later ones', () => {
    const { env, record } = stubClaude("process.stdout.write('hi\\n');");
    const r = runPreFlight(tempDir(), env);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /❌ Pre-flight FAILED at MCP smoke\. Aborting before token spend\./);
    assert.equal(existsSync(record), false);
  });
});
