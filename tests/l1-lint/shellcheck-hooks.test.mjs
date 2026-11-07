// L1 lint: shellcheck every shell script in scripts/ and tests/, catching the `set -o pipefail` silent-allow class, unquoted variables and command-substitution races; skipped when shellcheck is not installed.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function hasShellcheck() {
  try {
    execFileSync('shellcheck', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function walkShellFiles(root, rel, out) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) walkShellFiles(root, child, out);
    else if (entry.isFile() && entry.name.endsWith('.sh')) out.push(child);
  }
}

export function shellFiles(root) {
  const out = [];
  for (const dir of ['scripts', 'tests']) walkShellFiles(root, dir, out);
  return out.sort();
}

export function shellcheckFailures(root, files = shellFiles(root)) {
  const failures = [];
  for (const script of files) {
    try {
      execFileSync('shellcheck', ['-S', 'warning', '-e', 'SC1091', script], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      failures.push({ script, output: `${err.stdout ?? ''}${err.stderr ?? ''}` });
    }
  }
  return failures;
}

function failureMessage(failures) {
  return [...failures.map((f) => `${f.output}  ✗ ${f.script}`), '', 'Shellcheck-hooks: FAIL'].join('\n');
}

const skip = hasShellcheck() ? false : "shellcheck not installed — skipping (install via 'brew install shellcheck' or 'apt-get install shellcheck')";

test('a script with an unquoted variable fails shellcheck', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-shellcheck-hooks-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'bad.sh'), '#!/usr/bin/env bash\nrm -rf $1/*\n');
    writeFileSync(join(dir, 'scripts', 'good.sh'), '#!/usr/bin/env bash\nprintf "%s\\n" "$1"\n');
    assert.deepEqual(shellFiles(dir), ['scripts/bad.sh', 'scripts/good.sh']);
    const failures = shellcheckFailures(dir);
    assert.deepEqual(failures.map((f) => f.script), ['scripts/bad.sh']);
    assert.match(failureMessage(failures), /✗ scripts\/bad\.sh[\s\S]*Shellcheck-hooks: FAIL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every shell script in scripts/ and tests/ is shellcheck-clean', { skip, timeout: 600000 }, () => {
  const failures = shellcheckFailures(ROOT);
  assert.deepEqual(failures.map((f) => f.script), [], failureMessage(failures));
});
