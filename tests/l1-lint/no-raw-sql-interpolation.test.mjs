// L1 lint: no unguarded shell variable interpolations inside sqlite3 SQL strings. Heuristic over scripts/hooks, scripts/hooks/lib and scripts/lib (*.sh, top level of each): a line holding `$VAR` / `${VAR}` (braced or bare, upper- or lowercase) in a SQL context — the line itself calls sqlite3, tmb_db_write or tmb_gate_read (`command -v sqlite3` probes and `sqlite3-<name>` tokens dropped first), the line before is a `tmb_db_write|tmb_gate_read ... \` continuation, or a `sqlite3 ... <<` heredoc opened in the 20 lines before — is flagged unless one of the 10 lines before guards the variable: a tmb_sql_int / tmb_sql_quote call naming it or assigning it, a case-guard on it, or a printf '%d' of it; a SAFE_* name counts as guarded. The db-path argument ("$DB" right after sqlite3 + flags, or after tmb_db_write / tmb_gate_read) sits outside the SQL string — it is stripped before extraction, not exempted by name. Allowlist: tests/l1-lint/no-raw-sql-interpolation.allowlist, one repo-relative entry per line (# comments): <file>@<function> covers every line of the shell function, found by scanning `^<function>() {` to its closing `^}` so it survives line shifts; <file>:<line> exactly that line; <file> the whole file. A <file>@<function> entry whose file or function no longer exists is a FAIL. Every run also checks fixtures/no-raw-sql-interpolation/helper.sh shifted one line: the @function entry still covers it, a :line entry pinned to the old position goes stale, and a missing function fails.
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = join(ROOT, 'tests/l1-lint/fixtures/no-raw-sql-interpolation');
const ALLOWLIST = 'tests/l1-lint/no-raw-sql-interpolation.allowlist';

function readLines(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  lines.pop();
  return lines;
}

function resolveAllowlist(base, allowlist) {
  const resolved = new Set();
  const stale = [];
  if (!existsSync(join(base, allowlist))) return { resolved, stale };
  for (const entry of readLines(join(base, allowlist))) {
    if (entry === '' || entry.startsWith('#')) continue;
    const at = entry.lastIndexOf('@');
    if (at < 0) {
      resolved.add(entry);
      continue;
    }
    const file = entry.slice(0, at);
    const fn = entry.slice(at + 1);
    let range;
    if (existsSync(join(base, file))) {
      const lines = readLines(join(base, file));
      let start = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!start && lines[i].startsWith(`${fn}() {`)) start = i + 1;
        else if (start && /^\}\s*$/.test(lines[i])) {
          range = [start, i + 1];
          break;
        }
      }
    }
    if (!range) {
      stale.push(`  ${entry}: stale allowlist entry — function ${fn}() not found in ${file}`);
      continue;
    }
    for (let n = range[0]; n <= range[1]; n++) resolved.add(`${file}:${n}`);
  }
  return { resolved, stale };
}

function window(lines, from, to) {
  const start = Math.max(from, 1);
  return to < start ? lines.slice(start - 1, start) : lines.slice(start - 1, to);
}

