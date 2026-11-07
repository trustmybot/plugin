// L1 lint: every shipped agent (agents/*.md except README.md) and agent template (templates/agents/*.md) declares its subagent prompt-cache TTL in frontmatter as `experimental:` with one nested `  cacheTtl: 1h | 5m`; agents/swe.md must request 1h (it idles through multi-minute builds and test suites between turns). Every run also checks fixtures/agent-cache-ttl/ (missing block, bad value).
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = join(ROOT, 'tests', 'l1-lint', 'fixtures', 'agent-cache-ttl');

function frontmatter(text) {
  const out = [];
  let fences = 0;
  for (const line of text.split('\n')) {
    if (line === '---') {
      fences++;
      if (fences === 2) break;
      continue;
    }
    if (fences === 1) out.push(line);
  }
  return out;
}

function nestedCacheTtls(fm) {
  const out = [];
  let inblock = false;
  for (const line of fm) {
    if (/^experimental:\s*$/.test(line)) {
      inblock = true;
      continue;
    }
    if (inblock && /^ {2}[^ ]/.test(line)) {
      if (line.startsWith('  cacheTtl:')) out.push(line.replace(/^ {2}cacheTtl:\s*/, '').replace(/\s+$/, ''));
      continue;
    }
    inblock = false;
  }
  return out;
}

function checkFile(file, rel) {
  const fm = frontmatter(readFileSync(file, 'utf8'));
  const expCount = fm.filter((l) => /^experimental:\s*$/.test(l)).length;
  if (expCount !== 1) return { ok: false, line: `  ❌ ${rel}: expected exactly one 'experimental:' frontmatter line, found ${expCount}` };
  const ttl = nestedCacheTtls(fm).join('\n').replace(/\n+$/, '');
  const ttlCount = ttl.split('\n').filter((l) => l !== '').length;
  if (ttlCount !== 1) return { ok: false, line: `  ❌ ${rel}: expected exactly one '  cacheTtl:' nested under 'experimental:', found ${ttlCount}` };
  if (ttl !== '1h' && ttl !== '5m') return { ok: false, line: `  ❌ ${rel}: cacheTtl '${ttl}' is not 1h or 5m` };
  if (rel === 'agents/swe.md' && ttl !== '1h') return { ok: false, line: `  ❌ ${rel}: swe must declare cacheTtl 1h, found ${ttl}` };
  return { ok: true, line: `  ✓ ${rel}: cacheTtl ${ttl}` };
}

export function cacheTtlReport(root) {
  const results = [];
  for (const dirRel of ['agents', 'templates/agents']) {
    const dir = join(root, dirRel);
    if (!existsSync(dir)) continue;
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md')
      .map((e) => e.name)
      .sort();
    for (const name of names) results.push(checkFile(join(dir, name), `${dirRel}/${name}`));
  }
  return results;
}

test('a missing experimental block is caught', () => {
  assert.deepEqual(cacheTtlReport(join(FIXTURES, 'missing')), [
    { ok: false, line: "  ❌ agents/swe.md: expected exactly one 'experimental:' frontmatter line, found 0" },
  ]);
});

test('a cacheTtl outside 1h and 5m is caught; a valid one passes', () => {
  assert.deepEqual(cacheTtlReport(join(FIXTURES, 'bad-value')), [
    { ok: true, line: '  ✓ agents/swe.md: cacheTtl 1h' },
    { ok: false, line: "  ❌ templates/agents/cto.md: cacheTtl '30m' is not 1h or 5m" },
  ]);
});

test('swe declaring 5m and a cacheTtl outside the experimental block are caught', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-agent-cache-ttl-'));
  try {
    mkdirSync(join(dir, 'agents'));
    writeFileSync(join(dir, 'agents', 'swe.md'), '---\nname: swe\nexperimental:\n  cacheTtl: 5m\n---\n');
    writeFileSync(join(dir, 'agents', 'cto.md'), '---\nname: cto\nexperimental:\nother: x\n  cacheTtl: 5m\n---\n');
    writeFileSync(join(dir, 'agents', 'README.md'), '# agents\n');
    assert.deepEqual(cacheTtlReport(dir), [
      { ok: false, line: "  ❌ agents/cto.md: expected exactly one '  cacheTtl:' nested under 'experimental:', found 0" },
      { ok: false, line: '  ❌ agents/swe.md: swe must declare cacheTtl 1h, found 5m' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent frontmatter declares experimental.cacheTtl', (t) => {
  const results = cacheTtlReport(ROOT);
  assert.ok(results.length > 0, `  ❌ no agent files found under ${ROOT}`);
  for (const r of results) t.diagnostic(r.line);
  const failed = results.filter((r) => !r.ok).map((r) => r.line);
  assert.deepEqual(failed, [], `${failed.join('\n')}\n${failed.length} agent file(s) failed the cacheTtl check.`);
  t.diagnostic(`All ${results.length} agent file(s) declare a valid cacheTtl.`);
});
