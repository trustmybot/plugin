// L1 lint: the MCP server and dashboard sources type-check with tsc --noEmit, isolating type errors from the emitting build.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = join(ROOT, 'mcp', 'trajectory-server');
const DASHBOARD = join(ROOT, 'dashboard');

function resolveTsc() {
  const local = join(SERVER, 'node_modules', '.bin', 'tsc');
  if (existsSync(local)) return local;
  try {
    execFileSync('tsc', ['--version'], { stdio: 'ignore' });
    return 'tsc';
  } catch {
    return null;
  }
}

export function typeCheck(tsc, project) {
  try {
    execFileSync(tsc, ['--noEmit', '-p', project], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, output: '' };
  } catch (err) {
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const TSC = resolveTsc();
const skip = TSC ? false : "tsc not found locally or on PATH — run 'bun install' first";
const DASHBOARD_SKIP = existsSync(join(DASHBOARD, 'node_modules'))
  ? false
  : "dashboard deps missing — run 'bun install' in dashboard/ first";

test('a type error fails the check', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsc-noemit-'));
  try {
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, files: ['bad.ts'] }));
    writeFileSync(join(dir, 'bad.ts'), 'const n: number = "not a number";\nexport { n };\n');
    const result = typeCheck(TSC, dir);
    assert.equal(result.ok, false);
    assert.match(result.output, /bad\.ts\(1,7\): error TS2322/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP server type-checks clean', { skip, timeout: 300000 }, () => {
  const result = typeCheck(TSC, SERVER);
  assert.ok(result.ok, `${result.output}\nTsc-noemit: FAIL — fix type errors above`);
});

test('MCP server type-check skips eslint fixture dirs', { skip, timeout: 300000 }, () => {
  const dir = mkdtempSync(join(SERVER, 'src', 'eslint-fixture-'));
  try {
    writeFileSync(join(dir, 'bad.ts'), 'const n: number = "not a number";\nexport { n };\n');
    const result = typeCheck(TSC, SERVER);
    assert.ok(result.ok, `${result.output}\nTsc-noemit: FAIL — the server tsconfig must exclude src/eslint-fixture-*`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dashboard type-checks clean', { skip: skip || DASHBOARD_SKIP, timeout: 300000 }, () => {
  const result = typeCheck(TSC, DASHBOARD);
  assert.ok(result.ok, `${result.output}\nTsc-noemit: FAIL — fix dashboard type errors above`);
});
