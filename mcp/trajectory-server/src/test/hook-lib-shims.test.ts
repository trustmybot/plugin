/**
 * The sourced shell shims scripts/hooks/lib/query-task.sh and
 * resolve-install.sh (GH 1692), run the way the codex-owned L5/L6 harness runs
 * them, against the built dist/cli.js `hook-lib` subcommand: each answer
 * equals its TypeScript source, dbPath() or installPluginName().
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dbPath } from '../hooks/lib/db.js';
import { installPluginName } from '../hooks/lib/install.js';
import { installRoot } from '../hooks/lib/project-env.js';

const PLUGIN_ROOT = installRoot(dirname(fileURLToPath(import.meta.url))) as string;
const LIB = join(PLUGIN_ROOT, 'scripts', 'hooks', 'lib');
const QUERY_TASK = join(LIB, 'query-task.sh');
const RESOLVE_INSTALL = join(LIB, 'resolve-install.sh');
const DROPPED = ['TMB_TEST_RUN_ID', 'TMB_FORBID_LIVE_SYNC', 'TRAJECTORY_DB_PATH', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR'];

let root: string;

function baseEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, 'home') };
  for (const key of DROPPED) delete env[key];
  return { ...env, ...extra };
}

function shim(lib: string, fn: string, env: NodeJS.ProcessEnv): { code: number | null; stdout: string } {
  const r = spawnSync('bash', ['-c', `. "$1"; ${fn}`, '_', lib], { encoding: 'utf8', env, cwd: '/' });
  return { code: r.status, stdout: r.stdout };
}

function makeDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY, prompt_bearing INTEGER)');
  db.close();
}

describe('hook-lib shims', () => {
  let ws: string;
  let nested: string;
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'hook-lib-shims-')));
    ws = join(root, 'home', 'ws');
    nested = join(ws, '.claude', 'tmb', 'runs', 'project');
    makeDb(join(ws, '.claude', 'tmb', 'trajectory.db'));
    makeDb(join(nested, '.claude', 'tmb', 'trajectory.db'));
    writeFileSync(join(nested, '.claude', 'tmb', 'standalone'), '');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  for (const [label, extra] of [
    ['CLAUDE_PLUGIN_ROOT unset', {}],
    ['CLAUDE_PLUGIN_ROOT set', { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT }],
  ] as const) {
    it(`tmb_db_path prints dbPath() for a standalone scratch project (${label})`, () => {
      const env = baseEnv({ ...extra, CLAUDE_PROJECT_DIR: nested });
      const expected = dbPath(env);
      assert.equal(expected, join(nested, '.claude', 'tmb', 'trajectory.db'));
      const r = shim(QUERY_TASK, 'tmb_db_path', env);
      assert.equal(r.code, 0);
      assert.equal(r.stdout, `${expected}\n`);
    });
  }

  it('tmb_db_path prints the workspace DB for a scratch project without the standalone marker', () => {
    const plain = join(ws, '.claude', 'tmb', 'runs', 'plain');
    makeDb(join(plain, '.claude', 'tmb', 'trajectory.db'));
    const env = baseEnv({ CLAUDE_PROJECT_DIR: plain });
    assert.equal(dbPath(env), join(ws, '.claude', 'tmb', 'trajectory.db'));
    const r = shim(QUERY_TASK, 'set -uo pipefail; tmb_db_path', env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, `${dbPath(env)}\n`);
  });

  for (const [label, extra] of [
    ['TRAJECTORY_DB_PATH names a missing file', { TRAJECTORY_DB_PATH: '/nonexistent/hook-lib-shims.db' }],
    ['a test flag with no DB under CLAUDE_PROJECT_DIR', { TMB_TEST_RUN_ID: 'hook-lib-shims', CLAUDE_PROJECT_DIR: '/nonexistent-project' }],
  ] as const) {
    it(`tmb_db_path prints nothing and exits non-zero when no DB resolves (${label})`, () => {
      const env = baseEnv(extra);
      assert.equal(dbPath(env), null);
      const r = shim(QUERY_TASK, 'tmb_db_path', env);
      assert.notEqual(r.code, 0);
      assert.equal(r.stdout, '');
    });
  }

  it('_tmb_install_plugin_name prints the manifest name of CLAUDE_PLUGIN_ROOT', () => {
    const fixture = join(root, 'plugin-x');
    mkdirSync(join(fixture, '.claude-plugin'), { recursive: true });
    writeFileSync(join(fixture, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'shim-x' }));
    const env = baseEnv({ CLAUDE_PLUGIN_ROOT: fixture });
    assert.equal(installPluginName(env), 'shim-x');
    const r = shim(RESOLVE_INSTALL, '_tmb_install_plugin_name', env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'shim-x\n');
  });

  it('_tmb_install_plugin_name prints the installPluginName() default with no manifest', () => {
    const env = baseEnv({ CLAUDE_PLUGIN_ROOT: join(root, 'no-manifest') });
    const r = shim(RESOLVE_INSTALL, '_tmb_install_plugin_name', env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, `${installPluginName(env)}\n`);
  });

  for (const lib of [QUERY_TASK, RESOLVE_INSTALL]) {
    it(`${lib.slice(LIB.length + 1)} defines at most 2 functions and parses`, () => {
      const fns = readFileSync(lib, 'utf8').match(/^[A-Za-z_][A-Za-z0-9_]*\(\)\s*\{/gm) ?? [];
      assert.ok(fns.length >= 1 && fns.length <= 2, fns.join(', '));
      assert.equal(spawnSync('bash', ['-n', lib]).status, 0);
    });
  }
});
