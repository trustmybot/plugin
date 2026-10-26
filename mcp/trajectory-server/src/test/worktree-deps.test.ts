// linkWorktreeNodeModules and its use by task_provision (GH 1853): a task
// worktree gets the main checkout's node_modules linked beside each tracked
// package.json, existing destinations are left alone, and a reused worktree is
// repaired on the next provision.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinScanEnv, tempDB } from './helpers.js';
import { compositeTools } from '../tools/composites.js';
import { linkWorktreeNodeModules } from '../utils/worktree-deps.js';

const scanPin = pinScanEnv();
after(() => scanPin.restore());

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const SPEC = ['## Description', 'do the thing', '', '## Success Criteria', '- SC1: works'].join('\n');

function makeRepo(): { ws: string; repoRoot: string; git: (cwd: string, ...a: string[]) => string } {
  const ws = mkdtempSync(join(tmpdir(), 'wt-deps-'));
  const repoRoot = join(ws, 'app');
  mkdirSync(join(repoRoot, 'pkg'), { recursive: true });
  mkdirSync(join(repoRoot, 'other'), { recursive: true });
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git(repoRoot, 'init', '-q', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 't@t.t');
  git(repoRoot, 'config', 'user.name', 't');
  for (const p of ['package.json', 'pkg/package.json', 'other/package.json']) writeFileSync(join(repoRoot, p), '{}\n');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-q', '-m', 'base');
  git(repoRoot, 'update-ref', 'refs/remotes/origin/main', git(repoRoot, 'rev-parse', 'HEAD'));
  mkdirSync(join(repoRoot, 'node_modules'));
  mkdirSync(join(repoRoot, 'pkg', 'node_modules'));
  writeFileSync(join(repoRoot, 'node_modules', 'marker'), 'root-dep\n');
  writeFileSync(join(repoRoot, 'pkg', 'node_modules', 'marker'), 'pkg-dep\n');
  return { ws, repoRoot, git };
}

function isLinkTo(path: string, target: string): boolean {
  return lstatSync(path).isSymbolicLink() && readlinkSync(path) === target;
}

async function provision(repoRoot: string, ws: string, branchId: string): Promise<Record<string, unknown>> {
  const db = tempDB();
  db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'main')`, [repoRoot]);
  db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
          VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
  const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
  const handler = composites.handlers['task_provision'];
  assert.ok(handler);
  const r = (await handler({
    agent: 'bro',
    issue_id: 1,
    branch_id: branchId,
    decision_body: 'Chosen approach: build X because Y; trade-off Z.',
    task: { title: 'Do X', description: 'implement X', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
  })) as unknown as RawResult;
  const out = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(out)}`);
  db.close();
  return out;
}

