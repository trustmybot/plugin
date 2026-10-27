/**
 * Byte-for-byte parity of the TypeScript lint hooks with their
 * scripts/hooks/<gate>.sh twins (GH 1692): commit-msg-lint, naming-lint,
 * code-quality-lint and attribution-footer over
 * tests/fixtures/hook-corpus/<gate>/, each payload under LC_ALL=C,
 * en_US.UTF-8 and UTF-8. Both sides give the same exit code and the same
 * stdout byte for byte, and attribution-footer makes the same gh/glab calls
 * (lint-hooks-sandbox.ts stubs them). Each payload's corpus_expect pins what
 * the .sh does: `allow`, a phrase of the warning or deny, `none` (no
 * edit/update call) or the `<group> <verb> <number>` of the write. The runs
 * split across hooks-lint-parity.shard-<k>of<n>.test.ts.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINT_GATES, lintSandbox, type LintSandbox } from './lint-hooks-sandbox.js';
import { shardOf } from './shard.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS_ROOT = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const LOCALES = ['C', 'en_US.UTF-8', 'UTF-8'];
const MIN_CORPUS = 8;

interface Run {
  code: number | null;
  stdout: Buffer;
  calls: string;
}

function run(cmd: string, args: string[], input: Buffer, env: NodeJS.ProcessEnv, cwd: string, log: string): Run {
  rmSync(log, { force: true });
  const r = spawnSync(cmd, args, { input, env: { ...env, STUB_LOG: log }, cwd, timeout: 30_000 });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, calls: existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

function said(stdout: string): string {
  const out = JSON.parse(stdout) as { hookSpecificOutput: { additionalContext?: string; permissionDecisionReason?: string } };
  return out.hookSpecificOutput.additionalContext ?? out.hookSpecificOutput.permissionDecisionReason ?? '';
}

function checkExpectation(gate: string, expect: string, stdout: string, calls: string): void {
  if (gate === 'attribution-footer') {
    assert.equal(stdout, '', 'a PostToolUse footer pass prints nothing');
    const writes = calls.split('\n').filter((l) => /^\[[^\]]*\]\[[^\]]*\]\[(edit|update)\]/.test(l));
    if (expect === 'none') {
      assert.deepEqual(writes, [], 'no write');
    } else {
      const [group, verb, number] = expect.split(' ');
      assert.equal(writes.length, 1, calls);
      assert.ok(writes[0].includes(`[${group}][${verb}][${number}][`), writes[0]);
    }
    return;
  }
  if (expect === 'allow') {
    assert.equal(stdout, '', 'silent');
    return;
  }
  assert.ok(said(stdout).includes(expect), stdout);
}

const corpus = LINT_GATES.flatMap((gate) => {
  const dir = join(CORPUS_ROOT, gate);
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => ({ gate, f }));
});

const cases = corpus.flatMap((c) => LOCALES.map((locale) => ({ ...c, locale })));

export function lintParityShard(k: number, n: number): void {
  describe(`lint hooks parity: bash vs node, byte for byte (shard ${k} of ${n})`, () => {
    let dir: string;
    let sandbox: LintSandbox;
    before(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-lint-parity-')));
      sandbox = lintSandbox(dir);
    });
    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    if (k === 1) {
      it(`each lint corpus holds at least ${MIN_CORPUS} payloads, each with an expectation per locale`, () => {
        const probe = lintSandbox(join(dir, 'probe'));
        for (const gate of LINT_GATES) {
          const files = corpus.filter((c) => c.gate === gate);
          assert.ok(files.length >= MIN_CORPUS, `${gate}: ${files.length} payloads`);
          for (const { f } of files) {
            const { expect } = probe.materialize(readFileSync(join(CORPUS_ROOT, gate, f)));
            for (const locale of LOCALES) assert.notEqual(expect(locale), '', `${gate}/${f} under ${locale}`);
          }
        }
      });
    }

    for (const { gate, f, locale } of shardOf(cases, k, n)) {
      it(`${gate} / ${f} (LC_ALL=${locale})`, () => {
        const { input, env: extra, expect } = sandbox.materialize(readFileSync(join(CORPUS_ROOT, gate, f)));
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          CLAUDE_PROJECT_DIR: dir,
          CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
          LC_ALL: locale,
          ...sandbox.env,
          ...extra,
        };
        const bash = run('bash', [join(PLUGIN_ROOT, 'scripts/hooks', `${gate}.sh`)], input, env, dir, join(dir, 'bash.log'));
        const node = run(process.execPath, [HOOKS_BUNDLE, gate], input, env, dir, join(dir, 'node.log'));
        assert.equal(node.code, bash.code, 'exit code');
        assert.equal(node.stdout.toString('hex'), bash.stdout.toString('hex'), 'stdout, byte for byte');
        assert.equal(node.calls, bash.calls, 'gh/glab calls');
        assert.equal(bash.code, 0);
        checkExpectation(gate, expect(locale), bash.stdout.toString('utf8'), bash.calls);
      });
    }
  });
}
