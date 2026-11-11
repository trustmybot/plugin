// L1 lint: no audit_append() call in docs/, skills/, agents/, commands/, templates/agents/ or the top-level agent docs still passes the kind= argument dropped from the schema in rc.2; such calls are silently ignored but mislead readers.
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const KIND_REGEX = /audit_append[^)]*kind\s*=/;
const TARGETS = ['docs', 'skills', 'agents', 'commands', 'templates/agents', 'CLAUDE.md'];

function walk(abs, out) {
  if (!existsSync(abs)) return;
  if (statSync(abs).isFile()) {
    out.push(abs);
    return;
  }
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const child = join(abs, entry.name);
    if (entry.isDirectory()) walk(child, out);
    else if (entry.isFile()) out.push(child);
  }
}

export function kindArgHits(root, targets) {
  const files = [];
  for (const target of targets) walk(join(root, target), files);
  return files.flatMap((abs) => {
    const rel = abs.slice(root.length + 1);
    return readFileSync(abs, 'utf8')
      .split('\n')
      .flatMap((line, i) => (KIND_REGEX.test(line) ? [`${rel}:${i + 1}: audit_append() with deprecated kind= arg`] : []));
  });
}

test('the fixtures/audit-log-kind/has-kind.md fixture is caught', () => {
  const hits = kindArgHits(HERE, ['fixtures/audit-log-kind/has-kind.md']);
  assert.deepEqual(hits, ['fixtures/audit-log-kind/has-kind.md:5: audit_append() with deprecated kind= arg']);
});

test('no audit_append() passes the dropped kind= arg', () => {
  const hits = kindArgHits(ROOT, TARGETS);
  assert.deepEqual(hits, [], `${hits.join('\n')}\n\nno-audit-log-kind: FAIL`);
});
