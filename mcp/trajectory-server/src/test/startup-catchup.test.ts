// The startup catch-up decision (GH 1680): which servers skip the detached
// run-scan.mjs and what the spawn case runs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decideStartupCatchup, RUN_SCAN_SCRIPT } from '../startup-catchup.js';

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

  it('index.ts starts the catch-up after server.connect', () => {
    const src = readFileSync(fileURLToPath(new URL('../../src/index.ts', import.meta.url)), 'utf8');
    const connect = src.indexOf('await server.connect(transport);');
    const catchup = src.indexOf('startStartupCatchup(dbPath);');
    assert.ok(connect > 0 && catchup > connect, 'startStartupCatchup follows server.connect');
  });
});
