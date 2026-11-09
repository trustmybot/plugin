// L1 lint: TMB prescribes plugin changes only as CLI commands run from the project root with an explicit scope (`claude plugin update tmb@trustmybot-dev --scope local`), never as the in-session commands `/plugin …`, `/reload-plugins` or reconnecting through `/mcp` (GH 1730): a plugin change applies only after a full quit and relaunch of Claude Code, and `/plugin` does not work in Claude Desktop. Flags the three used as a command; path segments (`trustmybot/plugin`, `/plugin/`, `plugin.json`, `logs/mcp-server.log`) and absolute paths given to `cd` or a Dockerfile WORKDIR, COPY, ADD or VOLUME line pass. Scans every git-tracked *.md, *.ts, *.mjs, *.js, *.json and *.yml outside tests/, test/, dist/ and node_modules/ dirs, CHANGELOG.md and changelog.d/. Every run also checks fixtures/no-in-session-plugin-commands/: every line of each bad.* fixture is flagged, and each good.* fixture yields nothing.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = join(ROOT, 'tests', 'l1-lint', 'fixtures', 'no-in-session-plugin-commands');
const COMMAND = /(?:^|(?<=[\s`"'(]))(?<!\bcd )\/(?:reload-plugins|plugin|mcp)(?=[\s`"')]|[.,;:](?![\w/])|$)/;
const DOCKER_PATH_LINE = /^\s*(?:WORKDIR|COPY|ADD|VOLUME)\s/;
const NOT_SCANNED = /(^|\/)(tests?|dist|node_modules)\/|(^|\/)CHANGELOG\.md$|^changelog\.d\//;

function lines(text) {
  const out = text.split('\n');
  if (out.at(-1) === '') out.pop();
  return out;
}

export function scan(file, label = file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return lines(text).flatMap((line, i) => (!DOCKER_PATH_LINE.test(line) && COMMAND.test(line) ? [`${label}:${i + 1}: ${line}`] : []));
}

function scannedFiles() {
  const tracked = execFileSync('git', ['ls-files', '-z', '--', '*.md', '*.ts', '*.mjs', '*.js', '*.json', '*.yml'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return tracked
    .split('\0')
    .filter((f) => f && !NOT_SCANNED.test(f))
    .sort();
}

const fixtures = (prefix) =>
  readdirSync(FIXTURES)
    .filter((name) => name.startsWith(`${prefix}.`))
    .sort();

test('every line of each bad.* fixture is flagged', () => {
  const bad = fixtures('bad');
  assert.notDeepEqual(bad, [], 'no bad.* fixtures found');
  for (const name of bad) {
    const file = join(FIXTURES, name);
    const expected = lines(readFileSync(file, 'utf8')).length;
    const found = scan(file);
    assert.ok(
      found.length !== 0 && found.length === expected,
      `no-in-session-plugin-commands self-test: ${name} — ${expected} lines, ${found.length} flagged:\n${found.join('\n')}`,
    );
  }
});

test('each good.* fixture produces no findings', () => {
  const good = fixtures('good');
  assert.notDeepEqual(good, [], 'no good.* fixtures found');
  for (const name of good) {
    const found = scan(join(FIXTURES, name));
    assert.deepEqual(found, [], `no-in-session-plugin-commands self-test: false positives in ${name}:\n${found.join('\n')}`);
  }
});

test('no in-session plugin commands are prescribed', (t) => {
  let files;
  try {
    files = scannedFiles();
  } catch {
    assert.fail('No-in-session-plugin-commands: FAIL — git ls-files failed; run from a git checkout');
  }
  const violations = files.flatMap((f) => scan(join(ROOT, f), f));
  assert.deepEqual(
    violations,
    [],
    `No-in-session-plugin-commands: FAIL — prescribe "claude plugin … --scope <s>" from the project root and/or a full quit and relaunch of Claude Code instead:\n${violations.join('\n')}`,
  );
  t.diagnostic(`No-in-session-plugin-commands: PASS (${files.length} files)`);
});
