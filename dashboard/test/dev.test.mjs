// Dev script test: seed a temp trajectory DB from schema.sql, run
// scripts/dev.mjs against it on a free port, check the page and app bundle are
// served from dist-dev/, then SIGTERM it and check it exits promptly and
// leaves the port closed.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DASH = new URL('..', import.meta.url).pathname;
const SCHEMA = join(DASH, '../mcp/trajectory-server/src/schema.sql');

const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tmb-dashboard-dev-'));
const dbPath = join(tmp, 'trajectory.db');
after(() => rmSync(tmp, { recursive: true, force: true }));

function seed(path) {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA, 'utf8'));
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

function waitForUrl(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no URL within ${timeoutMs}ms: ${out}`)), timeoutMs);
    const onData = (chunk) => {
      out += chunk;
      const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(out)?.[0];
      if (url) {
        clearTimeout(timer);
        resolve(url);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`dev exited ${code}: ${out}`));
    });
  });
}

test('dev script serves the dist-dev bundle and shuts down cleanly on SIGTERM', async () => {
  seed(dbPath);
  const child = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: DASH,
    env: { ...process.env, TRAJECTORY_DB_PATH: dbPath, TMB_DASHBOARD_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const url = await waitForUrl(child, 30_000);
    const page = await fetch(url);
    assert.equal(page.status, 200);
    const app = await fetch(`${url}app.js`);
    assert.equal(app.status, 200);
    await app.arrayBuffer();
    await page.arrayBuffer();

    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    child.kill('SIGTERM');
    const result = await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('dev did not exit within 5s')), 5_000)),
    ]);
    assert.deepEqual(result, { code: 0, signal: null });
    await assert.rejects(fetch(url));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const gone = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await gone;
      clearTimeout(timer);
    }
    child.stdout.destroy();
    child.stderr.destroy();
  }
});
