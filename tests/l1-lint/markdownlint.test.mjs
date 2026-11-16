// L1 lint (docs bundle, GH 3161): markdownlint-cli2 passes on the tracked Markdown under the root .markdownlint-cli2.jsonc, whose disabled and relaxed rules carry their reasons. The file set is lib/markdown-files.mjs's: `git ls-files '*.md'` minus the config's `ignores`. Every run also checks that the config rejects fixtures/markdownlint/violation.md (two top-level headings, MD025).
import { strict as assert } from 'node:assert';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main as markdownlintCli2 } from 'markdownlint-cli2';
import { ignoredMarkdown, MARKDOWNLINT_CONFIG, trackedMarkdown } from './lib/markdown-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VIOLATION = 'tests/l1-lint/fixtures/markdownlint/violation.md';

/** Lints the files (relative to dir) under dir's config; returns the exit code and each reported problem line. */
export async function markdownlintProblems(dir, files) {
  const problems = [];
  const exitCode = await markdownlintCli2({
    directory: dir,
    // A leading ':' makes markdownlint-cli2 read each path literally instead of as a glob.
    argv: files.map((rel) => `:${rel}`),
    logMessage: () => {},
    logError: (line) => problems.push(line),
  });
  return { exitCode, problems };
}

test('an ignore glob also matches inside a folder whose name starts with a dot', () => {
  assert.ok(ignoredMarkdown('.github/fixtures/x.md', ['**/fixtures/**']));
  assert.ok(ignoredMarkdown('a/.cache/node_modules/b/README.md', ['**/node_modules/**']));
  assert.ok(ignoredMarkdown('.claude/.inner/x.md', ['.claude/**']));
  assert.ok(ignoredMarkdown('.github/CHANGELOG.md', ['**/CHANGELOG.md']));
  assert.ok(!ignoredMarkdown('.github/README.md', ['**/fixtures/**', '.claude/**']));
  assert.ok(!ignoredMarkdown('.github/README.md', ['README.md']));
});

// The config ignores fixtures/, so the fixture is linted from a temp dir holding a copy of the config.
test('the config rejects the violation fixture', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-markdownlint-'));
  try {
    copyFileSync(join(ROOT, MARKDOWNLINT_CONFIG), join(dir, MARKDOWNLINT_CONFIG));
    copyFileSync(join(ROOT, VIOLATION), join(dir, basename(VIOLATION)));
    const { exitCode, problems } = await markdownlintProblems(dir, [basename(VIOLATION)]);
    assert.notEqual(exitCode, 0);
    assert.ok(
      problems.some((line) => line.includes(basename(VIOLATION)) && line.includes('MD025')),
      `expected an MD025 problem in ${VIOLATION}, got:\n${problems.join('\n')}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the tracked Markdown passes markdownlint', async (t) => {
  const files = trackedMarkdown(ROOT);
  assert.ok(files.length > 0, 'no tracked Markdown found');
  assert.ok(!files.includes(VIOLATION), 'fixtures are outside the file set');
  const { exitCode, problems } = await markdownlintProblems(ROOT, files);
  assert.equal(exitCode, 0, `markdownlint: FAIL\n${problems.join('\n')}`);
  t.diagnostic(`markdownlint: PASS (${files.length} files)`);
});
