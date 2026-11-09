// The startup catch-up decision (GH 1680): which servers skip the detached
// run-scan.mjs and what the spawn case runs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CHANGE_IMPACT_CLI,
  changeImpactCacheArgs,
  decideChangeImpactCache,
  decideStartupCatchup,
  RUN_SCAN_SCRIPT,
  startupCatchupArgs,
} from '../startup-catchup.js';

const DB = '/proj/.claude/tmb/trajectory.db';
const present = () => true;

describe('decideStartupCatchup', () => {
  it('skips an in-memory DB', () => {
    assert.deepEqual(decideStartupCatchup({ dbPath: ':memory:', env: { CLAUDE_PROJECT_DIR: '/proj' }, exists: present }), {
      spawn: false,
      reason: 'memory-db',
    });
  });

  it('skips with TMB_SKIP_AUTO_RESCAN=1', () => {
    const d = decideStartupCatchup({ dbPath: DB, env: { CLAUDE_PROJECT_DIR: '/proj', TMB_SKIP_AUTO_RESCAN: '1' }, exists: present });
    assert.deepEqual(d, { spawn: false, reason: 'skip-env' });
  });

  it('skips inside a node:test process', () => {
    const d = decideStartupCatchup({ dbPath: DB, env: { CLAUDE_PROJECT_DIR: '/proj', NODE_TEST_CONTEXT: 'child' }, exists: present });
    assert.deepEqual(d, { spawn: false, reason: 'test-context' });
  });

  it('skips with no project root', () => {
    assert.deepEqual(decideStartupCatchup({ dbPath: DB, env: {}, exists: present }), { spawn: false, reason: 'no-project-root' });
  });

  it('skips when run-scan.mjs is missing', () => {
    const d = decideStartupCatchup({ dbPath: DB, env: { CLAUDE_PROJECT_DIR: '/proj' }, exists: () => false });
    assert.deepEqual(d, { spawn: false, reason: 'script-missing' });
  });

  it('spawns run-scan.mjs on the project root otherwise', () => {
    const d = decideStartupCatchup({ dbPath: DB, env: { CLAUDE_PROJECT_DIR: '/proj' }, exists: present });
    assert.deepEqual(d, { spawn: true, script: RUN_SCAN_SCRIPT, projectRoot: '/proj', reason: 'spawned' });
    assert.ok(RUN_SCAN_SCRIPT.endsWith('/scripts/maintenance/run-scan.mjs'));
    assert.ok(existsSync(RUN_SCAN_SCRIPT), RUN_SCAN_SCRIPT);
  });

  it('spawns run-scan.mjs with startup_catchup as its second argument (GH 1851)', () => {
    assert.deepEqual(startupCatchupArgs(RUN_SCAN_SCRIPT, '/proj', ['--experimental-sqlite']), [
      '--experimental-sqlite',
      RUN_SCAN_SCRIPT,
      '/proj',
      'startup_catchup',
    ]);
    const src = readFileSync(fileURLToPath(new URL('../../src/startup-catchup.ts', import.meta.url)), 'utf8');
    assert.ok(src.includes('spawn(process.execPath, startupCatchupArgs(decision.script, decision.projectRoot)'));
  });

  it('index.ts starts the catch-up after server.connect', () => {
    const src = readFileSync(fileURLToPath(new URL('../../src/index.ts', import.meta.url)), 'utf8');
    const connect = src.indexOf('await server.connect(transport);');
    const catchup = src.indexOf('startStartupCatchup(dbPath);');
    assert.ok(connect > 0 && catchup > connect, 'startStartupCatchup follows server.connect');
  });
});

describe('decideChangeImpactCache (GH 2600)', () => {
  it('skips an in-memory DB, TMB_SKIP_AUTO_RESCAN=1 and a node:test process', () => {
    assert.deepEqual(decideChangeImpactCache({ dbPath: ':memory:', env: {}, exists: present }), { spawn: false, reason: 'memory-db' });
    assert.deepEqual(decideChangeImpactCache({ dbPath: DB, env: { TMB_SKIP_AUTO_RESCAN: '1' }, exists: present }), { spawn: false, reason: 'skip-env' });
    assert.deepEqual(decideChangeImpactCache({ dbPath: DB, env: { NODE_TEST_CONTEXT: 'child' }, exists: present }), { spawn: false, reason: 'test-context' });
  });

  it('skips when the CLI is missing', () => {
    assert.deepEqual(decideChangeImpactCache({ dbPath: DB, env: {}, exists: () => false }), { spawn: false, reason: 'script-missing' });
  });

  it('spawns dist/change-impact/cli.js --db <db> --cache otherwise, needing no project root', () => {
    assert.deepEqual(decideChangeImpactCache({ dbPath: DB, env: {}, exists: present }), { spawn: true, script: CHANGE_IMPACT_CLI, reason: 'spawned' });
    assert.ok(CHANGE_IMPACT_CLI.endsWith('/dist/change-impact/cli.js'), CHANGE_IMPACT_CLI);
    assert.ok(existsSync(CHANGE_IMPACT_CLI), CHANGE_IMPACT_CLI);
    assert.deepEqual(changeImpactCacheArgs(CHANGE_IMPACT_CLI, DB, ['--experimental-sqlite']), ['--experimental-sqlite', CHANGE_IMPACT_CLI, '--db', DB, '--cache']);
  });

  it('spawns detached with stdio ignored, logging every decision', () => {
    const src = readFileSync(fileURLToPath(new URL('../../src/startup-catchup.ts', import.meta.url)), 'utf8');
    const body = src.slice(src.indexOf('export function startChangeImpactCache'));
    assert.ok(body.includes('spawn(process.execPath, changeImpactCacheArgs(decision.script, dbPath), { cwd: dirname(dbPath), detached: true, stdio: \'ignore\' })'));
    assert.ok(body.includes('child.unref()'));
    assert.ok(body.includes("serverLog({ kind: 'change_impact_cache', spawned: decision.spawn, reason: decision.reason })"));
  });

  it('index.ts starts the cache writer after server.connect', () => {
    const src = readFileSync(fileURLToPath(new URL('../../src/index.ts', import.meta.url)), 'utf8');
    const connect = src.indexOf('await server.connect(transport);');
    const cache = src.indexOf('startChangeImpactCache(dbPath);');
    assert.ok(connect > 0 && cache > connect, 'startChangeImpactCache follows server.connect');
  });
});
