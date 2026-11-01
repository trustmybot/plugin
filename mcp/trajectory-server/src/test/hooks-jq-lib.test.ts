/**
 * lib/jq.ts against real jq (GH 1692): object keys keep input order where a JS
 * object moves integer-like keys to the front, and on non-JSON stdin the
 * TypeScript gates whose .sh leaves jq's errors on stderr print nothing there
 * (decision 703). Each order case also holds a literal, for a host with no jq.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { jqCompact, jqContentStrings, jqIndex, jqLiteralNumbers, jqMap, jqRawElements, jsonStream, jsonValues } from '../hooks/lib/jq.js';
import { jqInput, jqRaw } from '../hooks/lib/jq-raw.js';
import { jqRawText } from '../hooks/lib/project-env.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const HAVE_JQ = spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;

/** Both the literal and, when jq is on PATH, what `jq <args>` prints for <input>. */
function assertMatchesJq(actual: string, literal: string, input: string, ...args: string[]): void {
  assert.equal(actual, literal);
  if (!HAVE_JQ) return;
  const r = spawnSync('jq', args, { input, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(actual, r.stdout.replace(/\n$/, ''));
}

const MIXED = '{"b":1,"2":"two","a":{"10":1,"9":[{"3":1,"1":2}],"z":null},"1":4,"01":5,"-1":6,"1.5":7}';

describe('lib/jq.ts key order', () => {
  it('a JS object alone would reorder this input', () => {
    assert.notEqual(JSON.stringify(JSON.parse(MIXED)), MIXED);
  });

  it('jq -c keeps integer-like and string keys in input order, at every depth', () => {
    const [value] = jsonValues(MIXED);
    assertMatchesJq(jqCompact(value), MIXED, MIXED, '-c', '.');
  });

  it('jq -c through jsonStream, and through jqMap with literal numbers as debug-trajectory reads tool_input', () => {
    const input = '{"tool_input":{"7":1.0,"x":1e2,"3":{"2":true,"1":false}}}';
    const literal = '{"7":1.0,"x":1E+2,"3":{"2":true,"1":false}}';
    const printed = jqMap(input, (value) => jqCompact(jqIndex(value, 'tool_input')), jqLiteralNumbers);
    assert.equal(printed.length, 1);
    assertMatchesJq(printed[0], literal, input, '-c', '.tool_input');
    assert.equal(jqCompact(jsonStream('{"2":1,"1":2}').values[0]), '{"2":1,"1":2}');
  });

  it('jq -r indents an object in input order', () => {
    const input = '{"o":{"b":[],"2":{},"1":[1,{"3":1,"2":2}]}}';
    const literal = '{\n  "b": [],\n  "2": {},\n  "1": [\n    1,\n    {\n      "3": 1,\n      "2": 2\n    }\n  ]\n}';
    const [value] = jsonValues(input);
    assertMatchesJq(jqRawText(jqIndex(value, 'o')), literal, input, '-r', '.o');
    assert.equal(jqRaw(jqIndex(jqInput(input).values[0], 'o')), literal);
  });

  it('jq -r .[] yields an object\'s values in input order', () => {
    const input = '{"b":"first","2":"second","1":"third"}';
    assertMatchesJq(jqRawElements(input), 'first\nsecond\nthird', input, '-r', '.[]');
  });

  it('tostring of message.content keeps input order', () => {
    const input = '{"message":{"content":[{"2":1,"1":2}]}}';
    assert.deepEqual(jqContentStrings(input), ['[{"2":1,"1":2}]']);
    assertMatchesJq(jqContentStrings(input)[0], '[{"2":1,"1":2}]', input, '-r', '.message.content | tostring');
  });

  it('a duplicate key stays at its first position with its last value, an escaped key counts, and whitespace is no matter', () => {
    const input = ' { "b" : 1 , "2" : {"9":1,"8":2} , "a" : 3 , "\\u0031" : 4 , "2" : {"7":5,"6":6} } ';
    assertMatchesJq(jqCompact(jsonValues(input)[0]), '{"b":1,"2":{"7":5,"6":6},"a":3,"1":4}', input, '-c', '.');
  });

  it('keeps order across many keys, past where jq grows its table', () => {
    const entries = Array.from({ length: 40 }, (_, i) => `"${(i * 7) % 40}":${i}`);
    const input = `{"z":0,${entries.join(',')}}`;
    assertMatchesJq(jqCompact(jsonValues(input)[0]), input, input, '-c', '.');
  });

  it('an array of strings holding a key-like text prints as before', () => {
    const input = '["\\"2\\":1","{\\"2\\":1,\\"1\\":2}",{"a":{"b":1}}]';
    assertMatchesJq(jqCompact(jsonValues(input)[0]), input, input, '-c', '.');
  });

  it('indexing by an integer-like key still reads its value', () => {
    assert.equal(jqIndex(jsonValues('{"2":"two","1":"one"}')[0], '1'), 'one');
  });

  it('gates\' own objects still print in insertion order', () => {
    assert.equal(jqCompact({ task_id: 1, reason: 'x', nothing: undefined }), '{"task_id":1,"reason":"x"}');
  });

  it('a nesting too deep to walk still parses', () => {
    const depth = 200_000;
    const input = `${'['.repeat(depth)}{"2":1,"1":2}${']'.repeat(depth)}`;
    assert.equal(jsonValues(input).length, 1);
  });
});

describe('non-JSON stdin (decision 703)', () => {
  const GATES = ['ensure-swe-worktree', 'git-guards', 'git-push-guard', 'require-feature-branch-active', 'require-task-spec'];
  let project: string;
  before(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-jq-lib-')));
  });
  after(() => {
    rmSync(project, { recursive: true, force: true });
  });

  for (const gate of GATES) {
    it(`${gate}: the TS gate leaves stderr empty and allows, where its .sh prints jq's errors`, () => {
      const env = { ...process.env, HOME: project, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, TRAJECTORY_DB_PATH: undefined };
      const r = spawnSync(process.execPath, [HOOKS_BUNDLE, gate], { input: 'not json at all', env, cwd: project, encoding: 'utf8' });
      assert.equal(r.stderr, '');
      assert.equal(r.stdout, '');
      assert.equal(r.status, 0);
      if (!HAVE_JQ) return;
      const bash = spawnSync('bash', [join(PLUGIN_ROOT, 'scripts/hooks', `${gate}.sh`)], { input: 'not json at all', env, cwd: project, encoding: 'utf8' });
      assert.match(bash.stderr, /^jq: /m);
    });
  }
});
