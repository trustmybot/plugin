// L1 lint: file paths referenced in .github/workflows/*.yml exist (!2894 BLOCKER — l5-l6-combined.yml referenced a deleted Dockerfile that would have red-flagged every release tag). Checks dockerfile:, entry:, script: and path: values, docker build -f arguments, and bash/sh run lines calling tests/ or scripts/ *.sh, when the value looks like a local path. Every run also checks fixtures/ci-workflow-refs/missing-dockerfile.yml is caught.
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = join(ROOT, 'tests', 'l1-lint', 'fixtures', 'ci-workflow-refs');

function isLocalPath(val) {
  if (val.startsWith('http') || val.includes('@')) return false;
  return /^(?:tests|scripts|mcp|\.github|docker)\//.test(val) || val.includes('Dockerfile') || /\.(?:sh|mjs|ts|yml|yaml)$/.test(val);
}

function value(line, key) {
  return line
    .replace(new RegExp(String.raw`^\s*${key}:\s*`), '')
    .replace(/#.*/, '')
    .trim()
    .replace(/^['"]/, '')
    .replace(/['"]$/, '');
}

export function checkWorkflow(base, file) {
  const out = [];
  const rel = file.startsWith(`${base}/`) ? file.slice(base.length + 1) : file;
  const missing = (val) => isLocalPath(val) && !existsSync(join(base, val));
  const lines = readFileSync(file, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  lines.forEach((line, idx) => {
    const n = idx + 1;
    if (/^\s*(dockerfile|entry|script):\s*\S/.test(line)) {
      const val = value(line, '(?:dockerfile|entry|script)');
      if (missing(val)) out.push(`${rel}:${n}: referenced file does not exist: ${val}`);
      return;
    }
    if (/^\s*path:\s*\S/.test(line)) {
      const val = value(line, 'path');
      if (missing(val)) out.push(`${rel}:${n}: referenced path does not exist: ${val}`);
      return;
    }
    if (/docker build.*-f\s+\S/.test(line)) {
      const val = [...line.matchAll(/-f\s+\S+/g)].map((m) => m[0].replace(/-f\s*/, '')).join('\n');
      if (val && missing(val)) out.push(`${rel}:${n}: docker build -f references missing file: ${val}`);
      return;
    }
    if (/^\s*(bash|sh)\s+(tests|scripts)\/\S+\.sh/.test(line)) {
      const val = /(tests|scripts)\/\S+\.sh/.exec(line)[0];
      if (!existsSync(join(base, val))) out.push(`${rel}:${n}: run references missing script: ${val}`);
    }
  });
  return out;
}

function ymlFiles(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) ymlFiles(child, out);
    else if (entry.name.endsWith('.yml')) out.push(child);
  }
  return out;
}

test('fixture missing-dockerfile.yml is caught', () => {
  const fixture = join(FIXTURES, 'missing-dockerfile.yml');
  assert.ok(existsSync(fixture), `ci-workflow-refs-exist --self-test: fixture missing: ${fixture}`);
  assert.notDeepEqual(checkWorkflow(FIXTURES, fixture), [], 'ci-workflow-refs-exist --self-test: FAIL (fixture not caught)');
});

test('CI workflow file refs exist', () => {
  const dir = join(ROOT, '.github', 'workflows');
  if (!existsSync(dir)) return;
  const out = ymlFiles(dir, []).sort().flatMap((f) => checkWorkflow(ROOT, f));
  assert.deepEqual(out, [], `${out.join('\n')}\n\nci-workflow-refs-exist: FAIL`);
});
