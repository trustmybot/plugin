// L1 lint: the trajectory-DB location rule lives in exactly two places — the server's findExistingClaudeDbUp (mcp/trajectory-server/src/platform.ts) and the hooks' dbPath (mcp/trajectory-server/src/hooks/lib/db.ts), documented once in docs/architecture/MEMORY.md#where-the-trajectory-db-lives. A third copy starts with spelling the DB filename, so this lint fails on any `trajectory.db` literal (code or comment) in a file under scripts/; markdown under scripts/ is prose, not resolution logic, and is skipped. Allowlist: tests/l1-lint/no-private-db-path.allowlist, one repo-relative path per line (# comments allowed), for scripts that name the file without resolving it. Every run also plants a literal in a temp scripts/ tree.
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOWLIST = 'tests/l1-lint/no-private-db-path.allowlist';

function filesUnder(base, rel) {
  const found = [];
  if (!existsSync(join(base, rel))) return found;
  for (const e of readdirSync(join(base, rel), { withFileTypes: true })) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) found.push(...filesUnder(base, child));
    else if (e.isFile() && !e.name.endsWith('.md')) found.push(child);
  }
  return found;
}

export function scan(base) {
  const allowed = new Set();
  if (existsSync(join(base, ALLOWLIST))) {
    for (const line of readFileSync(join(base, ALLOWLIST), 'utf8').split('\n')) {
      if (!/^\s*#/.test(line)) allowed.add(line);
    }
  }
  const hits = [];
  for (const file of filesUnder(base, 'scripts')) {
    if (allowed.has(file)) continue;
    readFileSync(join(base, file), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (line.includes('trajectory.db')) hits.push(`${file}:${i + 1}:${line}`);
      });
  }
  return hits.sort();
}

function failMessage(hits) {
  return (
    `no-private-db-path: FAIL — trajectory DB path spelled under scripts/:\n${hits.map((h) => `  ${h}\n`).join('')}` +
    'Resolve the DB through findExistingClaudeDbUp (mcp/trajectory-server/src/platform.ts) or dbPath (mcp/trajectory-server/src/hooks/lib/db.ts).'
  );
}

test('self-test: a planted trajectory.db literal outside the allowlist fails', () => {
  const tmp = mkdtempSync(join((process.env.TMPDIR || tmpdir()).replace(/\/+$/, ''), 'tmb-no-private-db-path.'));
  try {
    mkdirSync(join(tmp, 'scripts/hooks/lib'), { recursive: true });
    mkdirSync(join(tmp, dirname(ALLOWLIST)), { recursive: true });
    writeFileSync(join(tmp, 'scripts/named.sh'), '# trajectory.db\n');
    writeFileSync(join(tmp, 'scripts/README.md'), 'trajectory.db\n');
    writeFileSync(join(tmp, ALLOWLIST), '# named only\nscripts/named.sh\n');
    assert.deepEqual(scan(tmp), []);
    writeFileSync(join(tmp, 'scripts/hooks/lib/private.sh'), 'x=1\nDB="$ROOT/.claude/tmb/trajectory.db"\n');
    assert.deepEqual(scan(tmp), ['scripts/hooks/lib/private.sh:2:DB="$ROOT/.claude/tmb/trajectory.db"']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the DB filename appears under scripts/ only in allowlisted files', () => {
  const hits = scan(ROOT);
  assert.deepEqual(hits, [], failMessage(hits));
});
