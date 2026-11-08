import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectEnvEvidence } from '../env/collect.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXTURES = join(PLUGIN_ROOT, 'tests', 'fixtures', 'env');
const SERVER_SRC = join(PLUGIN_ROOT, 'mcp', 'trajectory-server', 'src');

const temps: string[] = [];
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

// A fixture copied without its expected.json, so the answer key is not itself evidence.
function fixtureCopy(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `tmb-env-${name}-`));
  temps.push(dir);
  cpSync(join(FIXTURES, name), dir, { recursive: true, filter: (src) => basename(src) !== 'expected.json' });
  return dir;
}

function place(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

const MANIFEST = '{ "name": "nested" }\n';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => join(e.parentPath, e.name));
}

const fixtures = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

describe('GH 2066 collectEnvEvidence fixtures', () => {
  it('GH 2066 ships at least ten fixtures, each with an expected.json', () => {
    assert.ok(fixtures.length >= 10, `fixtures: ${fixtures.join(', ')}`);
    for (const name of fixtures) assert.ok(existsSync(join(FIXTURES, name, 'expected.json')), `${name}/expected.json`);
  });

  for (const name of fixtures) {
    it(`GH 2066 ${name} matches expected.json`, () => {
      const expected = JSON.parse(readFileSync(join(FIXTURES, name, 'expected.json'), 'utf8')) as unknown;
      const actual = JSON.parse(JSON.stringify(collectEnvEvidence(fixtureCopy(name)))) as unknown;
      assert.deepEqual(actual, expected);
    });
  }

  it('GH 2066 monorepo-mixed reports one entry per package root, sorted by package_path', () => {
    const out = collectEnvEvidence(fixtureCopy('monorepo-mixed'));
    assert.deepEqual(
      out.map((p) => p.package_path),
      ['.', 'services/api'],
    );
  });

  it('GH 2066 ci-block-scalar reports a run: | step once, at its run: line', () => {
    const steps = collectEnvEvidence(fixtureCopy('ci-block-scalar'))[0]!.ci_steps;
    const block = steps.filter((s) => s.run.includes('npm ci'));
    assert.equal(block.length, 1);
    assert.equal(block[0]!.line, 10);
    assert.equal(block[0]!.run.split('\n').length, 4);
    assert.ok(!steps.some((s) => s.run === 'npm test'), 'block lines are not separate steps');
  });

  it('GH 2066 makefile-sentinel lists the lint target without running it', () => {
    const dir = join(FIXTURES, 'makefile-sentinel');
    const targets = collectEnvEvidence(dir)[0]!.runner_targets;
    assert.ok(targets.some((t) => t.name === 'lint' && t.command.includes('SENTINEL')));
    assert.equal(existsSync(join(dir, 'SENTINEL')), false);
    const copy = fixtureCopy('makefile-sentinel');
    collectEnvEvidence(copy);
    assert.equal(existsSync(join(copy, 'SENTINEL')), false);
  });
});

describe('GH 2066 collectEnvEvidence walk and hash', () => {
  it('GH 2066 evidence_hash is stable across runs and changes when an evidence file changes', () => {
    const dir = fixtureCopy('uv-ruff-mypy-pytest');
    const first = collectEnvEvidence(dir)[0]!.evidence_hash;
    assert.equal(collectEnvEvidence(dir)[0]!.evidence_hash, first);
    writeFileSync(join(dir, 'src', 'sample', 'extra.py'), 'X = 1\n');
    assert.equal(collectEnvEvidence(dir)[0]!.evidence_hash, first, 'a source file is not evidence');
    writeFileSync(join(dir, 'pyproject.toml'), `${readFileSync(join(dir, 'pyproject.toml'), 'utf8')}\n[tool.coverage]\n`);
    assert.notEqual(collectEnvEvidence(dir)[0]!.evidence_hash, first);
  });

  it('GH 2066 skips vendored, build and dot directories but keeps .github', () => {
    const dir = fixtureCopy('ci-block-scalar');
    for (const skipped of ['node_modules/dep', '.venv/lib', 'venv', 'dist', 'build', 'target', '.cache', '.git']) {
      place(dir, `${skipped}/package.json`, MANIFEST);
    }
    const out = collectEnvEvidence(dir);
    assert.deepEqual(
      out.map((p) => p.package_path),
      ['.'],
    );
    assert.ok(out[0]!.evidence_files.includes('.github/workflows/check.yml'));
  });

  it('GH 2066 stops descending past depth 4', () => {
    const dir = fixtureCopy('makefile-sentinel');
    place(dir, 'a/b/c/d/package.json', MANIFEST);
    place(dir, 'a/b/c/d/e/package.json', MANIFEST);
    assert.deepEqual(
      collectEnvEvidence(dir).map((p) => p.package_path),
      ['.', 'a/b/c/d'],
    );
  });
});

describe('GH 2066 env detector stays read-only and tool-agnostic', () => {
  const files = [...sourceFiles(join(SERVER_SRC, 'env')), join(SERVER_SRC, 'tools', 'env.ts')];

  it('GH 2066 src/env and tools/env.ts spawn nothing', () => {
    for (const f of files) {
      const hits = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => /child_process|execSync|spawn\(|exec\(/.test(l));
      assert.deepEqual(hits, [], f);
    }
  });

  it('GH 2066 src/env and tools/env.ts name no linter, formatter, type checker or test runner', () => {
    const names = /\b(ruff|mypy|pyright|pytest|eslint|prettier|biome|tsc|vitest|jest|golangci|clippy|rustfmt|clang)\b/i;
    for (const f of files) {
      const hits = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => names.test(l));
      assert.deepEqual(hits, [], f);
    }
  });
});
