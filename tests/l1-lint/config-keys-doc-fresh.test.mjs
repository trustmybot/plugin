// L1 lint: the generated key table in docs/reference/CONFIG_KEYS.md matches the plugin_config keys the code uses, each with a KEYS entry in scripts/maintenance/gen-config-keys-doc.mjs.
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GEN = join(ROOT, 'scripts', 'maintenance', 'gen-config-keys-doc.mjs');
const DOC = join('docs', 'reference', 'CONFIG_KEYS.md');

export function checkDoc(args = []) {
  try {
    execFileSync(process.execPath, [GEN, '--check', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stderr: '' };
  } catch (err) {
    return { ok: false, stderr: err.stderr ?? '' };
  }
}

test('a CONFIG_KEYS.md missing a generated row fails naming CONFIG_KEYS.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-config-keys-doc-fresh-'));
  try {
    mkdirSync(join(dir, 'docs', 'reference'), { recursive: true });
    const doc = readFileSync(join(ROOT, DOC), 'utf8');
    const dropped = doc
      .split('\n')
      .filter((line) => !line.startsWith('| `issue_sync` |'))
      .join('\n');
    assert.notEqual(dropped, doc);
    writeFileSync(join(dir, DOC), dropped);
    const result = checkDoc(['--root', dir]);
    assert.equal(result.ok, false);
    assert.match(result.stderr, /docs\/reference\/CONFIG_KEYS\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CONFIG_KEYS.md matches the plugin_config keys the code uses', () => {
  const result = checkDoc();
  assert.ok(
    result.ok,
    `${result.stderr}\n  To fix: add the key's KEYS entry in scripts/maintenance/gen-config-keys-doc.mjs if it is new, then run node scripts/maintenance/gen-config-keys-doc.mjs\nConfig-keys-doc-fresh: FAIL`,
  );
});

test('GH 2533: run through a symlinked directory, gen-config-keys-doc.mjs still runs main()', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-config-keys-doc-link-'));
  try {
    const link = join(dir, 'plugin');
    symlinkSync(ROOT, link);
    const run = spawnSync(
      process.execPath,
      [join(link, 'scripts', 'maintenance', 'gen-config-keys-doc.mjs'), '--check', '--root', join(dir, 'missing')],
      { encoding: 'utf8' },
    );
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
