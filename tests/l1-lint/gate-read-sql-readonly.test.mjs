// L1 lint: every data-contract SQL the hook read helpers run is read-only. The hook read helpers (gateRead, sqliteRo and dbReadBudget in mcp/trajectory-server/src/hooks/lib/db.ts) read a WAL DB nobody holds open without -readonly, so the SQL itself is what keeps a hook read from writing. Checked: the `sql` of every contract in DATA_CONTRACTS (built mcp/trajectory-server/dist/data-contracts.js, the source of scripts/hooks/lib/data-contracts.json) — each statement (after whitespace and comments) starts with SELECT, WITH (without INSERT/UPDATE/DELETE/REPLACE; the replace() scalar function is a read), or a read-only PRAGMA: `journal_mode` or `user_version` without `=`, or `table_info(...)`; dot-commands are rejected. An unreadable module fails. Every run self-tests a planted write contract and a planted read contract.
import { strict as assert } from 'node:assert';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
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

export function scan(contracts) {
  const out = [];
  for (const [id, sql] of contracts) {
    const r = sqlOk(sql);
    if (r !== true) out.push(`data-contracts.json: contract ${id}: sql must be read-only (${r})`);
  }
  return out;
}

async function contractSql() {
  const { dataContractsJson } = await import(pathToFileURL(CONTRACTS_MODULE).href);
  const { contracts } = JSON.parse(dataContractsJson());
  assert.ok(Array.isArray(contracts) && contracts.length > 0, `gate-read-sql-readonly: no contracts read from ${CONTRACTS_MODULE}`);
  return contracts.map((c) => [c.id, c.sql]);
}

test('self-test: a non-read-only contract SQL is flagged, a read-only one is not', () => {
  assert.deepEqual(
    scan([
      ['planted_write', 'DELETE FROM tasks'],
      ['planted_read', 'SELECT COUNT(*) FROM tasks'],
    ]),
    ['data-contracts.json: contract planted_write: sql must be read-only (statement starts with DELETE)'],
  );
});

test('every data-contract sql is read-only', async () => {
  const out = scan(await contractSql());
  assert.deepEqual(out, [], `gate-read-sql-readonly: FAIL\n${out.join('\n')}`);
});
