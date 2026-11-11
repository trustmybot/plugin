// L1 lint: regression guard against the SQLite `directories` table, dropped in schema v8. The world model now lives in the wm_ tables of the trajectory DB (v42). Any new CREATE TABLE directories / INSERT INTO directories / FROM directories in a *.ts, *.js, *.sh, *.mjs, *.md, *.json or *.sql file anywhere under the plugin root (the top-level .claude/ excepted) is drift back toward the v7 design. Allowed exceptions (historical migration and this guard): mcp/trajectory-server/src/db.ts (migrateV7toV8 DROP TABLE), its compiled mcp/trajectory-server/dist/db.js, the bundles inlining the same shared DB (mcp/trajectory-server/dist/index.js, run-scan.js, cli.js, dashboard/dist/server.mjs and the dist-dev/server.mjs that dashboard/test/dev.test.mjs leaves behind), docs/architecture/WORLD_MODEL.md ('What was replaced' context), CHANGELOG.md (accurate history) and this file. scan(root) checks the tree at root; the cases below plant trees through it.
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SP = '[ \\t\\v\\f\\r]';
const DML_RE = new RegExp(
  `CREATE TABLE${SP}+IF NOT EXISTS${SP}+directories|CREATE TABLE${SP}+directories|INSERT( OR IGNORE)? INTO directories|FROM${SP}+directories`,
);
const EXTENSIONS = /\.(ts|js|sh|mjs|md|json|sql)$/;
const EXEMPT = new Set([
  'mcp/trajectory-server/src/db.ts',
  'mcp/trajectory-server/dist/db.js',
  'mcp/trajectory-server/dist/index.js',
  'mcp/trajectory-server/dist/run-scan.js',
  'mcp/trajectory-server/dist/cli.js',
  'dashboard/dist/server.mjs',
  'dashboard/dist-dev/server.mjs',
  'docs/architecture/WORLD_MODEL.md',
  'CHANGELOG.md',
  'tests/l1-lint/no-directories-table-refs.test.mjs',
]);
const FAIL_HINT =
  'no-directories-table-refs: FAIL — directories table was dropped in v8. Use world_model_get / world_model_search (wm_ tables in the trajectory DB) or scan_run.';

function walk(root, rel, out) {
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (path === '.claude') continue;
    if (e.isDirectory()) walk(root, path, out);
    else if (e.isFile() && EXTENSIONS.test(e.name)) out.push(path);
  }
}

export function scan(root = ROOT) {
  const files = [];
  walk(root, '', files);
  const out = [];
  for (const f of files.sort()) {
    let text;
    try {
      text = readFileSync(join(root, f), 'utf8');
    } catch {
      continue;
    }
    if (EXEMPT.has(f) || !DML_RE.test(text)) continue;
    out.push(`no-directories-table-refs: ${f} contains SQLite directories-table DML/DDL`);
  }
  return { ok: out.length === 0, out: out.join('\n') };
}

test('no directories-table refs', () => {
  const r = scan();
  assert.ok(r.ok, `${r.out}\n\n${FAIL_HINT}`);
});

describe('planted trees', () => {
  const DML = 'INSERT INTO ' + "directories (path) VALUES ('x');";
  let tmp;
  before(() => {
    tmp = mkdtempSync(join((process.env.TMPDIR || tmpdir()).replace(/\/+$/, ''), 'tmb-no-directories-table-refs.'));
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  function fixture(name, ...rels) {
    const root = join(tmp, name);
    mkdirSync(root, { recursive: true });
    for (const rel of rels) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), `${DML}\n`);
    }
    return root;
  }

  test('passes on a tree with no DML', () => {
    const r = scan(fixture('clean'));
    assert.ok(r.ok, r.out);
  });

  test('passes on the exactly listed bundles', () => {
    const r = scan(fixture('listed', 'dashboard/dist/server.mjs', 'dashboard/dist-dev/server.mjs', 'mcp/trajectory-server/dist/run-scan.js'));
    assert.ok(r.ok, r.out);
  });

  for (const [label, name, rel, phrase] of [
    ['a new source file holding the DML', 'new-file', 'scripts/new-migration.sh', 'scripts/new-migration.sh contains SQLite directories-table DML/DDL'],
    ['an unlisted bundle in the trajectory-server dist', 'unlisted-server', 'mcp/trajectory-server/dist/new-bundle.js', 'mcp/trajectory-server/dist/new-bundle.js contains'],
    ['an unlisted bundle in the dashboard dist', 'unlisted-dashboard', 'dashboard/dist/client.mjs', 'dashboard/dist/client.mjs contains'],
    ['a listed basename under another directory', 'wrong-dir', 'dashboard/dist/run-scan.js', 'dashboard/dist/run-scan.js contains'],
  ]) {
    test(`fails on ${label}, naming it`, () => {
      const r = scan(fixture(name, rel));
      assert.equal(r.ok, false, r.out);
      assert.ok(r.out.includes(phrase), r.out);
    });
  }
});