describe('task_provision links node_modules (GH 1853)', () => {
  it('links node_modules and pkg/node_modules to the main checkout, other/ stays without one', async () => {
    const { ws, repoRoot } = makeRepo();
    try {
      const out = await provision(repoRoot, ws, 'feat/deps');
      const wt = out['worktree_path'] as string;
      assert.equal(out['git_setup'], 'created');
      assert.ok(isLinkTo(join(wt, 'node_modules'), join(repoRoot, 'node_modules')));
      assert.ok(isLinkTo(join(wt, 'pkg', 'node_modules'), join(repoRoot, 'pkg', 'node_modules')));
      assert.equal(existsSync(join(wt, 'other', 'node_modules')), false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('a reused worktree that lacks links gets them on the next provision', async () => {
    const { ws, repoRoot, git } = makeRepo();
    try {
      const wt = join(repoRoot, '.claude', 'worktrees', 'reused');
      git(repoRoot, 'worktree', 'add', '-q', '-b', 'feat/reused', wt, 'main');
      assert.equal(existsSync(join(wt, 'node_modules')), false);
      const out = await provision(repoRoot, ws, 'feat/reused');
      assert.equal(out['worktree_path'], wt);
      assert.ok(isLinkTo(join(wt, 'node_modules'), join(repoRoot, 'node_modules')));
      assert.ok(isLinkTo(join(wt, 'pkg', 'node_modules'), join(repoRoot, 'pkg', 'node_modules')));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('linkWorktreeNodeModules', () => {
  function withWorktree(fn: (repoRoot: string, wt: string) => void): void {
    const { ws, repoRoot, git } = makeRepo();
    try {
      const wt = join(ws, 'wt');
      git(repoRoot, 'worktree', 'add', '-q', '--detach', wt, 'main');
      fn(repoRoot, wt);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }

  it('skips a package whose source install is absent', () => {
    withWorktree((repoRoot, wt) => {
      const r = linkWorktreeNodeModules(repoRoot, wt);
      assert.deepEqual(r.linked.sort(), ['.', 'pkg']);
      assert.deepEqual(r.skipped.map((s) => s.dir), ['other']);
      assert.equal(existsSync(join(wt, 'other', 'node_modules')), false);
    });
  });

  it('leaves an existing destination dir, symlink or dangling symlink untouched and reports it skipped', () => {
    withWorktree((repoRoot, wt) => {
      mkdirSync(join(wt, 'node_modules'));
      writeFileSync(join(wt, 'node_modules', 'own'), 'x');
      const dangling = join(wt, 'gone');
      symlinkSync(dangling, join(wt, 'pkg', 'node_modules'));
      const r = linkWorktreeNodeModules(repoRoot, wt);
      assert.deepEqual(r.linked, []);
      assert.deepEqual(r.skipped.map((s) => s.dir).sort(), ['.', 'other', 'pkg']);
      assert.equal(lstatSync(join(wt, 'node_modules')).isDirectory(), true);
      assert.equal(readlinkSync(join(wt, 'pkg', 'node_modules')), dangling);

      unlinkSync(join(wt, 'pkg', 'node_modules'));
      symlinkSync(join(repoRoot, 'node_modules'), join(wt, 'pkg', 'node_modules'));
      linkWorktreeNodeModules(repoRoot, wt);
      assert.equal(readlinkSync(join(wt, 'pkg', 'node_modules')), join(repoRoot, 'node_modules'));
    });
  });

  it('a second call is a no-op', () => {
    withWorktree((repoRoot, wt) => {
      const first = linkWorktreeNodeModules(repoRoot, wt);
      assert.deepEqual(first.linked.sort(), ['.', 'pkg']);
      const second = linkWorktreeNodeModules(repoRoot, wt);
      assert.deepEqual(second.linked, []);
      assert.deepEqual(second.skipped.map((s) => s.dir).sort(), ['.', 'other', 'pkg']);
      assert.ok(isLinkTo(join(wt, 'node_modules'), join(repoRoot, 'node_modules')));
    });
  });

  it('never throws when the worktree is not a git checkout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-deps-nogit-'));
    try {
      const r = linkWorktreeNodeModules(dir, dir);
      assert.deepEqual(r.linked, []);
      assert.equal(r.skipped.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the CLI entry links and exits 0', () => {
    withWorktree((repoRoot, wt) => {
      const cli = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'utils', 'worktree-deps.js');
      execFileSync(process.execPath, [cli, repoRoot, wt], { stdio: ['ignore', 'pipe', 'pipe'] });
      assert.ok(isLinkTo(join(wt, 'pkg', 'node_modules'), join(repoRoot, 'pkg', 'node_modules')));
      execFileSync(process.execPath, [cli], { stdio: ['ignore', 'pipe', 'pipe'] });
    });
  });

  it('the CLI entry links when run through a symlinked plugin path (F148-1)', () => {
    withWorktree((repoRoot, wt) => {
      const utilsDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'utils');
      const linkedUtils = join(repoRoot, '..', 'plug-utils');
      symlinkSync(utilsDir, linkedUtils);
      execFileSync(process.execPath, [join(linkedUtils, 'worktree-deps.js'), repoRoot, wt], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.ok(isLinkTo(join(wt, 'node_modules'), join(repoRoot, 'node_modules')));
      assert.ok(isLinkTo(join(wt, 'pkg', 'node_modules'), join(repoRoot, 'pkg', 'node_modules')));
    });
  });

  it('the CLI guard stays off inside the dist/index.js bundle: the server still answers initialize', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'wt-deps-bundle-'));
    const bundle = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'index.js');
    const child = spawn(process.execPath, ['--experimental-sqlite', bundle], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: ws, CLAUDE_PLUGIN_DATA: join(ws, 'data') },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    try {
      const reply = new Promise<string>((resolveReply, reject) => {
        let buf = '';
        child.stdout.on('data', (d: Buffer) => {
          buf += d.toString();
          if (buf.includes('\n')) resolveReply(buf);
        });
        child.on('exit', (code) => reject(new Error(`server exited (${code}) before answering`)));
        setTimeout(() => reject(new Error('no initialize reply within 20 s')), 20_000).unref();
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
        }) + '\n',
      );
      assert.match(await reply, /"serverInfo"/);
    } finally {
      child.kill();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
