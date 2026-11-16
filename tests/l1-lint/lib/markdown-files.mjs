// The Markdown file set the docs-bundle lints (markdownlint, mermaid-parse) check: every tracked *.md
// minus the `ignores` globs of the root .markdownlint-cli2.jsonc, so both lints read one list.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import jsoncParse from 'markdownlint-cli2/parsers/jsonc';

export const MARKDOWNLINT_CONFIG = '.markdownlint-cli2.jsonc';

/** The root markdownlint-cli2 config, parsed. */
export function markdownlintConfig(root) {
  return jsoncParse(readFileSync(join(root, MARKDOWNLINT_CONFIG), 'utf8'));
}

const DOT_MASK = '\u0001';

function maskDots(s) {
  return s.replace(/(^|\/)\./g, `$1${DOT_MASK}`);
}

/**
 * True when rel matches one of the ignore globs. `*` and `**` also match a segment starting with a dot
 * (path.matchesGlob alone skips them), the same rule as run-all.ts's matchesInput, which this .mjs can't
 * import because Node's engines floor doesn't strip TypeScript types.
 */
export function ignoredMarkdown(rel, ignores) {
  return ignores.some((glob) => matchesGlob(rel, glob) || matchesGlob(maskDots(rel), maskDots(glob)));
}

/** The tracked *.md paths under root, repo-relative and sorted, minus the config's ignores. */
export function trackedMarkdown(root) {
  const r = spawnSync('git', ['-C', root, 'ls-files', '-z', '--', '*.md'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`git ls-files failed in ${root}: ${r.stderr}`);
  const ignores = markdownlintConfig(root).ignores ?? [];
  return r.stdout
    .split('\0')
    .filter((rel) => rel !== '' && !ignoredMarkdown(rel, ignores))
    .sort();
}