export function scan(base, allowlist, files) {
  const { resolved, stale } = resolveAllowlist(base, allowlist);
  if (stale.length) return { stale, out: [] };
  const out = [];
  for (const script of files) {
    const lines = readLines(join(base, script));
    lines.forEach((line, idx) => {
      const lineNum = idx + 1;
      const prev = idx > 0 ? lines[idx - 1] : '';
      if (!line.includes('$')) return;
      const scanLine = line.replace(/(sqlite3|tmb_db_write|tmb_gate_read)[^"]*"\$\{?[A-Za-z_][A-Za-z_0-9]*\}?"/, '');
      const vars = [...new Set((scanLine.match(/\$\{?[A-Za-z_][A-Za-z_0-9]*/g) ?? []).map((v) => v.replace(/^\$\{?/, '')))].sort();
      if (!vars.length) return;
      const probe = line.split('command -v sqlite3').join('').split('sqlite3-').join('');
      let sql = /sqlite3|tmb_db_write|tmb_gate_read/.test(probe) || /(tmb_db_write|tmb_gate_read).*\\$/.test(prev);
      if (!sql) sql = window(lines, lineNum - 20, lineNum - 1).some((l) => /sqlite3[^#]*<</.test(l));
      if (!sql) return;
      const preceding = window(lines, lineNum - 10, lineNum - 1);
      const location = `${script}:${lineNum}`;
      for (const v of vars) {
        const guards = [
          new RegExp(`tmb_sql_int.*${v}|tmb_sql_quote.*${v}|${v}=\\$\\(tmb_sql_(int|quote)`),
          new RegExp(`case.*\\$${v}|case.*\\$\\{${v}\\}|tmb_sql_int.*\\$${v}`),
          new RegExp(`printf '%d'.*\\$${v}|printf '%d'.*\\$\\{${v}\\}`),
        ];
        if (v.startsWith('SAFE_') || preceding.some((l) => guards.some((g) => g.test(l)))) continue;
        if (resolved.has(location) || resolved.has(script)) continue;
        out.push(`${location}: unguarded $${v} in SQL context — use tmb_sql_int/tmb_sql_quote or a case-guard`);
      }
    });
  }
  return { stale: [], out };
}

test('fixture helper.sh shifted a line: @function covers it, a pinned :line goes stale, a missing function fails', () => {
  const tmp = mkdtempSync(join((process.env.TMPDIR || tmpdir()).replace(/\/+$/, ''), 'tmb-no-raw-sql-interpolation.'));
  try {
    const helper = readFileSync(join(FIXTURES, 'helper.sh'), 'utf8');
    const pinned = helper.split('\n').findIndex((l) => l.includes('"$sql"')) + 1;
    writeFileSync(join(tmp, 'helper.sh'), `# shifted\n${helper}`);
    writeFileSync(join(tmp, 'function.allowlist'), 'helper.sh@fixture_sqlite_ro\n');
    writeFileSync(join(tmp, 'line.allowlist'), `helper.sh:${pinned}\n`);
    writeFileSync(join(tmp, 'stale.allowlist'), 'helper.sh@fixture_gone\n');
    let r = scan(tmp, 'function.allowlist', ['helper.sh']);
    assert.ok(!r.stale.length && !r.out.length, `self-test: @function entry did not cover the shifted helper: ${[...r.stale, ...r.out].join('\n')}`);
    r = scan(tmp, 'line.allowlist', ['helper.sh']);
    assert.ok(!r.stale.length && r.out.length, 'self-test: stale :line entry still passed the shifted helper');
    r = scan(tmp, 'stale.allowlist', ['helper.sh']);
    assert.ok(r.stale.length, 'self-test: allowlist entry naming a missing function did not fail');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('an unguarded interpolation is flagged, a case-guarded one is not', () => {
  const tmp = mkdtempSync(join((process.env.TMPDIR || tmpdir()).replace(/\/+$/, ''), 'tmb-no-raw-sql-interpolation.'));
  try {
    writeFileSync(join(tmp, 'bad.sh'), 'f() {\n  sqlite3 "$DB" "SELECT * FROM t WHERE id=$id"\n}\n');
    writeFileSync(join(tmp, 'good.sh'), "f() {\n  case \"$id\" in ''|*[!0-9]*) return 1 ;; esac\n  sqlite3 \"$DB\" \"SELECT * FROM t WHERE id=$id\"\n}\n");
    assert.deepEqual(scan(tmp, 'none.allowlist', ['bad.sh']).out, [
      'bad.sh:2: unguarded $id in SQL context — use tmb_sql_int/tmb_sql_quote or a case-guard',
    ]);
    assert.deepEqual(scan(tmp, 'none.allowlist', ['good.sh']).out, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('no raw SQL interpolation in hooks', () => {
  const files = ['scripts/hooks', 'scripts/hooks/lib', 'scripts/lib']
    .filter((d) => existsSync(join(ROOT, d)))
    .flatMap((d) =>
      readdirSync(join(ROOT, d), { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.sh'))
        .map((e) => `${d}/${e.name}`),
    )
    .sort();
  const { stale, out } = scan(ROOT, ALLOWLIST, files);
  assert.deepEqual(stale, [], `No-raw-sql-interpolation: FAIL — stale allowlist entries:\n${stale.join('\n')}`);
  assert.deepEqual(out, [], `No-raw-sql-interpolation: FAIL — ${out.length} violation(s):\n${out.map((l) => `  ${l}`).join('\n')}`);
});
