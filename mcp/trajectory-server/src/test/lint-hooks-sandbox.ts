/**
 * The sandbox the lint-hook corpora run in (GH 1692): `gh` and `glab` stubs
 * first on PATH, so attribution-footer never reaches a real forge, and a
 * BadExisting.py for naming-lint's existing-file case. A stub appends its
 * argv as `[gh][pr][edit][101]...` lines to $STUB_LOG and answers `view` with
 * $STUB_VIEW_OUT and exit $STUB_VIEW_EXIT. A corpus payload names the sandbox
 * as @SANDBOX@; its corpus_env (removed before the run) overrides the env and
 * its corpus_expect (removed too) is one phrase, or one per locale.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LINT_GATES = ['attribution-footer', 'code-quality-lint', 'commit-msg-lint', 'naming-lint'];

const STUB = `#!/bin/sh
log="\${STUB_LOG:-/dev/null}"
printf '[%s]' "\${0##*/}" "$@" >> "$log"
printf '\\n' >> "$log"
case "$2" in
  view) printf '%s' "$STUB_VIEW_OUT"; exit "\${STUB_VIEW_EXIT:-0}" ;;
esac
exit 0
`;

export interface LintCase {
  input: Buffer;
  env: NodeJS.ProcessEnv;
  expect: (locale: string) => string;
}

export interface LintSandbox {
  env: NodeJS.ProcessEnv;
  materialize: (raw: Buffer) => LintCase;
}

export function lintSandbox(dir: string): LintSandbox {
  const stubs = join(dir, 'stubs');
  mkdirSync(stubs, { recursive: true });
  for (const cli of ['gh', 'glab']) {
    writeFileSync(join(stubs, cli), STUB);
    chmodSync(join(stubs, cli), 0o755);
  }
  writeFileSync(join(dir, 'BadExisting.py'), '');
  return {
    env: { PATH: `${stubs}:${process.env.PATH ?? ''}`, STUB_LOG: join(dir, 'stub.log') },
    materialize: (raw) => {
      const text = raw.toString('utf8').replaceAll('@SANDBOX@', dir);
      const { corpus_env: env = {}, corpus_expect: expect = '', ...payload } = JSON.parse(text) as {
        corpus_env?: NodeJS.ProcessEnv;
        corpus_expect?: string | Record<string, string>;
      };
      return {
        input: Buffer.from(JSON.stringify(payload)),
        env,
        expect: (locale) => (typeof expect === 'string' ? expect : (expect[locale] ?? '')),
      };
    },
  };
}
