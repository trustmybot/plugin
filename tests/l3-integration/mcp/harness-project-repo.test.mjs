import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createProjectRepo, serverEnv, sqliteRun, startClient, startProjectClient } from './harness.mjs';

test('serverEnv skips the startup catch-up by default and lets a caller override it', () => {
  const pinned = serverEnv({});
  const overridden = serverEnv({ TMB_SKIP_AUTO_RESCAN: '0' });
  try {
    assert.equal(pinned.env.TMB_SKIP_AUTO_RESCAN, '1');
    assert.equal(overridden.env.TMB_SKIP_AUTO_RESCAN, '0');
  } finally {
    pinned.cleanup();
    overridden.cleanup();
  }
});

test('registerRepo upserts over an existing repos row of the same name', async (t) => {
  const project = createProjectRepo();
  const started = await startClient({ extraEnv: project.env, fileDb: true });
  t.after(async () => {
    try { await started.close(); } finally { project.cleanup(); }
  });

  sqliteRun(started.dbPath, `INSERT INTO repos (name, path) VALUES ('app', '/elsewhere/app');`);
  project.registerRepo(started.dbPath);

  const rows = sqliteRun(started.dbPath, `SELECT name, path, target_branch FROM repos WHERE name = 'app';`);
  assert.deepEqual(rows, [{ name: 'app', path: project.repoPath, target_branch: 'dev' }]);
});

test('startProjectClient leaves exactly one repos row: no background scan races it', async (t) => {
  const savedTestContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  let started;
  try {
    started = await startProjectClient();
  } finally {
    if (savedTestContext !== undefined) process.env.NODE_TEST_CONTEXT = savedTestContext;
  }
  t.after(async () => { await started.close(); });

  await sleep(3000);

  const rows = sqliteRun(started.dbPath, `SELECT name, path FROM repos;`);
  assert.deepEqual(rows, [{ name: 'app', path: started.project.repoPath }]);
});
