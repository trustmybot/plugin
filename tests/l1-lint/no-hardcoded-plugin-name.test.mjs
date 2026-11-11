// L1 lint: no hardcoded plugin-name string (.claude/tmb/, tmb-active-workspace, trustmybot-rc, ="tmb" / ='tmb') in the *.ts and *.js files under scripts/ and mcp/trajectory-server/src/ outside the plugin-name resolvers. Exempt: scripts/publish-rc-channel.ts, any path containing "test", and lines carrying an inline fallback (jq -r '.name // "tmb"', jq -r .name, PLUGIN_NAME="tmb", PLUGIN_NAME='tmb'). Every run also checks fixtures/hardcoded-plugin-name/has-hardcoded.ts is caught.
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { files, hardcodedInText, hardcodedLines } from './lib/no-hardcoded-plugin-name.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = join(ROOT, 'tests', 'l1-lint', 'fixtures', 'hardcoded-plugin-name', 'has-hardcoded.ts');

test('the hardcoded-name fixture is caught; inline fallbacks are exempt', () => {
  assert.ok(existsSync(FIXTURE), `no-hardcoded-plugin-name self-test: fixture missing: ${FIXTURE}`);
  assert.ok(hardcodedLines(FIXTURE, 'has-hardcoded.ts').length > 0, 'no-hardcoded-plugin-name self-test: FAIL (fixture not caught)');
  const text = [`NAME="tmb"`, `x='tmb'`, 'tmb-active-workspace', 'trustmybot-rc', `PLUGIN_NAME="tmb"`, `n=$(jq -r '.name // "tmb"' f)`].join('\n');
  assert.deepEqual(hardcodedInText(text, 'x.sh'), [1, 2, 3, 4].map((n) => `x.sh:${n}: hardcoded plugin name`));
});

test('no hardcoded plugin name outside the resolvers', () => {
  const out = files(ROOT).flatMap((rel) => hardcodedLines(join(ROOT, rel), rel));
  assert.deepEqual(out, [], `${out.join('\n')}\n\nno-hardcoded-plugin-name: FAIL`);
});
