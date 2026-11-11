// L1 lint: TMB writes nothing to a hard-coded /tmp or /var/tmp path. Scratch files go under $TMPDIR (mktemp, `${TMPDIR:-/tmp}`, os.tmpdir()) or the project's <project>/.claude/<plugin>/ state dir. Scans scripts/, skills/, agents/, commands/ (JS/TS, Python, Markdown code) and mcp/trajectory-server/src/ (TypeScript). A line is a violation when it writes and its target is a literal /tmp, /private/tmp or /var/tmp path — directly or through a variable assigned one in the same file. Shell-command writes in Markdown: > / >> redirects (target), mkdir, tee, touch (any arg), mktemp (template or -p/--tmpdir dir), cp, mv, ln, install, rsync (last arg), TMPDIR=/tmp. JS/TS/Py writes: writeFileSync, mkdirSync, mkdtempSync, appendFileSync, cpSync, copyFileSync, renameSync, symlinkSync, createWriteStream, writeFile, mkdir, mkdtemp, appendFile, open(..., 'w'|'a'|'x'). Reads of /tmp paths and `${TMPDIR:-/tmp}` fallbacks are fine; comment lines are skipped. Allowlist: tests/l1-lint/no-tmp-writes.allowlist — repo-relative paths. Every run also checks fixtures/no-tmp-writes/, then runs every tests/l1-lint/*.sh and every other tests/l1-lint/*.test.mjs (node --test) with HOME at an empty temp dir, gh/glab/claude stubbed on PATH and TMB_L1_OFFLINE=1, and fails when the loop wrote under that HOME (the embedding model cache, ~/.cache/huggingface, excepted).
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { files, ROOT, scan } from './lib/no-tmp-writes.mjs';

const SELF = basename(fileURLToPath(import.meta.url));
const FIXTURES = 'tests/l1-lint/fixtures/no-tmp-writes';

function countViolations(rel) {
  return readFileSync(join(ROOT, rel), 'utf8').split('\n').filter((l) => l.includes('VIOLATION')).length;
}

function tmpDir() {
  return mkdtempSync(join((process.env.TMPDIR || tmpdir()).replace(/\/+$/, ''), 'tmb-no-tmp-writes.'));
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    out.push(p);
    if (entry.isDirectory() && !entry.isSymbolicLink()) walk(p, out);
  }
  return out;
}

function l1LoopFootprint() {
  const realHome = process.env.HOME ?? '';
  const home = tmpDir();
  const tools = tmpDir();
  try {
    for (const cli of ['gh', 'glab', 'claude']) {
      writeFileSync(join(tools, cli), `#!/usr/bin/env bash\necho "tmb test-stub: ${cli} blocked" >&2\nexit 97\n`);
      chmodSync(join(tools, cli), 0o755);
    }
    const env = {
      ...process.env,
      HOME: home,
      PATH: `${tools}:${process.env.PATH ?? ''}`,
      TMB_L1_OFFLINE: '1',
      TMB_TEST_REAL_HOME: realHome,
      MISE_DATA_DIR: process.env.MISE_DATA_DIR || `${realHome}/.local/share/mise`,
      MISE_CONFIG_DIR: process.env.MISE_CONFIG_DIR || `${realHome}/.config/mise`,
      MISE_STATE_DIR: `${tools}/mise-state`,
      MISE_CACHE_DIR: `${tools}/mise-cache`,
      TMB_MODEL_CACHE_DIR: process.env.TMB_MODEL_CACHE_DIR || process.env.HF_HOME || `${realHome}/.cache/huggingface`,
    };
    delete env.NODE_TEST_CONTEXT;
    const lintDir = join(ROOT, 'tests', 'l1-lint');
    const lints = readdirSync(lintDir).sort();
    for (const f of lints.filter((n) => n.endsWith('.sh'))) spawnSync('bash', [join(lintDir, f)], { env, stdio: 'ignore' });
    for (const f of lints.filter((n) => n.endsWith('.test.mjs') && n !== SELF)) {
      spawnSync(process.execPath, ['--test', join(lintDir, f)], { env, stdio: 'ignore' });
    }
    const cache = join(home, '.cache');
    const hf = join(cache, 'huggingface');
    return walk(home, [])
      .filter((p) => p !== cache && p !== hf && !p.startsWith(`${hf}/`))
      .map((p) => `$HOME${p.slice(home.length)}`)
      .sort();
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(tools, { recursive: true, force: true });
  }
}

test('fixtures bad.md and bad.ts: every VIOLATION line is reported', () => {
  const bad = scan([`${FIXTURES}/bad.md`, `${FIXTURES}/bad.ts`]);
  const expected = countViolations(`${FIXTURES}/bad.md`) + countViolations(`${FIXTURES}/bad.ts`);
  assert.equal(bad.length, expected, `no-tmp-writes self-test: expected ${expected} violations in bad fixtures, got ${bad.length}\n${bad.join('\n')}`);
});

test('fixtures good.md and good.ts: no violations', () => {
  const good = scan([`${FIXTURES}/good.md`, `${FIXTURES}/good.ts`]);
  assert.deepEqual(good, [], `no-tmp-writes self-test: false positives in good fixtures:\n${good.join('\n')}`);
});

test('the L1 loop writes nothing under an isolated HOME', () => {
  const leaked = l1LoopFootprint();
  assert.deepEqual(leaked, [], `no-tmp-writes self-test: the L1 loop wrote under an isolated HOME:\n${leaked.join('\n')}`);
});

test('no hard-coded /tmp writes', () => {
  const out = scan(files());
  assert.deepEqual(out, [], `No-tmp-writes: FAIL — writes to a hard-coded /tmp path (use $TMPDIR or <project>/.claude/<plugin>/):\n${out.join('\n')}`);
});
