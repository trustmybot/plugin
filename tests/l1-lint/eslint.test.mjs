// L1 lint: typescript-eslint (recommendedTypeChecked) passes on the MCP server and dashboard against the eslint-suppressions.json baseline.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ESLINT = join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
const skip = existsSync(ESLINT) ? false : "eslint not installed — run 'bun install' first";

function runEslint(args) {
  try {
    const output = execFileSync(process.execPath, [ESLINT, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, output };
  } catch (err) {
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('a new floating promise fails the lint', { skip, timeout: 300000 }, () => {
  const fixture = 'async function work(): Promise<void> {}\nexport function run(): void {\n  work();\n}\n';
  const dir = mkdtempSync(join(ROOT, 'mcp', 'trajectory-server', 'src', 'eslint-fixture-'));
  try {
    const file = join(dir, 'floating.ts');
    writeFileSync(file, fixture);
    const result = runEslint([file]);
    assert.equal(result.ok, false);
    assert.match(result.output, /@typescript-eslint\/no-floating-promises/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('un-awaited node:test calls pass while a real floating promise still fails', { skip, timeout: 300000 }, () => {
  const fixture = [
    "import { describe, it, suite, test } from 'node:test';",
    'async function work(): Promise<void> {}',
    'const runner = { skip: async (): Promise<void> => {} };',
    "describe('suite', () => {",
    "  it('case', () => {});",
    '});',
    "test('top', () => {});",
    ...['describe', 'it', 'suite', 'test'].flatMap((fn) =>
      ['skip', 'only', 'todo'].map((modifier) => `${fn}.${modifier}('${fn} ${modifier}', () => {});`),
    ),
    'work();',
    'runner.skip();',
    '',
  ].join('\n');
  const dir = mkdtempSync(join(ROOT, 'mcp', 'trajectory-server', 'src', 'eslint-fixture-'));
  try {
    const file = join(dir, 'node-test.ts');
    writeFileSync(file, fixture);
    const result = runEslint(['--format', 'json', file]);
    assert.equal(result.ok, false);
    const [report] = JSON.parse(result.output);
    const floating = report.messages.filter((m) => m.ruleId === '@typescript-eslint/no-floating-promises');
    assert.deepEqual(
      floating.map((m) => m.line),
      [20, 21],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repo lint passes against the suppressions baseline', { skip, timeout: 600000 }, () => {
  const result = runEslint([]);
  assert.ok(result.ok, `${result.output}\nEslint: FAIL — fix the violations above or remove stale suppressions`);
});
