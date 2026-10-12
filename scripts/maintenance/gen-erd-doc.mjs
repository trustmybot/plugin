#!/usr/bin/env node
// Regenerates the schema-derived part of docs/architecture/ERD.md from
// mcp/trajectory-server/src/schema.sql (production tables), src/schema-eval.sql
// (the "Eval mode" subsection) and TARGET_SCHEMA_VERSION in src/db.ts:
// the mermaid erDiagram, one column table per table, the foreign keys with
// their ON DELETE action, the FTS5 search indexes with their shadow tables,
// and the index list, all between the erd:generated markers. The
// `schema_version = N` token in the prose above the markers is kept equal to
// TARGET_SCHEMA_VERSION.
//   (no flag)     rewrite the doc in place
//   --check       write nothing; exit 1 when the committed doc differs
//   --root <dir>  read and write docs/architecture/ERD.md under <dir> (lint self-tests)
//
// The parser and renderer are exported for the unit snapshot test
// (mcp/trajectory-server/src/test/gen-erd-doc.test.ts).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BEGIN = '<!-- erd:generated:start -->';
export const END = '<!-- erd:generated:end -->';

const FTS_SHADOW_SUFFIXES = ['config', 'data', 'docsize', 'idx'];

function stripComments(sql) {
  let out = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j += 2; continue; }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j;
    } else if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += '\n';
    } else {
      out += ch;
    }
  }
  return out;
}

// Splits on <sep> at paren depth 0, outside quotes.
function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = text[i + 1] === quote ? (i++, quote) : null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function splitStatements(sql) {
  const statements = [];
  let current = '';
  for (const piece of splitTopLevel(stripComments(sql), ';')) {
    current = current ? `${current}; ${piece}` : piece;
    if (/^CREATE\s+TRIGGER\b/i.test(current) && !/\bEND$/i.test(current)) continue;
    statements.push(current.replace(/\s+/g, ' ').trim());
    current = '';
  }
  return statements;
}

// Index of the paren closing the one opening at <open>.
function closeParen(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = text[i + 1] === quote ? (i++, quote) : null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  throw new Error(`unbalanced parentheses in: ${text}`);
}

function identList(text) {
  return text.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
}

const CONSTRAINT_START = /^(CONSTRAINT|PRIMARY|NOT|NULL|UNIQUE|CHECK|DEFAULT|REFERENCES|COLLATE|GENERATED|AS)\b/i;

function parseReferences(rest) {
  const m = /^REFERENCES\s+(\w+)\s*(?:\(([^)]*)\))?\s*/i.exec(rest);
  const fk = { table: m[1], refColumns: m[2] ? identList(m[2]) : [], onDelete: 'NO ACTION' };
  let tail = rest.slice(m[0].length);
  for (;;) {
    const action = /^ON\s+(DELETE|UPDATE)\s+(SET\s+NULL|SET\s+DEFAULT|CASCADE|RESTRICT|NO\s+ACTION)\s*/i.exec(tail);
    if (!action) break;
    if (action[1].toUpperCase() === 'DELETE') fk.onDelete = action[2].toUpperCase().replace(/\s+/g, ' ');
    tail = tail.slice(action[0].length);
  }
  return { fk, tail };
}

