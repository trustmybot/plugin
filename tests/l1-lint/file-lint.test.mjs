// L1 lint: the per-file L1 lint runner, tests/l1-lint/file-lint.ts (GH 2570). Planted trees show it flags a secret, a cwd read, a /tmp write and a hardcoded plugin name by lint and line, passes a clean file, leaves a file outside a lint's scope to the lints that cover it, skips missing, binary and outside-root paths, keeps no-negative-directives warn-only, and lints a dot-directory path that .config/tmb/edit-lint.json's globs match. Each lint's per-file scope must select the same repo files as its whole-tree test, and the runner passes the repo's own run-all.ts and swe-edit-lint.ts.
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, matchesGlob } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as cliConfigScope from './lib/cli-config-scope.mjs';
import { LINTS } from './lib/file-lints.mjs';
import * as bareMktemp from './lib/no-bare-mktemp.mjs';
import * as citations from './lib/no-citations-in-prompts.mjs';
import * as cwdReads from './lib/no-cwd-reads.mjs';
import * as developerPaths from './lib/no-developer-paths.mjs';
import * as hardcodedName from './lib/no-hardcoded-plugin-name.mjs';
import * as homeWrites from './lib/no-home-writes.mjs';
import * as negativeDirectives from './lib/no-negative-directives.mjs';
import * as repoPaths from './lib/no-repo-paths-in-prompts.mjs';
import * as secrets from './lib/no-secrets-in-source.mjs';
import * as tmpWrites from './lib/no-tmp-writes.mjs';
import * as wallClock from './lib/no-wall-clock-asserts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const RUNNER = join(HERE, 'file-lint.ts');
const AWS_KEY = 'AKIA' + 'Q3VZ7RT2LMNB4KWD';

// swe-edit-lint's glob match, lint-fingerprint.ts matchesInput: `*` and `**` match dot segments too.
const maskDots = (s) => s.replace(/(^|\/)\./g, '$1\u0001');
const matchesInput = (path, glob) => matchesGlob(path, glob) || matchesGlob(maskDots(path), maskDots(glob));

function run(cwd, ...paths) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', RUNNER, ...paths], { cwd, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('planted trees', () => {
  let root;
  before(() => {
    root = mkdtempSync(join((process.env.TMPDIR || tmpdir()).replace(/\/+$/, ''), 'tmb-file-lint.'));
    const plant = (rel, text) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    plant('scripts/creds.sh', `#!/usr/bin/env bash\nKEY="${AWS_KEY}"\n`);
    plant('scripts/root.sh', '#!/usr/bin/env bash\nROOT="$PWD"\n');
    plant('scripts/tmpw.ts', "import { writeFileSync } from 'node:fs';\nwriteFileSync('/tmp/x.log', 'hi');\n");
    plant('scripts/name.ts', "export {};\nconst STATE = '.claude/tmb/state';\n");
    plant('scripts/ok.sh', '#!/usr/bin/env bash\necho ok\n');
    plant('docs/name.ts', "export {};\nconst STATE = '.claude/tmb/state';\n");
    plant('docs/creds.md', `KEY="${AWS_KEY}"\n`);
    plant('scripts/blob.sh', `KEY="${AWS_KEY}"\0\n`);
    plant('.github/x.yml', `env:\n  KEY: ${AWS_KEY}\n`);
    plant('CLAUDE.md', '# Persona\n\nYou MUST NOT guess.\n');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  for (const [rel, lint, line] of [
    ['scripts/creds.sh', 'no-secrets-in-source', 2],
    ['scripts/root.sh', 'no-cwd-reads', 2],
    ['scripts/tmpw.ts', 'no-tmp-writes', 2],
    ['scripts/name.ts', 'no-hardcoded-plugin-name', 2],
  ]) {
    test(`${rel} exits 1, naming ${lint} and line ${line}`, () => {
      const r = run(root, rel);
      assert.equal(r.code, 1, r.out);
      assert.ok(r.out.split('\n').some((l) => l.startsWith(`${lint}: ${rel}:${line}: `)), r.out);
    });
  }

  test('a clean file exits 0 with no output', () => {
    const r = run(root, 'scripts/ok.sh');
    assert.equal(r.code, 0, r.out);
    assert.equal(r.out, '');
  });

  test('a file outside a lint scope is not flagged by that lint', () => {
    const name = run(root, 'docs/name.ts');
    assert.equal(name.code, 0, name.out);
    const secret = run(root, 'docs/creds.md');
    assert.equal(secret.code, 0, secret.out);
  });

  test('missing, binary and outside-root paths are skipped with exit 0', () => {
    for (const path of ['scripts/gone.sh', 'scripts/blob.sh', '../elsewhere.sh', join(dirname(root), 'elsewhere.sh')]) {
      const r = run(root, path);
      assert.equal(r.code, 0, `${path}: ${r.out}`);
      assert.equal(r.out, '', path);
    }
  });

  test('an absolute path under the root is linted as its relative path', () => {
    const r = run(root, join(root, 'scripts/name.ts'));
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes('no-hardcoded-plugin-name: scripts/name.ts:2: '), r.out);
  });

  test('several paths: one failing path fails the run, and each finding prints', () => {
    const r = run(root, 'scripts/ok.sh', 'scripts/root.sh', 'scripts/name.ts');
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes('no-cwd-reads: scripts/root.sh:2: '), r.out);
    assert.ok(r.out.includes('no-hardcoded-plugin-name: scripts/name.ts:2: '), r.out);
  });

  test('no-negative-directives stays warn-only', () => {
    const r = run(root, 'CLAUDE.md');
    assert.equal(r.code, 0, r.out);
    assert.ok(r.out.includes('warn-only no-negative-directives: CLAUDE.md:3: [WARN] MUST NOT'), r.out);
  });

  test('a dot-directory path is matched by edit-lint.json and linted', () => {
    const config = JSON.parse(readFileSync(join(ROOT, '.config/tmb/edit-lint.json'), 'utf8'));
    const matching = config.lints.filter((l) => matchesInput('.github/x.yml', l.glob));
    assert.equal(matching.length, 1, JSON.stringify(config.lints));
    assert.equal(matching[0].command, 'node --experimental-strip-types tests/l1-lint/file-lint.ts');
    const r = run(root, '.github/x.yml');
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes('no-secrets-in-source: .github/x.yml:2: '), r.out);
  });
});

