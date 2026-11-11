// L1 lint: no `| grep -q` in a command of tests/l5-l6/l6-chain/chain-manifest.json (its strings are eval'd under pipefail; grep -q closes the pipe on the first match, the upstream can die of SIGPIPE and the pipeline fails although the pattern was present; write `cmd | grep PAT >/dev/null`). A hit is a raw line of the manifest where a pipe feeds grep/egrep/fgrep/rg whose options include a cluster containing q, --quiet or --silent. Every run also checks fixtures/no-grep-q-in-pipelines/: every command line of manifest-offending.json is flagged and manifest-clean.json yields nothing.
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = join(ROOT, 'tests', 'l1-lint', 'fixtures', 'no-grep-q-in-pipelines');
const MANIFESTS = ['tests/l5-l6/l6-chain/chain-manifest.json'];
const OPT = String.raw`(?:-[A-Za-z]*e\s+(?:'[^']*'|"[^"]*"|\\"(?:[^"\\]|\\.)*?\\"|\S+)|--[A-Za-z][\w-]*(?:=\S+)?|-[A-Za-z]+)`;
const QUIET = String.raw`(?:-[A-Za-z]*q[A-Za-z]*|--quiet|--silent)(?![\w-])`;
const HIT = new RegExp(String.raw`(?:^|[^|])\|\s*(?:grep|egrep|fgrep|rg)(?:\s+${OPT})*?\s+${QUIET}`);

export function scan(base, files) {
  const out = [];
  for (const file of files) {
    const rel = file.startsWith(`${base}/`) ? file.slice(base.length + 1) : file;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (HIT.test(line)) out.push(`${rel}:${i + 1}: ${line.replace(/^\s+/, '')}`);
      });
  }
  return out;
}

test('fixture manifest-offending.json: every command line is caught', () => {
  const file = join(FIXTURES, 'manifest-offending.json');
  const expected = readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((l, i) => (l.includes('"chain_setup_command"') ? [i + 1] : []));
  const got = scan(FIXTURES, [file]).map((l) => Number(l.split(':')[1]));
  assert.ok(expected.length > 0, 'no-grep-q-in-pipelines self-test: manifest-offending.json has no commands');
  assert.deepEqual(got, expected, `no-grep-q-in-pipelines self-test: FAIL (manifest-offending.json lines [${expected}], flagged [${got}])`);
});

test('fixture manifest-clean.json is allowed', () => {
  const out = scan(FIXTURES, [join(FIXTURES, 'manifest-clean.json')]);
  assert.deepEqual(out, [], `no-grep-q-in-pipelines self-test: FAIL (manifest-clean.json flagged)\n${out.join('\n')}`);
});

test('no grep -q in pipelines under pipefail', () => {
  const files = MANIFESTS.filter((m) => existsSync(join(ROOT, m))).map((m) => join(ROOT, m));
  const out = scan(ROOT, files);
  assert.deepEqual(out, [], `${out.join('\n')}\nno-grep-q-in-pipelines: FAIL — pipe into 'grep PAT >/dev/null' instead of 'grep -q' under pipefail`);
});