function parseColumn(def) {
  const m = /^"?(\w+)"?\s*(.*)$/s.exec(def);
  const column = { name: m[1], type: '', notNull: false, pk: false, autoincrement: false, unique: false, default: null, check: null, fk: null };
  let rest = m[2];
  const type = /^([A-Za-z]+(?:\s*\([^)]*\))?)\s*/.exec(rest);
  if (type && !CONSTRAINT_START.test(rest)) {
    column.type = type[1].toUpperCase();
    rest = rest.slice(type[0].length);
  }
  while (rest.length > 0) {
    let m2;
    if ((m2 = /^PRIMARY\s+KEY(\s+AUTOINCREMENT)?\s*/i.exec(rest))) {
      column.pk = true;
      column.autoincrement = Boolean(m2[1]);
    } else if ((m2 = /^NOT\s+NULL\s*/i.exec(rest))) {
      column.notNull = true;
    } else if ((m2 = /^UNIQUE\s*/i.exec(rest))) {
      column.unique = true;
    } else if (/^CHECK\s*\(/i.test(rest)) {
      const open = rest.indexOf('(');
      const close = closeParen(rest, open);
      column.check = rest.slice(open + 1, close).trim();
      rest = rest.slice(close + 1).trimStart();
      continue;
    } else if (/^DEFAULT\s*\(/i.test(rest)) {
      const open = rest.indexOf('(');
      const close = closeParen(rest, open);
      column.default = rest.slice(open, close + 1);
      rest = rest.slice(close + 1).trimStart();
      continue;
    } else if ((m2 = /^DEFAULT\s+('(?:[^']|'')*'|[^\s,]+)\s*/i.exec(rest))) {
      column.default = m2[1];
    } else if (/^REFERENCES\b/i.test(rest)) {
      const { fk, tail } = parseReferences(rest);
      column.fk = { columns: [column.name], ...fk };
      if (fk.refColumns.length === 0) column.fk.refColumns = [column.name];
      rest = tail;
      continue;
    } else {
      throw new Error(`unparsed column constraint in "${def}": ${rest}`);
    }
    rest = rest.slice(m2[0].length);
  }
  return column;
}

function parseTable(name, body) {
  const table = { name, columns: [], primaryKey: [], uniques: [], checks: [], foreignKeys: [] };
  for (const item of splitTopLevel(body, ',')) {
    let m;
    if ((m = /^PRIMARY\s+KEY\s*\(([^)]*)\)$/i.exec(item))) {
      table.primaryKey = identList(m[1]);
    } else if ((m = /^UNIQUE\s*\(([^)]*)\)$/i.exec(item))) {
      table.uniques.push(identList(m[1]));
    } else if (/^CHECK\s*\(/i.test(item)) {
      const open = item.indexOf('(');
      table.checks.push(item.slice(open + 1, closeParen(item, open)).trim());
    } else if ((m = /^FOREIGN\s+KEY\s*\(([^)]*)\)\s*(REFERENCES\b.*)$/i.exec(item))) {
      const { fk } = parseReferences(m[2]);
      table.foreignKeys.push({ columns: identList(m[1]), ...fk });
    } else {
      table.columns.push(parseColumn(item));
    }
  }
  for (const c of table.columns) {
    if (c.pk) table.primaryKey = [c.name];
    if (c.fk) table.foreignKeys.push(c.fk);
  }
  table.foreignKeys.sort((a, b) => table.columns.findIndex((c) => c.name === a.columns[0]) - table.columns.findIndex((c) => c.name === b.columns[0]));
  return table;
}

export function parseSchema(sql) {
  const schema = { tables: [], indexes: [], fts: [], triggers: [] };
  for (const stmt of splitStatements(sql)) {
    let m;
    if ((m = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s*\(/i.exec(stmt))) {
      const open = m[0].length - 1;
      schema.tables.push(parseTable(m[1], stmt.slice(open + 1, closeParen(stmt, open))));
    } else if ((m = /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)\s*(?:WHERE\s+(.*))?$/i.exec(stmt))) {
      schema.indexes.push({ name: m[2], table: m[3], columns: identList(m[4]), unique: Boolean(m[1]), where: m[5] ? m[5].trim() : null });
    } else if ((m = /^CREATE\s+VIRTUAL\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+USING\s+fts5\s*\((.*)\)$/i.exec(stmt))) {
      const fts = { name: m[1], columns: [], content: null, contentRowid: null, tokenize: null };
      for (const arg of splitTopLevel(m[2], ',')) {
        const opt = /^(\w+)\s*=\s*'((?:[^']|'')*)'$/.exec(arg);
        if (opt && opt[1] === 'content') fts.content = opt[2];
        else if (opt && opt[1] === 'content_rowid') fts.contentRowid = opt[2];
        else if (opt && opt[1] === 'tokenize') fts.tokenize = opt[2];
        else if (!opt) fts.columns.push(arg);
      }
      schema.fts.push(fts);
    } else if ((m = /^CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+(BEFORE|AFTER|INSTEAD\s+OF)\s+(INSERT|UPDATE|DELETE)\b.*?\bON\s+(\w+)/i.exec(stmt))) {
      schema.triggers.push({ name: m[1], timing: m[2].toUpperCase(), event: m[3].toUpperCase(), table: m[4] });
    }
  }
  return schema;
}

export function readTargetSchemaVersion(dbTs) {
  const m = /export const TARGET_SCHEMA_VERSION\s*=\s*(\d+)/.exec(dbTs);
  if (!m) throw new Error('TARGET_SCHEMA_VERSION not found in db.ts');
  return Number(m[1]);
}

function code(text) {
  return `\`${text}\``;
}

function cell(text) {
  return text.replace(/\|/g, '\\|');
}

