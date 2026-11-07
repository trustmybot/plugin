// L1 lint: no trajectory-DB write under scripts/ bypasses the hooks' write library, dbWrite / auditAppend in mcp/trajectory-server/src/hooks/lib/audit.ts. A direct `sqlite3` write runs with foreign keys OFF, no busy timeout, outside a transaction and usually behind `2>/dev/null || true`. Every `sqlite3` CLI call in a scripts/ *.sh, *.bash or extensionless file has its SQL collected (inline string, quoted multi-line string, `\` continuations or heredoc body) and fails when it holds INSERT, UPDATE or DELETE; a non-readonly call whose SQL is a bare shell variable ("$SQL") is flagged too.
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRITE_SQL = /(^|[^A-Z_])(INSERT|UPDATE|DELETE)([^A-Z_]|$)/;
const SQLITE_CALL = /(^|[^A-Za-z0-9_.-])sqlite3[ \t]+(-|"|\$|<)/;
const VARIABLE_SQL = /sqlite3[^"]*"[^"]*"[ \t]+"\$\{?[A-Za-z_][A-Za-z0-9_]*\}?"/;
const HEREDOC = /<<-?[ \t]*["']?[A-Za-z_][A-Za-z0-9_]*/;

function scriptFiles(root, rel, out) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) scriptFiles(root, child, out);
    else if (entry.isFile() && (/\.(sh|bash)$/.test(entry.name) || !entry.name.includes('.'))) out.push(child);
  }
}

const quotes = (s) => (s.replaceAll('\\"', '').match(/"/g) || []).length;
const continues = (line) => /\\[ \t]*$/.test(line);

export function directWrites(file, text) {
  const hits = [];
  let start = 0;
  let buf = '';
  let delim = '';
  let open = false;
  const flush = () => {
    if (start && WRITE_SQL.test(buf.toUpperCase())) hits.push(`${file}:${start}`);
    start = 0;
    buf = '';
    delim = '';
    open = false;
  };
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  lines.forEach((line, i) => {
    if (start) {
      buf += `\n${line}`;
      if (delim !== '') {
        if (line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') === delim) flush();
        return;
      }
      if (quotes(line) % 2 === 1) open = !open;
      if (!open && !continues(line)) flush();
      return;
    }
    if (/^[ \t]*#/.test(line)) return;
    if (!SQLITE_CALL.test(line.replaceAll('command -v sqlite3', ''))) return;
    if (!/-readonly/.test(line) && VARIABLE_SQL.test(line)) {
      hits.push(`${file}:${i + 1}`);
      return;
    }
    start = i + 1;
    buf = line;
    const heredoc = HEREDOC.exec(line);
    if (heredoc) {
      delim = heredoc[0].replace(/^<<-?[ \t]*["']?/, '');
      return;
    }
    open = quotes(line) % 2 === 1;
    if (!open && !continues(line)) flush();
  });
  flush();
  return hits;
}

export function sqliteWriteViolations(root) {
  const files = [];
  scriptFiles(root, 'scripts', files);
  return files.sort().flatMap((rel) => directWrites(rel, readFileSync(join(root, rel), 'utf8')));
}

function failureMessage(violations) {
  return [
    `No-direct-sqlite-write: FAIL — ${violations.length} direct sqlite3 write(s):`,
    ...violations.map((v) => `  ${v}`),
    '  Route writes through dbWrite / auditAppend (mcp/trajectory-server/src/hooks/lib/audit.ts).',
  ].join('\n');
}

test('inline, multi-line, continued, heredoc and bare-variable writes are caught; reads pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-no-direct-sqlite-write-'));
  try {
    mkdirSync(join(dir, 'scripts', 'hooks'), { recursive: true });
    writeFileSync(
      join(dir, 'scripts', 'hooks', 'gate.sh'),
      [
        '#!/usr/bin/env bash',
        'command -v sqlite3 >/dev/null || exit 0',
        '# sqlite3 "$DB" "DELETE FROM x"',
        'sqlite3 "$DB" "SELECT 1"',
        'sqlite3 "$DB" "insert into audit values (1)"',
        'sqlite3 "$DB" "',
        '  UPDATE tasks SET status = 1',
        '"',
        'sqlite3 "$DB" \\',
        '  "DELETE FROM tasks"',
        'sqlite3 "$DB" <<SQL',
        'INSERT INTO t VALUES (1);',
        'SQL',
        'sqlite3 "$DB" "$SQL"',
        'sqlite3 -readonly "$DB" "$SQL"',
        'sqlite3 "$DB" "SELECT updated_at FROM t"',
        '',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'scripts', 'hooks', 'notes.txt'), 'sqlite3 "$DB" "DELETE FROM x"\n');
    writeFileSync(join(dir, 'scripts', 'runner'), 'sqlite3 "$DB" "DELETE FROM x"\n');
    const violations = sqliteWriteViolations(dir);
    assert.deepEqual(violations, ['scripts/hooks/gate.sh:5', 'scripts/hooks/gate.sh:6', 'scripts/hooks/gate.sh:9', 'scripts/hooks/gate.sh:11', 'scripts/hooks/gate.sh:14', 'scripts/runner:1']);
    assert.match(failureMessage(violations), /^No-direct-sqlite-write: FAIL — 6 direct sqlite3 write\(s\):/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no direct sqlite3 writes in scripts', () => {
  const violations = sqliteWriteViolations(ROOT);
  assert.deepEqual(violations, [], failureMessage(violations));
});
