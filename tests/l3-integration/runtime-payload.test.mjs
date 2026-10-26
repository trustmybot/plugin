// L3: scripts/maintenance/runtime-payload.ts prunes a checkout to the runtime
// allowlist (GH 1699). A synthetic repo pins the allowlist; a clone of HEAD
// proves the pruned tree still cold-boots the MCP server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'scripts/maintenance/runtime-payload.ts');
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env: GIT_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function prune(root, ...args) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', SCRIPT, '--root', root, ...args], {
    encoding: 'utf8',
  });
}

function tracked(root) {
  return git(root, 'ls-files').split('\n').filter(Boolean).sort();
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-payload-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const KEPT = [
  '.claude-plugin/plugin.json',
  '.github/workflows/w.yml',
  '.mcp.json',
  'CLAUDE.md',
  'README.md',
  'agents/swe.md',
  'dashboard/dist/server.mjs',
  'hooks/hooks.json',
  'mcp/a/dist/q.js',
  'mcp/a/package.json',
  'mcp/a/runtime-deps/package.json',
  'scripts/hooks/x.sh',
  'skills/s/SKILL.md',
].sort();

const DROPPED = [
  'tests/x',
  'mcp/a/src/y.ts',
  'mcp/a/dist/test/z.js',
  'mcp/a/dist/q.js.map',
  'scripts/s.js.map',
  'docs/d.md',
  'brand-new-dir/n.txt',
  'package.json',
  'bun.lock',
  'changelog.d/1-x.md',
  'dashboard/web/app.tsx',
  'mcp/a/tsconfig.json',
].sort();

test('SC1: default mode keeps exactly the allowlist; --check flags offenders before and passes after', (t) => {
  const repo = tempDir(t);
  git(repo, 'init', '-q');
  for (const p of [...KEPT, ...DROPPED]) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), `${p}\n`);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'fixture');

  const before = prune(repo, '--check');
  assert.equal(before.status, 1, before.stdout + before.stderr);
  const lines = before.stdout.split('\n');
  for (const p of DROPPED) assert.ok(lines.includes('  ' + p), `--check did not name ${p}`);
  for (const p of KEPT) assert.ok(!lines.includes('  ' + p), `--check flagged kept path ${p}`);
  assert.deepEqual(tracked(repo), [...KEPT, ...DROPPED].sort(), '--check removed nothing');

  const run = prune(repo);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, new RegExp(`kept ${KEPT.length} files, removed ${DROPPED.length}; payload \\d+\\.\\d MB`));
  assert.deepEqual(tracked(repo), KEPT);
  for (const p of DROPPED) assert.ok(!existsSync(join(repo, p)), `${p} left in the working tree`);
  for (const d of ['tests', 'docs', 'brand-new-dir', 'mcp/a/src', 'mcp/a/dist/test']) {
    assert.ok(!existsSync(join(repo, d)), `empty dir ${d} left behind`);
  }

  const after = prune(repo, '--check');
  assert.equal(after.status, 0, after.stdout + after.stderr);
});

function toolsList(entry, cwd) {
  return new Promise((resolveList, reject) => {
    const child = spawn(process.execPath, ['--experimental-sqlite', entry], {
      cwd,
      env: { ...process.env, TRAJECTORY_DB_PATH: ':memory:', TMB_FORBID_LIVE_SYNC: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => {
      out += b;
      if (out.includes('"id":1')) child.kill();
    });
    child.stderr.on('data', (b) => (err += b));
    child.on('error', reject);
    child.on('close', () => resolveList({ out, err }));
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  });
}

test('SC2: a pruned clone of HEAD carries no dev-only files and cold-boots the MCP server', { timeout: 120_000 }, async (t) => {
  const clone = join(tempDir(t), 'plugin');
  const r = spawnSync('git', ['clone', '-q', '--local', '--no-hardlinks', ROOT, clone], { env: GIT_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);

  const run = prune(clone);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const files = tracked(clone);
  assert.ok(files.length > 0);
  assert.deepEqual(files.filter((p) => p.startsWith('tests/')), []);
  assert.deepEqual(files.filter((p) => p.startsWith('mcp/trajectory-server/src/')), []);
  assert.deepEqual(files.filter((p) => p.includes('/dist/test/')), []);
  assert.deepEqual(files.filter((p) => p.endsWith('.map')), []);
  for (const d of ['tests', 'mcp/trajectory-server/src', 'mcp/trajectory-server/dist/test']) {
    assert.ok(!existsSync(join(clone, d)), `${d} left in the working tree`);
  }
  assert.ok(existsSync(join(clone, 'mcp/trajectory-server/runtime-deps')));
  assert.equal(prune(clone, '--check').status, 0);

  const { out, err } = await toolsList(join(clone, 'mcp/trajectory-server/dist/index.js'), clone);
  assert.match(out, /"name":"onboard_state_get"/, `tools/list from the pruned clone failed:\n${out}\n${err}`);
});
