/**
 * Bash-vs-node parity for the TypeScript hook gates (GH 1692): every corpus
 * payload in tests/fixtures/hook-corpus/<gate>/ gives the same exit code and
 * the same stdout (empty, or deep-equal JSON) through
 * `bash scripts/hooks/<gate>.sh` and `node dist/hooks.js <gate>`.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateNames } from '../hooks/registry.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS_ROOT = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const MIN_CORPUS = 8;
const LOCALES = ['C', 'en_US.UTF-8'];

function corpusFiles(root: string, gate: string): string[] {
  const dir = join(root, gate);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => join(dir, f));
}

function corpusProblems(gates: string[], root: string): string[] {
  return gates.flatMap((gate) => {
    const n = corpusFiles(root, gate).length;
    return n >= MIN_CORPUS ? [] : [`${gate}: ${n} corpus inputs in ${join(root, gate)}, need at least ${MIN_CORPUS}`];
  });
}

interface Run {
  code: number | null;
  stdout: string;
}

function run(cmd: string, args: string[], input: Buffer, env: NodeJS.ProcessEnv): Run {
  const r = spawnSync(cmd, args, { input, env, encoding: 'utf8', timeout: 20_000 });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout };
}

function parsedStdout(stdout: string): unknown {
  return stdout.trim() === '' ? null : JSON.parse(stdout);
}

describe('hooks parity: bash vs node over the corpus', () => {
  let project: string;
  before(() => {
    project = mkdtempSync(join(tmpdir(), 'tmb-hooks-parity-'));
  });
  after(() => rmSync(project, { recursive: true, force: true }));

  it('every registered gate has a corpus of at least 8 inputs', () => {
    assert.ok(gateNames().length > 0, 'the registry lists no gate');
    assert.deepEqual(corpusProblems(gateNames(), CORPUS_ROOT), []);
  });

  it('self-test: a registered gate without a corpus, or with too few inputs, fails the check', () => {
    const root = mkdtempSync(join(tmpdir(), 'tmb-hooks-corpus-'));
    try {
      mkdirSync(join(root, 'thin-gate'));
      for (let i = 0; i < MIN_CORPUS - 1; i++) writeFileSync(join(root, 'thin-gate', `${i}.json`), '{}');
      const problems = corpusProblems(['no-corpus-gate', 'thin-gate'], root);
      assert.equal(problems.length, 2);
      assert.match(problems[0], /^no-corpus-gate: 0 corpus inputs/);
      assert.match(problems[1], /^thin-gate: 7 corpus inputs/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const gate of gateNames()) {
    for (const file of corpusFiles(CORPUS_ROOT, gate)) {
      for (const locale of LOCALES) {
        it(`${gate} / ${file.slice(CORPUS_ROOT.length + gate.length + 2)} (LC_ALL=${locale})`, () => {
          const input = readFileSync(file);
          const env = { ...process.env, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, LC_ALL: locale };
          const bash = run('bash', [join(PLUGIN_ROOT, 'scripts/hooks', `${gate}.sh`)], input, env);
          const node = run(process.execPath, [HOOKS_BUNDLE, gate], input, env);
          assert.equal(node.code, bash.code, 'exit code');
          assert.deepEqual(parsedStdout(node.stdout), parsedStdout(bash.stdout), 'stdout');
        });
      }
    }
  }

  it('the parity runs left the isolated project untouched', () => {
    assert.deepEqual(readdirSync(project), []);
  });
});
