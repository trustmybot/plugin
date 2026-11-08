// L1 lint: scripts/hooks/lib/ tracks no file, so on a fresh checkout the build's generators (gen-enums-doc.mjs --txt, emit-data-contracts.mjs) must create it before writing (build the server first).
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIB = join('scripts', 'hooks', 'lib');

function stage(dir) {
  for (const rel of [join('scripts', 'maintenance', 'gen-enums-doc.mjs'), join('scripts', 'maintenance', 'emit-data-contracts.mjs'), join('docs', 'contributing', 'ENUMS.md')]) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(dir, rel));
  }
  mkdirSync(join(dir, 'mcp', 'trajectory-server'), { recursive: true });
  symlinkSync(join(ROOT, 'mcp', 'trajectory-server', 'dist'), join(dir, 'mcp', 'trajectory-server', 'dist'), 'dir');
}

test('both generators create scripts/hooks/lib/ when it is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-generators-lib-dir-'));
  try {
    stage(dir);
    assert.equal(existsSync(join(dir, LIB)), false);
    execFileSync(process.execPath, [join(dir, 'scripts', 'maintenance', 'gen-enums-doc.mjs'), '--txt'], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync(process.execPath, [join(dir, 'scripts', 'maintenance', 'emit-data-contracts.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
    for (const name of ['audit-events.txt', 'data-contracts.json']) {
      assert.equal(
        readFileSync(join(dir, LIB, name), 'utf8'),
        readFileSync(join(ROOT, LIB, name), 'utf8'),
        `${name} generated into a missing ${LIB}/ differs from the checkout's\nGenerators-create-lib-dir: FAIL`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
