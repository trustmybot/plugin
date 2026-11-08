// L1 lint: docs/contributing/ENUMS.md and the code agree, both ways, on eight
// controlled vocabularies: audit.event_type, audit.from_node, tasks.status,
// issues.status, validation_attempts.verdict, discussions.kind,
// milestones.state and agent_runs.usage_source.
//
//   code → doc  every value found in mcp/trajectory-server/src/ (the schema.sql
//               CHECK lists and the literals written or compared) and scripts/
//               (including the event types hooks pass to tmb_audit_append /
//               tmb_audit_sql) is a documented value.
//   doc → code  every documented value appears in that code, unless its row is
//               marked `reserved`.
//
// Comments in .ts/.mjs/.js files and prefix tests of 'hook:' are not uses; a
// constant passed as insertAudit's event_type counts as its string value.
// src/test/ is not code for this purpose; audit-events.ts and the generated
// scripts/hooks/lib/audit-events.txt are the enum's own source and are skipped
// so a documented event must be written or read somewhere else.
//
// Literal extraction is enums-stable-extract.pl. Run as the entry point it
// self-tests fixtures/enums-stable/, then checks process.argv[2] (default: this
// repo). enumsStable(root) checks another tree and returns its failure lines.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const EXTRACT = join(HERE, 'enums-stable-extract.pl');
const FIXTURES = join(HERE, 'fixtures/enums-stable');

const SECTIONS = [
  'audit.event_type',
  'audit.from_node',
  'tasks.status',
  'issues.status',
  'validation_attempts.verdict',
  'discussions.kind',
  'milestones.state',
  'agent_runs.usage_source',
];
const HOOK_NODE = /^hook:[a-z0-9-]+$/;
const RESERVED_ROW = /\| reserved( |$|—)/;
const ROW_VALUE = /^\| `([^`]+)`/;
const HINT =
  '  Document the value in docs/contributing/ENUMS.md (audit.event_type: add it to mcp/trajectory-server/src/audit-events.ts and regenerate), or remove the stale row.';

const sortedUnique = (values) => [...new Set(values)].sort();

function sectionRows(doc, section) {
  const heading = `### \`${section}\``;
  const rows = [];
  let inSection = false;
  for (const line of doc.split('\n')) {
    if (line.startsWith(heading)) {
      inSection = true;
      continue;
    }
    if (inSection && line.startsWith('### ')) inSection = false;
    if (inSection && line.startsWith('| `')) rows.push(line);
  }
  return rows;
}

function docValues(doc, section, reservedOnly = false) {
  const rows = sectionRows(doc, section).filter((row) => !reservedOnly || RESERVED_ROW.test(row));
  return sortedUnique(
    rows
      .map((row) => ROW_VALUE.exec(row)?.[1])
      .filter((value) => value !== undefined && !value.includes('<')),
  );
}

function walkFiles(dir, keep) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path, keep));
    else if (entry.isFile() && keep(path, entry.name)) out.push(path);
  }
  return out;
}

function codeFiles(root) {
  const src = join(root, 'mcp/trajectory-server/src');
  const scripts = join(root, 'scripts');
  const files = [];
  if (existsSync(src)) {
    files.push(
      ...walkFiles(src, (path, name) => /\.(ts|sql)$/.test(name) && !path.includes('/src/test/') && name !== 'audit-events.ts'),
    );
  }
  if (existsSync(scripts)) {
    files.push(...walkFiles(scripts, (_path, name) => /\.(sh|mjs|js|sql)$/.test(name) && name !== 'audit-events.txt'));
  }
  return files.sort();
}