test('edit-lint.json globs run the runner exactly once on every kind of path', () => {
  const config = JSON.parse(readFileSync(join(ROOT, '.config/tmb/edit-lint.json'), 'utf8'));
  assert.equal(config.version, 1);
  for (const rel of ['README.md', 'scripts/lib/x.sh', '.gitignore', 'scripts/.hidden', '.github/workflows/ci.yml', '.config/tmb/edit-lint.json', 'scripts/.cache/x.sh']) {
    const matching = config.lints.filter((l) => matchesInput(rel, l.glob));
    assert.equal(matching.length, 1, `${rel}: ${matching.map((l) => l.glob).join(', ')}`);
  }
});

test("the runner passes the repo's run-all.ts and swe-edit-lint.ts", () => {
  const r = run(ROOT, 'tests/run-all.ts', 'mcp/trajectory-server/src/hooks/swe-edit-lint.ts');
  assert.equal(r.code, 0, r.out);
});

test("each lint's per-file scope selects the same repo files as its whole-tree test", () => {
  const universe = execFileSync('git', ['ls-files', '--cached'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter((rel) => {
      if (rel === '') return false;
      try {
        return lstatSync(join(ROOT, rel)).isFile();
      } catch {
        return false;
      }
    });
  const rel = (abs) => abs.slice(ROOT.length + 1);
  const wholeTree = {
    'no-secrets-in-source': () => secrets.trackedFiles().filter(secrets.scope()),
    'no-negative-directives': () => negativeDirectives.files().map(rel),
    'no-repo-paths-in-prompts': () => repoPaths.files(ROOT),
    'no-citations-in-prompts': () => citations.files(ROOT),
    'no-hardcoded-plugin-name': () => hardcodedName.files(ROOT),
    'no-developer-paths': () => developerPaths.files(ROOT),
    'no-cwd-reads': () => cwdReads.files().map(rel),
    'no-tmp-writes': () => tmpWrites.files(),
    'no-home-writes': () => homeWrites.files(),
    'no-wall-clock-asserts': () => wallClock.testFiles(),
    'no-bare-mktemp': () => bareMktemp.files(),
    'cli-config-scope': () => cliConfigScope.files(),
  };
  assert.deepEqual(LINTS.map((l) => l.name).sort(), Object.keys(wholeTree).sort());
  const inUniverse = new Set(universe);
  for (const lint of LINTS) {
    const fromTree = [...new Set(wholeTree[lint.name]())].filter((f) => inUniverse.has(f)).sort();
    const fromScope = universe.filter(lint.lib.scope(ROOT)).sort();
    // A lint whose file kind the repo no longer tracks (no-bare-mktemp's shell scripts, retired by GH 2662) has nothing to compare.
    if (fromScope.length === 0 && fromTree.length === 0) continue;
    assert.ok(fromTree.length > 0, `${lint.name}: the whole-tree list is empty`);
    assert.deepEqual(fromScope, fromTree, `${lint.name}: per-file scope and whole-tree list differ`);
  }
});
