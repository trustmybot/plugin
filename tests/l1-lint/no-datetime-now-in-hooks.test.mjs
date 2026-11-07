// L1 lint: no `datetime('now'` under scripts/ or in mcp/trajectory-server/src/ *.ts / *.sql, except migrateV* bodies in src/db.ts and the src/test/ fixtures; SQLite's "YYYY-MM-DD HH:MM:SS" shape misorders against the ms-ISO timestamp columns.
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = 'mcp/trajectory-server/src';
const PATTERN = "datetime('now'";

function walk(root, rel, out) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) walk(root, child, out);
    else if (entry.isFile()) out.push(child);
  }
}

function grepFile(root, rel) {
  return readFileSync(join(root, rel), 'utf8')
    .split('\n')
    .flatMap((line, i) => (line.includes(PATTERN) ? [`${rel}:${i + 1}:${line}`] : []));
}

function dbTsHits(root) {
  const rel = `${SRC}/db.ts`;
  if (!existsSync(join(root, rel))) return [];
  let fn = '';
  return readFileSync(join(root, rel), 'utf8')
    .split('\n')
    .flatMap((line, i) => {
      const m = /^(?:export )?(?:async )?function ([^(]*)/.exec(line);
      if (m) fn = m[1];
      return line.includes(PATTERN) && !fn.startsWith('migrateV') ? [`${rel}:${i + 1}:${line}`] : [];
    });
}

export function datetimeNowHits(root) {
  const scripts = [];
  walk(root, 'scripts', scripts);
  const src = [];
  walk(root, SRC, src);
  return [
    ...scripts.sort().flatMap((f) => grepFile(root, f)),
    ...src
      .sort()
      .filter((f) => /\.(ts|sql)$/.test(f) && f !== `${SRC}/db.ts` && !f.startsWith(`${SRC}/test/`))
      .flatMap((f) => grepFile(root, f)),
    ...dbTsHits(root),
  ];
}

function failureMessage(hits) {
  return [
    `No-datetime-now-in-hooks: FAIL — ${hits.length} datetime('now') use(s) outside db.ts migrations:`,
    ...hits.map((h) => `  ${h}`),
    "  Use nowIso (src/hooks/lib/audit.ts), nowISO() (src/db.ts), or strftime('%Y-%m-%dT%H:%M:%fZ','now') in SQL.",
  ].join('\n');
}

test("datetime('now') outside a migrateV* body or src/test/ is caught", () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-no-datetime-now-'));
  try {
    mkdirSync(join(dir, 'scripts', 'hooks'), { recursive: true });
    mkdirSync(join(dir, SRC, 'test'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'hooks', 'stamp.sh'), "sqlite3 db \"SELECT datetime('now')\"\n");
    writeFileSync(join(dir, SRC, 'tool.ts'), "const sql = \"INSERT INTO t VALUES (datetime('now'))\";\n");
    writeFileSync(join(dir, SRC, 'notes.md'), "datetime('now')\n");
    writeFileSync(join(dir, SRC, 'test', 'fixture.ts'), "const old = \"datetime('now')\";\n");
    writeFileSync(
      join(dir, SRC, 'db.ts'),
      "export function migrateV3(db) {\n  db.exec(\"UPDATE t SET at = datetime('now')\");\n}\nfunction stampRow(db) {\n  db.exec(\"UPDATE t SET at = datetime('now')\");\n}\n",
    );
    const hits = datetimeNowHits(dir);
    assert.deepEqual(hits, [
      "scripts/hooks/stamp.sh:1:sqlite3 db \"SELECT datetime('now')\"",
      `${SRC}/tool.ts:1:const sql = "INSERT INTO t VALUES (datetime('now'))";`,
      `${SRC}/db.ts:5:  db.exec("UPDATE t SET at = datetime('now')");`,
    ]);
    assert.match(failureMessage(hits), /FAIL — 3 datetime\('now'\) use\(s\) outside db\.ts migrations/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no datetime('now') under scripts/ or in the server source", () => {
  const hits = datetimeNowHits(ROOT);
  assert.deepEqual(hits, [], failureMessage(hits));
});