function extract(section, schema, files) {
  const r = spawnSync('perl', [EXTRACT, section, schema, ...files], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return (r.stdout ?? '')
    .split('\n')
    .map((line) => {
      const tab = line.indexOf('\t');
      return tab === -1 ? { value: line, file: '' } : { value: line.slice(0, tab), file: line.slice(tab + 1) };
    })
    .filter(({ value }) => value !== '');
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function quotedIn(files, value) {
  const quoted = new RegExp(`['"]${escapeRegExp(value)}['"]`);
  return files.some((file) => {
    try {
      return quoted.test(readFileSync(file, 'utf8'));
    } catch {
      return false;
    }
  });
}

/** Every check over <root>; returns the failure lines, empty when the tree passes. */
export function enumsStable(root) {
  const docPath = join(root, 'docs/contributing/ENUMS.md');
  const schema = join(root, 'mcp/trajectory-server/src/schema.sql');
  if (!existsSync(docPath)) return [`  ✗ ENUMS.md missing at ${docPath}`];
  const doc = readFileSync(docPath, 'utf8');
  const files = codeFiles(root);
  const rel = (file) => (file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file);
  const failures = [];

  for (const section of SECTIONS) {
    const documented = docValues(doc, section);
    const reserved = new Set(docValues(doc, section, true));
    if (documented.length === 0) {
      failures.push(`  ✗ ENUMS.md has no \`${section}\` table`);
      continue;
    }
    const documentedSet = new Set(documented);
    const found = extract(section, schema, files);

    for (const { value, file } of found) {
      if (section === 'audit.from_node' && value.startsWith('hook:')) {
        if (!HOOK_NODE.test(value)) {
          failures.push(`  ✗ from_node '${value}' in ${rel(file)} does not match hook:[a-z0-9-]+`);
        } else if (!sectionRows(doc, section).some((row) => row.includes('`hook:<name>`'))) {
          failures.push('  ✗ ENUMS.md `audit.from_node` is missing the hook:<name> convention row');
        }
        continue;
      }
      if (!documentedSet.has(value)) {
        failures.push(`  ✗ ${section} '${value}' used in ${rel(file)} but missing from ENUMS.md`);
      }
    }

    const foundValues = new Set(found.map(({ value }) => value));
    for (const value of documented) {
      if (reserved.has(value) || foundValues.has(value)) continue;
      if (section === 'audit.from_node' && files.length > 0 && quotedIn(files, value)) continue;
      failures.push(
        `  ✗ ${section} '${value}' documented in ENUMS.md but not found in src/ or scripts/ (remove it, or mark its row reserved)`,
      );
    }
  }
  return failures;
}

/** fixtures/enums-stable/base with the <overlay> tree copied over it, in a fresh temp dir. */
function fixtureTree(overlay) {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-enums-stable-'));
  const tree = join(dir, overlay ?? 'base');
  cpSync(join(FIXTURES, 'base'), tree, { recursive: true });
  if (overlay !== undefined) cpSync(join(FIXTURES, overlay), tree, { recursive: true });
  return { tree: realpathSync(tree), remove: () => rmSync(dir, { recursive: true, force: true }) };
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  test('self-test: fixtures/enums-stable/base passes', () => {
    const { tree, remove } = fixtureTree();
    try {
      const failures = enumsStable(tree);
      assert.equal(failures.length, 0, ['  ✗ self-test: fixtures/enums-stable/base should pass:', ...failures].join('\n'));
    } finally {
      remove();
    }
  });

  for (const overlay of ['undocumented', 'unused']) {
    test(`self-test: fixtures/enums-stable/${overlay} fails naming its EXPECT`, () => {
      const want = readFileSync(join(FIXTURES, overlay, 'EXPECT'), 'utf8').replace(/\n+$/, '');
      const { tree, remove } = fixtureTree(overlay);
      try {
        const failures = enumsStable(tree);
        assert.ok(failures.length > 0, `  ✗ self-test: fixtures/enums-stable/${overlay} should fail`);
        assert.ok(
          failures.join('\n').includes(want),
          [`  ✗ self-test: fixtures/enums-stable/${overlay} failed without naming: ${want}`, ...failures].join('\n'),
        );
      } finally {
        remove();
      }
    });
  }

  const target = process.argv[2] ?? ROOT;
  test('8 enums agree between ENUMS.md and src/ + scripts/ both ways', () => {
    const failures = enumsStable(target);
    assert.equal(failures.length, 0, [...failures, '', HINT, 'Enums-stable: FAIL'].join('\n'));
  });
}