// CHECK (col IN ('a','b')) reads as "a|b"; any other expression verbatim.
function checkSummary(expr, column) {
  const m = new RegExp(`^${column}\\s+IN\\s*\\((.*)\\)$`, 'is').exec(expr);
  if (m) {
    const values = splitTopLevel(m[1], ',');
    if (values.every((v) => /^'[^']*'$/.test(v))) return values.map((v) => v.slice(1, -1)).join('|');
  }
  return expr;
}

// An INTEGER PRIMARY KEY is the rowid and never NULL; any other PRIMARY KEY
// column admits NULL in SQLite unless it is declared NOT NULL.
function notNull(column) {
  return column.notNull || (column.pk && column.type === 'INTEGER');
}

function mermaidKeys(table, column) {
  const keys = [];
  if (table.primaryKey.includes(column.name)) keys.push('PK');
  if (table.foreignKeys.some((fk) => fk.columns.includes(column.name))) keys.push('FK');
  if (column.unique) keys.push('UK');
  return keys.join(',');
}

function mermaidComment(table, column) {
  const parts = [];
  if (notNull(column)) parts.push('NOT NULL');
  if (column.check) parts.push(`CHECK ${checkSummary(column.check, column.name)}`);
  for (const fk of table.foreignKeys.filter((f) => f.columns.includes(column.name))) {
    parts.push(`→ ${fk.table}.${fk.refColumns[fk.columns.indexOf(column.name)]} ${fk.onDelete}`);
  }
  return parts.join('; ').replace(/"/g, "'");
}

function renderMermaid(schema) {
  const lines = ['```mermaid', 'erDiagram'];
  for (const table of schema.tables) {
    for (const fk of table.foreignKeys) {
      const required = fk.columns.every((c) => notNull(table.columns.find((col) => col.name === c)));
      const oneToOne = fk.columns.length === 1 && (
        (table.primaryKey.length === 1 && table.primaryKey[0] === fk.columns[0]) ||
        table.columns.find((col) => col.name === fk.columns[0])?.unique);
      lines.push(`    ${fk.table} ${required ? '||' : '|o'}--${oneToOne ? 'o|' : 'o{'} ${table.name} : "${fk.columns.join(', ')} (${fk.onDelete})"`);
    }
  }
  for (const table of schema.tables) {
    lines.push('', `    ${table.name} {`);
    for (const column of table.columns) {
      const keys = mermaidKeys(table, column);
      const comment = mermaidComment(table, column);
      lines.push(`        ${column.type || 'ANY'} ${column.name}${keys ? ` ${keys}` : ''}${comment ? ` "${comment}"` : ''}`);
    }
    lines.push('    }');
  }
  lines.push('```');
  return lines.join('\n');
}

function columnConstraints(table, column) {
  const parts = [];
  if (table.primaryKey.length === 1 && table.primaryKey[0] === column.name) parts.push(column.autoincrement ? 'PK AUTOINCREMENT' : 'PK');
  if (column.unique) parts.push('UNIQUE');
  for (const fk of table.foreignKeys.filter((f) => f.columns.length === 1 && f.columns[0] === column.name)) {
    parts.push(`FK → ${code(`${fk.table}.${fk.refColumns[0]}`)} ON DELETE ${fk.onDelete}`);
  }
  if (column.check) parts.push(`CHECK ${code(column.check)}`);
  return parts.join('; ');
}

function renderTable(table) {
  const lines = [`### ${code(table.name)}`, '', '| Column | Type | Null | Default | Constraints |', '|---|---|---|---|---|'];
  for (const column of table.columns) {
    lines.push(`| ${code(column.name)} | ${column.type || ''} | ${notNull(column) ? 'NOT NULL' : 'nullable'} | ${column.default === null ? '' : code(column.default)} | ${cell(columnConstraints(table, column))} |`);
  }
  const tableLevel = [];
  if (table.primaryKey.length > 1) tableLevel.push(`PRIMARY KEY ${code(`(${table.primaryKey.join(', ')})`)}`);
  for (const u of table.uniques) tableLevel.push(`UNIQUE ${code(`(${u.join(', ')})`)}`);
  for (const fk of table.foreignKeys.filter((f) => f.columns.length > 1)) {
    tableLevel.push(`FOREIGN KEY ${code(`(${fk.columns.join(', ')})`)} → ${code(`${fk.table}(${fk.refColumns.join(', ')})`)} ON DELETE ${fk.onDelete}`);
  }
  for (const check of table.checks) tableLevel.push(`CHECK ${code(check)}`);
  if (tableLevel.length > 0) lines.push('', 'Table constraints:', '', ...tableLevel.map((t) => `- ${t}`));
  return lines.join('\n');
}

function renderForeignKeys(schema) {
  const lines = ['| From | Column(s) | → To | ON DELETE |', '|---|---|---|---|'];
  for (const table of schema.tables) {
    for (const fk of table.foreignKeys) {
      lines.push(`| ${code(table.name)} | ${code(fk.columns.join(', '))} | ${code(`${fk.table}(${fk.refColumns.join(', ')})`)} | ${fk.onDelete} |`);
    }
  }
  return lines.join('\n');
}

function renderIndexes(schema) {
  const lines = ['| Index | Table | Columns | Unique | Where |', '|---|---|---|---|---|'];
  for (const idx of schema.indexes) {
    lines.push(`| ${code(idx.name)} | ${code(idx.table)} | ${code(idx.columns.join(', '))} | ${idx.unique ? 'yes' : ''} | ${idx.where ? code(idx.where) : ''} |`);
  }
  for (const table of schema.tables) {
    const uniques = table.columns.filter((c) => c.unique).map((c) => [c.name]).concat(table.uniques);
    for (const u of uniques) {
      lines.push(`| _UNIQUE constraint_ | ${code(table.name)} | ${code(u.join(', '))} | yes | |`);
    }
  }
  return lines.join('\n');
}

function renderSearchIndexes(schema) {
  const lines = [
    'FTS5 virtual tables over a content table. SQLite creates and maintains each one\'s shadow tables; the triggers keep the index in step with its content table.',
    '',
    '| FTS table | Content table | Indexed columns | Tokenizer | Shadow tables | Sync triggers |',
    '|---|---|---|---|---|---|',
  ];
  for (const fts of schema.fts) {
    const shadows = FTS_SHADOW_SUFFIXES.concat(fts.content ? [] : ['content']).map((s) => code(`${fts.name}_${s}`)).join(', ');
    const triggers = schema.triggers.filter((t) => t.table === fts.content).map((t) => `${code(t.name)} (${t.timing} ${t.event})`).join(', ');
    lines.push(`| ${code(fts.name)} | ${fts.content ? code(`${fts.content}.${fts.contentRowid ?? 'rowid'}`) : '(own content)'} | ${fts.columns.map(code).join(', ')} | ${fts.tokenize ? code(fts.tokenize) : ''} | ${shadows} | ${triggers} |`);
  }
  return lines.join('\n');
}

export function renderGenerated({ schemaSql, evalSql, version }) {
  const schema = parseSchema(schemaSql);
  const evalSchema = parseSchema(evalSql ?? '');
  const parts = [
    `_Generated from \`mcp/trajectory-server/src/schema.sql\` by \`scripts/maintenance/gen-erd-doc.mjs\` at \`schema_version = ${version}\`; edit the schema, then rerun the script._`,
    '## Diagram',
    renderMermaid(schema),
    '## Tables',
    ...schema.tables.map(renderTable),
    '## Foreign keys',
    'SQLite enforces every one (`PRAGMA foreign_keys = ON`); `NO ACTION` is SQLite\'s default when the schema names no action, and like `RESTRICT` it refuses to delete a parent that still has children.',
    renderForeignKeys(schema),
    '## Search indexes',
    renderSearchIndexes(schema),
    '## Indexes',
    renderIndexes(schema),
  ];
  if (evalSchema.tables.length > 0) {
    parts.push(
      '## Eval mode',
      'Applied from `mcp/trajectory-server/src/schema-eval.sql` only when `TMB_EVAL_MODE=1`; production DBs do not carry these tables.',
      ...evalSchema.tables.map((t) => renderTable(t).replace(/^### /, '#### ')),
      '#### Eval-mode indexes',
      renderIndexes({ indexes: evalSchema.indexes, tables: evalSchema.tables }),
    );
  }
  return parts.join('\n\n');
}

export function renderDoc(current, inputs) {
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if (start < 0 || end < start) throw new Error(`generated markers missing (${BEGIN} … ${END})`);
  const head = current.slice(0, start).replace(/`schema_version = \d+`/, `\`schema_version = ${inputs.version}\``);
  return `${head}${BEGIN}\n${renderGenerated(inputs)}\n${current.slice(end)}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = join(here, '..', '..');
  const rootAt = argv.indexOf('--root');
  const root = rootAt >= 0 ? argv[rootAt + 1] : repo;
  const src = join(repo, 'mcp/trajectory-server/src');
  const doc = join(root, 'docs/architecture/ERD.md');
  const inputs = {
    schemaSql: readFileSync(join(src, 'schema.sql'), 'utf8'),
    evalSql: readFileSync(join(src, 'schema-eval.sql'), 'utf8'),
    version: readTargetSchemaVersion(readFileSync(join(src, 'db.ts'), 'utf8')),
  };
  const have = readFileSync(doc, 'utf8');
  const want = renderDoc(have, inputs);
  if (have === want) return;
  if (argv.includes('--check')) {
    console.error(`  ✗ ${relative(root, doc)} differs from what schema.sql generates`);
    process.exit(1);
  }
  writeFileSync(doc, want);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
