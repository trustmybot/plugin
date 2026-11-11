// linkWorktreeNodeModules, prepareWorktreeDeps (GH 3003) and their use by task_provision (GH 1853): a task
// worktree gets the main checkout's node_modules linked entry by entry beside
// each tracked package.json (GH 2872), existing destinations are left alone, and
// a reused worktree is repaired on the next provision.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinScanEnv, tempDB } from './helpers.js';
import { compositeTools } from '../tools/composites.js';
import { type InstallRunner, linkWorktreeNodeModules, prepareWorktreeDeps } from '../utils/worktree-deps.js';

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
  writeFileSync(join(repoRoot, 'node_modules', '.package-lock.json'), '{}\n');
  mkdirSync(join(repoRoot, 'node_modules', '.bin'));
  writeFileSync(join(repoRoot, 'node_modules', '.bin', 'tool'), '#!/bin/sh\n');
  mkdirSync(join(repoRoot, 'node_modules', 'left-pad'));
  writeFileSync(join(repoRoot, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  mkdirSync(join(repoRoot, 'node_modules', '@scope', 'pkg'), { recursive: true });
  writeFileSync(join(repoRoot, 'node_modules', '@scope', 'pkg', 'index.js'), 'module.exports = 2;\n');
  writeFileSync(join(repoRoot, 'pkg', 'node_modules', 'marker'), 'pkg-dep\n');
  return { ws, repoRoot, git };
}

const MAIN_ROOT_ENTRIES = ['.bin', '.package-lock.json', '@scope', 'left-pad', 'marker'];
const WORKTREE_ROOT_ENTRIES = ['.bin', '@scope', 'left-pad', 'marker'];

function isLinkTo(path: string, target: string): boolean {
  return lstatSync(path).isSymbolicLink() && readlinkSync(path) === target;
}

function isRealDirOfLinksTo(dest: string, src: string, linksEntry: (name: string) => boolean): boolean {
  const stat = lstatSync(dest);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  const names = readdirSync(src)
    .filter((name) => name !== '.package-lock.json')
    .sort();
  return (
    JSON.stringify(readdirSync(dest).sort()) === JSON.stringify(names) &&
    names.every((name) => linksEntry(name))
  );
}

function isPerEntryLinkTo(dest: string, src: string): boolean {
  return isRealDirOfLinksTo(dest, src, (name) =>
    name === '.bin' || name.startsWith('@')
      ? isRealDirOfLinksTo(join(dest, name), join(src, name), (child) =>
          isLinkTo(join(dest, name, child), join(src, name, child)),
        )
      : isLinkTo(join(dest, name), join(src, name)),
  );
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
      assert.ok(isPerEntryLinkTo(join(wt, 'node_modules'), join(repoRoot, 'node_modules')));
      assert.ok(isPerEntryLinkTo(join(wt, 'pkg', 'node_modules'), join(repoRoot, 'pkg', 'node_modules')));
      assert.deepEqual(readdirSync(join(wt, 'node_modules')).sort(), WORKTREE_ROOT_ENTRIES);
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
      assert.ok(isPerEntryLinkTo(join(wt, 'node_modules'), join(repoRoot, 'node_modules')));
      assert.ok(isPerEntryLinkTo(join(wt, 'pkg', 'node_modules'), join(repoRoot, 'pkg', 'node_modules')));
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
      assert.deepEqual(readdirSync(join(wt, 'node_modules')), ['own']);
      assert.equal(readlinkSync(join(wt, 'pkg', 'node_modules')), dangling);

      unlinkSync(join(wt, 'pkg', 'node_modules'));
      symlinkSync(join(repoRoot, 'node_modules'), join(wt, 'pkg', 'node_modules'));
      const foreign = linkWorktreeNodeModules(repoRoot, wt);
      assert.deepEqual(foreign.linked, []);
      assert.ok(foreign.skipped.some((s) => s.dir === 'pkg'));
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
      assert.ok(isPerEntryLinkTo(join(wt, 'node_modules'), join(repoRoot, 'node_modules')));
    });
  });

  it('removing the worktree install the way npm ci does leaves the main install intact (GH 2872)', () => {
    withWorktree((repoRoot, wt) => {
      linkWorktreeNodeModules(repoRoot, wt);
      rmSync(join(wt, 'node_modules'), { recursive: true, force: true });
      rmSync(join(wt, 'pkg', 'node_modules'), { recursive: true, force: true });
      assert.deepEqual(readdirSync(join(repoRoot, 'node_modules')).sort(), MAIN_ROOT_ENTRIES);
      for (const file of ['marker', '.package-lock.json', '.bin/tool', 'left-pad/index.js', '@scope/pkg/index.js']) {
        assert.ok(existsSync(join(repoRoot, 'node_modules', file)), `main install lost ${file}`);
      }
      assert.ok(existsSync(join(repoRoot, 'pkg', 'node_modules', 'marker')));
    });
  });

  it('leaves npm\'s hidden lockfile unlinked so a worktree install cannot overwrite the main copy (F816-1)', () => {
    withWorktree((repoRoot, wt) => {
      linkWorktreeNodeModules(repoRoot, wt);
      const worktreeLock = join(wt, 'node_modules', '.package-lock.json');
      const mainLock = join(repoRoot, 'node_modules', '.package-lock.json');
      assert.equal(existsSync(worktreeLock), false);
      writeFileSync(worktreeLock, '{"worktree":true}\n');
      assert.equal(lstatSync(worktreeLock).isSymbolicLink(), false);
      assert.equal(readFileSync(mainLock, 'utf8'), '{}\n');
      rmSync(join(wt, 'node_modules'), { recursive: true, force: true });
      assert.equal(readFileSync(mainLock, 'utf8'), '{}\n');
    });
  });

  it('gives .bin and each @scope dir its own per-entry links so a worktree install cannot rewrite them in main (F816-2)', () => {
    withWorktree((repoRoot, wt) => {
      const mainModules = join(repoRoot, 'node_modules');
      mkdirSync(join(mainModules, '@other', 'lib'), { recursive: true });
      linkWorktreeNodeModules(repoRoot, wt);
      const wtModules = join(wt, 'node_modules');
      for (const container of ['.bin', '@scope', '@other']) {
        const stat = lstatSync(join(wtModules, container));
        assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `${container} is linked whole`);
      }
      assert.ok(isLinkTo(join(wtModules, '.bin', 'tool'), join(mainModules, '.bin', 'tool')));
      assert.ok(isLinkTo(join(wtModules, '@scope', 'pkg'), join(mainModules, '@scope', 'pkg')));
      assert.ok(isLinkTo(join(wtModules, '@other', 'lib'), join(mainModules, '@other', 'lib')));
      assert.ok(isLinkTo(join(wtModules, 'left-pad'), join(mainModules, 'left-pad')));

      writeFileSync(join(wtModules, '.bin', 'added'), '#!/bin/sh\n');
      mkdirSync(join(wtModules, '@scope', 'added'));
      unlinkSync(join(wtModules, '.bin', 'tool'));
      unlinkSync(join(wtModules, '@scope', 'pkg'));
      assert.deepEqual(readdirSync(join(mainModules, '.bin')), ['tool']);
      assert.deepEqual(readdirSync(join(mainModules, '@scope')), ['pkg']);
      assert.ok(existsSync(join(mainModules, '@scope', 'pkg', 'index.js')));
    });
  });

  it('migrates a whole-dir link to the main install into per-entry links and reports it linked', () => {
    withWorktree((repoRoot, wt) => {
      symlinkSync(join(repoRoot, 'node_modules'), join(wt, 'node_modules'));
      symlinkSync(join(repoRoot, 'pkg', 'node_modules'), join(wt, 'pkg', 'node_modules'));
      const r = linkWorktreeNodeModules(repoRoot, wt);
      assert.deepEqual(r.linked.sort(), ['.', 'pkg']);
      assert.deepEqual(r.skipped.map((s) => s.dir), ['other']);
      assert.ok(isPerEntryLinkTo(join(wt, 'node_modules'), join(repoRoot, 'node_modules')));
      assert.ok(isPerEntryLinkTo(join(wt, 'pkg', 'node_modules'), join(repoRoot, 'pkg', 'node_modules')));
      assert.deepEqual(readdirSync(join(repoRoot, 'node_modules')).sort(), MAIN_ROOT_ENTRIES);
    });
  });

  it('reports a dir skipped and leaves no partial install when its entries cannot be listed', {
    skip: process.getuid?.() === 0 ? 'root reads any dir' : false,
  }, () => {
    withWorktree((repoRoot, wt) => {
      const pkgSrc = join(repoRoot, 'pkg', 'node_modules');
      chmodSync(pkgSrc, 0o311);
      try {
        const r = linkWorktreeNodeModules(repoRoot, wt);
        assert.deepEqual(r.linked, ['.']);
        assert.match(r.skipped.find((s) => s.dir === 'pkg')?.reason ?? '', /could not link/);
        assert.equal(existsSync(join(wt, 'pkg', 'node_modules')), false);
      } finally {
        chmodSync(pkgSrc, 0o755);
      }
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
      assert.ok(isPerEntryLinkTo(join(wt, 'pkg', 'node_modules'), join(repoRoot, 'pkg', 'node_modules')));
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
      assert.ok(isPerEntryLinkTo(join(wt, 'node_modules'), join(repoRoot, 'node_modules')));
      assert.ok(isPerEntryLinkTo(join(wt, 'pkg', 'node_modules'), join(repoRoot, 'pkg', 'node_modules')));
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

describe('prepareWorktreeDeps (GH 3003)', () => {
  type Call = { argv: readonly string[]; cwd: string };
  function recorder(fail?: string): { calls: Call[]; runInstall: InstallRunner } {
    const calls: Call[] = [];
    return {
      calls,
      runInstall: (argv, cwd) => {
        calls.push({ argv, cwd });
        return fail === undefined ? Promise.resolve() : Promise.reject(new Error(fail));
      },
    };
  }

  async function withLockedWorktree(
    lockfile: string | null,
    fn: (repoRoot: string, wt: string) => Promise<void>,
  ): Promise<void> {
    const { ws, repoRoot, git } = makeRepo();
    try {
      if (lockfile !== null) {
        writeFileSync(join(repoRoot, lockfile), 'lock-v1\n');
        git(repoRoot, 'add', lockfile);
        git(repoRoot, 'commit', '-q', '-m', 'lock');
      }
      const wt = join(ws, 'wt');
      git(repoRoot, 'worktree', 'add', '-q', '--detach', wt, 'main');
      await fn(repoRoot, wt);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }

  function assertNoNodeModules(wt: string): void {
    for (const dir of ['.', 'pkg', 'other']) assert.equal(existsSync(join(wt, dir, 'node_modules')), false, `${dir}/node_modules`);
  }

  for (const lockfile of [null, 'package-lock.json']) {
    it(`with matching manifests (${lockfile ?? 'no lockfile'}) it links as linkWorktreeNodeModules does and never installs`, async () => {
      await withLockedWorktree(lockfile, async (repoRoot, wt) => {
        const { calls, runInstall } = recorder();
        const r = await prepareWorktreeDeps(repoRoot, wt, { runInstall });
        assert.deepEqual(calls, []);
        assert.deepEqual(r.linked.sort(), ['.', 'pkg']);
        assert.deepEqual(r.skipped.map((s) => s.dir), ['other']);
        assert.equal(r.installed, undefined);
        assert.equal(r.install_error, undefined);
        assert.ok(isPerEntryLinkTo(join(wt, 'node_modules'), join(repoRoot, 'node_modules')));
        assert.ok(isPerEntryLinkTo(join(wt, 'pkg', 'node_modules'), join(repoRoot, 'pkg', 'node_modules')));
      });
    });
  }

  it('a changed package.json with no lockfile falls back to linking', async () => {
    await withLockedWorktree(null, async (repoRoot, wt) => {
      writeFileSync(join(wt, 'pkg', 'package.json'), '{"dependencies":{"x":"1"}}\n');
      const { calls, runInstall } = recorder();
      const r = await prepareWorktreeDeps(repoRoot, wt, { runInstall });
      assert.deepEqual(calls, []);
      assert.deepEqual(r.linked.sort(), ['.', 'pkg']);
    });
  });

  const KINDS: [string, string][] = [
    ['bun.lock', 'bun install --frozen-lockfile'],
    ['bun.lockb', 'bun install --frozen-lockfile'],
    ['package-lock.json', 'npm ci'],
    ['npm-shrinkwrap.json', 'npm ci'],
    ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
    ['yarn.lock', 'yarn install --frozen-lockfile'],
  ];
  for (const [lockfile, command] of KINDS) {
    it(`a nested package.json that differs from main runs ${command} for ${lockfile} and links nothing`, async () => {
      await withLockedWorktree(lockfile, async (repoRoot, wt) => {
        writeFileSync(join(wt, 'pkg', 'package.json'), '{"dependencies":{"x":"1"}}\n');
        const { calls, runInstall } = recorder();
        const r = await prepareWorktreeDeps(repoRoot, wt, { runInstall });
        assert.deepEqual(calls, [{ argv: command.split(' '), cwd: wt }]);
        assert.deepEqual(r, { linked: [], skipped: [], installed: { command } });
        assertNoNodeModules(wt);
      });
    });
  }

  it('a lockfile that differs from main installs even when every package.json matches', async () => {
    await withLockedWorktree('bun.lock', async (repoRoot, wt) => {
      writeFileSync(join(wt, 'bun.lock'), 'lock-v2\n');
      const { calls, runInstall } = recorder();
      const r = await prepareWorktreeDeps(repoRoot, wt, { runInstall });
      assert.equal(calls.length, 1);
      assert.deepEqual(r.installed, { command: 'bun install --frozen-lockfile' });
      assertNoNodeModules(wt);
    });
  });

  it('a lockfile the main checkout lacks counts as a difference', async () => {
    await withLockedWorktree(null, async (repoRoot, wt) => {
      writeFileSync(join(wt, 'yarn.lock'), 'lock\n');
      const { calls, runInstall } = recorder();
      const r = await prepareWorktreeDeps(repoRoot, wt, { runInstall });
      assert.deepEqual(calls.map((c) => c.argv.join(' ')), ['yarn install --frozen-lockfile']);
      assert.deepEqual(r.linked, []);
    });
  });

  it('a rejecting install yields install_error naming the command and links nothing', async () => {
    await withLockedWorktree('package-lock.json', async (repoRoot, wt) => {
      writeFileSync(join(wt, 'package.json'), '{"dependencies":{"x":"1"}}\n');
      const { calls, runInstall } = recorder('exited 1\nOutput (last 20 lines):\nboom');
      const r = await prepareWorktreeDeps(repoRoot, wt, { runInstall });
      assert.equal(calls.length, 1);
      assert.equal(r.installed, undefined);
      assert.equal(r.install_error, 'frozen install failed: npm ci: exited 1\nOutput (last 20 lines):\nboom');
      assert.deepEqual(r.linked, []);
      assertNoNodeModules(wt);
    });
  });

  it('the default runner runs the install in the worktree and reports its exit and output tail', async () => {
    await withLockedWorktree('package-lock.json', async (repoRoot, wt) => {
      writeFileSync(join(wt, 'package-lock.json'), 'not json\n');
      const r = await prepareWorktreeDeps(repoRoot, wt);
      assert.match(r.install_error ?? '', /^frozen install failed: npm ci: exited 1\nOutput \(last 20 lines\):\n/);
      assertNoNodeModules(wt);
    });
  });
});
