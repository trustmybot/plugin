// L1 lint: every SQL the hook read helpers run is read-only. The hook read helpers (gateRead, sqliteRo and dbReadBudget in mcp/trajectory-server/src/hooks/lib/db.ts) read a WAL DB nobody holds open without -readonly, so the SQL itself is what keeps a hook read from writing. Checked: every call site of the shell names tmb_gate_read and tmb_sqlite_ro in scripts/**/*.sh — each statement of the SQL argument (after whitespace and comments) starts with SELECT, WITH (without INSERT/UPDATE/DELETE/REPLACE; the replace() scalar function is a read), or a read-only PRAGMA: `journal_mode` or `user_version` without `=`, or `table_info(...)`; dot-commands are rejected. The SQL must be a literal: a bare variable cannot be checked and is flagged. The `sql` of every contract in DATA_CONTRACTS (built mcp/trajectory-server/dist/data-contracts.js, the source of scripts/hooks/lib/data-contracts.json) is checked the same way; an unreadable module fails. No shell file under scripts/hooks/ calls `sqlite3 -readonly` itself. Every run self-tests fixtures/gate-read-sql-readonly/: good.sh is clean and every call site in bad.sh is flagged.
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = 'tests/l1-lint/fixtures/gate-read-sql-readonly';
const CONTRACTS_MODULE = join(ROOT, 'mcp/trajectory-server/dist/data-contracts.js');

function stmtOk(raw) {
  const s = raw.trim();
  if (s === '') return true;
  if (s.startsWith('.')) return 'starts with a dot command';
  const m = /^([A-Za-z]+)/.exec(s);
  if (!m) return 'statement has no keyword';
  const kw = m[1].toUpperCase();
  if ((kw === 'SELECT' || kw === 'WITH') && !/\b(?:INSERT|UPDATE|DELETE)\b|\bREPLACE\b(?!\s*\()/i.test(s)) return true;
  if (kw === 'PRAGMA') {
    if (/^PRAGMA\s+(?:\w+\.)?(journal_mode|user_version)\s*$/i.test(s)) return true;
    if (/^PRAGMA\s+(?:\w+\.)?table_info\s*\(\s*[\w"']+\s*\)\s*$/i.test(s)) return true;
    return 'PRAGMA is not a read-only pragma read';
  }
  return `statement starts with ${kw}`;
}

export function sqlOk(input) {
  const sql = input
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, '')
    .replace(/'[^']*'/g, "''");
  for (const st of sql.split(';')) {
    const r = stmtOk(st);
    if (r !== true) return r;
  }
  return true;
}

const CALL_SITE =
  /(?<!-F )\b(tmb_gate_read|tmb_sqlite_ro)\b(?![ \t]*\(\))[ \t]+("(?:[^"\\]|\\.)*"|'[^']*'|\S+)[ \t]*(?:\\\n[ \t]*)?("(?:[^"\\]|\\.)*"|'[^']*'|\S+)?/g;

function lineAt(src, index) {
  return src.slice(0, index).split('\n').length;
}

export function scan(base, files, contracts = []) {
  const out = [];
  for (const [id, sql] of contracts) {
    const r = sqlOk(sql);
    if (r !== true) out.push(`data-contracts.json: contract ${id}: sql must be read-only (${r})`);
  }
  for (const file of files) {
    const src = readFileSync(join(base, file), 'utf8').replace(/^([ \t]*#[^\n]*)$/gm, (c) => ' '.repeat(c.length));
    const slashed = `/${file}`;
    if (slashed.includes('/scripts/hooks/')) {
      for (const m of src.matchAll(/\bsqlite3\b[^\n]*?[ \t]-readonly\b/g)) {
        out.push(`${file}:${lineAt(src, m.index)}: sqlite3 -readonly in a hook script (read through gateRead / sqliteRo in mcp/trajectory-server/src/hooks/lib/db.ts)`);
      }
    }
    for (const m of src.matchAll(CALL_SITE)) {
      const fn = m[1];
      const arg = m[3] ?? '';
      let why;
      const quoted = /^"([\s\S]*)"$/.exec(arg) ?? /^'([\s\S]*)'$/.exec(arg);
      if (quoted) {
        if (/^\s*\$\{?\w+(?::-)?\}?\s*$/.test(quoted[1])) why = 'SQL is a variable, not a literal';
        else {
          const r = sqlOk(quoted[1]);
          if (r !== true) why = r;
        }
      } else {
        why = 'SQL argument is not a quoted literal';
      }
      if (why !== undefined) out.push(`${file}:${lineAt(src, m.index)}: ${fn} SQL must be read-only (${why})`);
    }
  }
  return out;
}

function shellFiles(dir) {
  const found = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory() && e.name !== 'node_modules') walk(child);
      else if (e.isFile() && e.name.endsWith('.sh')) found.push(child);
    }
  };
  walk(dir);
  return found.sort();
}

async function contractSql() {
  const { dataContractsJson } = await import(pathToFileURL(CONTRACTS_MODULE).href);
  const { contracts } = JSON.parse(dataContractsJson());
  assert.ok(Array.isArray(contracts) && contracts.length > 0, `gate-read-sql-readonly: no contracts read from ${CONTRACTS_MODULE}`);
  return contracts.map((c) => [c.id, c.sql]);
}

test('self-test: good.sh is clean', () => {
  assert.deepEqual(scan(ROOT, [`${FIXTURES}/good.sh`]), []);
});

test('self-test: every call site in bad.sh is flagged', () => {
  const bad = `${FIXTURES}/bad.sh`;
  const sites = readFileSync(join(ROOT, bad), 'utf8')
    .split('\n')
    .flatMap((l, i) => (/tmb_gate_read|tmb_sqlite_ro/.test(l) ? [i + 1] : []));
  const out = scan(ROOT, [bad]);
  assert.ok(sites.length > 0, 'self-test: bad.sh has no call sites');
  assert.deepEqual(
    out.map((l) => Number(l.split(':')[1])),
    sites,
    `self-test: bad.sh: ${out.length} of ${sites.length} call sites flagged:\n${out.join('\n')}`,
  );
});

test('self-test: a non-read-only contract SQL is flagged, a read-only one is not', () => {
  assert.deepEqual(
    scan(ROOT, [], [
      ['planted_write', 'DELETE FROM tasks'],
      ['planted_read', 'SELECT COUNT(*) FROM tasks'],
    ]),
    ['data-contracts.json: contract planted_write: sql must be read-only (statement starts with DELETE)'],
  );
});

test('every hook read SQL and data-contract sql is read-only', async () => {
  const contracts = await contractSql();
  const out = scan(ROOT, shellFiles('scripts'), contracts);
  assert.deepEqual(out, [], `gate-read-sql-readonly: FAIL\n${out.join('\n')}`);
});
