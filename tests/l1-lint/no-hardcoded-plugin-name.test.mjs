// L1 lint: no hardcoded plugin-name string (.claude/tmb/, tmb-active-workspace, trustmybot-rc, ="tmb" / ='tmb') in the *.sh, *.ts and *.js files under scripts/ and mcp/trajectory-server/src/ outside the plugin-name resolvers. Exempt: scripts/hooks/lib/query-task.sh, scripts/publish-rc-channel.ts, any path containing "test", and lines carrying an inline fallback (jq -r '.name // "tmb"', jq -r .name, PLUGIN_NAME="tmb", PLUGIN_NAME='tmb'). Every run also checks fixtures/hardcoded-plugin-name/has-hardcoded.sh is caught.
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = join(ROOT, 'tests', 'l1-lint', 'fixtures', 'hardcoded-plugin-name', 'has-hardcoded.sh');
const HARDCODED = /(\.claude\/tmb\/|tmb-active-workspace|trustmybot-rc|=["']tmb["'])/;
const EXCLUDED_FILES = ['scripts/hooks/lib/query-task.sh', 'scripts/publish-rc-channel.ts'];
const EXCLUDED_LINE_PATTERNS = [`jq -r '.name // "tmb"'`, 'jq -r .name', 'PLUGIN_NAME="tmb"', "PLUGIN_NAME='tmb'"];

function sources(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) sources(child, out);
    else if (entry.isFile() && /\.(sh|ts|js)$/.test(entry.name)) out.push(child);
  }
}

export function hardcodedLines(file, rel) {
  return hardcodedInText(readFileSync(file, 'utf8'), rel);
}

function hardcodedInText(text, rel) {
  return text.split('\n').flatMap((line, i) =>
    HARDCODED.test(line) && !EXCLUDED_LINE_PATTERNS.some((p) => line.includes(p)) ? [`${rel}:${i + 1}: hardcoded plugin name`] : [],
  );
}

test('the hardcoded-name fixture is caught; inline fallbacks are exempt', () => {
  assert.ok(existsSync(FIXTURE), `no-hardcoded-plugin-name self-test: fixture missing: ${FIXTURE}`);
  assert.ok(hardcodedLines(FIXTURE, 'has-hardcoded.sh').length > 0, 'no-hardcoded-plugin-name self-test: FAIL (fixture not caught)');
  const text = [`NAME="tmb"`, `x='tmb'`, 'tmb-active-workspace', 'trustmybot-rc', `PLUGIN_NAME="tmb"`, `n=$(jq -r '.name // "tmb"' f)`].join('\n');
  assert.deepEqual(hardcodedInText(text, 'x.sh'), [1, 2, 3, 4].map((n) => `x.sh:${n}: hardcoded plugin name`));
});

test('no hardcoded plugin name outside the resolvers', () => {
  const all = [];
  for (const dir of ['scripts', join('mcp', 'trajectory-server', 'src')]) {
    if (existsSync(join(ROOT, dir))) sources(join(ROOT, dir), all);
  }
  const out = all
    .map((f) => f.slice(ROOT.length + 1))
    .filter((rel) => !EXCLUDED_FILES.includes(rel) && !rel.includes('test'))
    .sort()
    .flatMap((rel) => hardcodedLines(join(ROOT, rel), rel));
  assert.deepEqual(out, [], `${out.join('\n')}\n\nno-hardcoded-plugin-name: FAIL`);
});
