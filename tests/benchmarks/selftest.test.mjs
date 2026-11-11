import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cacheStability } from './cache-stability.mjs';
import {
  PyFloat,
  parseJsonLines,
  pyDumps,
  pyFixed,
  pyFloatRepr,
  pyLeft,
  pyStrip,
} from './python-compat.mjs';
import { formatReplay, replayTurns } from './replay-session.mjs';
import { countSpawnReads, formatSpawnReads } from './spawn-reads.mjs';
import { formatStats, tokenStats, turnTotals } from './tokens-per-turn.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sessions = join(here, 'fixtures', 'sessions');
const goldenDir = join(here, 'fixtures', 'golden');
const scratch = mkdtempSync(join(tmpdir(), 'tmb-bench-selftest-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function run(tool, args, cwd = here) {
  const result = spawnSync(process.execPath, [join(here, tool), ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tool(name, ...args) {
  const result = run(`${name}.mjs`, args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const fixture = (name) => join(sessions, `${name}.jsonl`);

describe('bro-provision-reads.mjs', () => {
  test('bro-provision-reads window counts', () => {
    const result = spawnSync(process.execPath, [join(here, 'bro-provision-reads.selftest.mjs')], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('selftest passed'));
  });
});

describe('replay-session.mjs', () => {
  const replay5 = tool('replay-session', fixture('bro-5turn'));
  const replay5File = join(scratch, 'replay-5turn.jsonl');
  writeFileSync(replay5File, replay5);

  test('bro-5turn produces output', () => assert.notEqual(replay5.trim(), ''));
  for (const [label, expect] of [
    ['bro-5turn turn_index present', '"turn_index"'],
    ['bro-5turn input_tokens present', '"input_tokens"'],
    ['bro-5turn cache_read_tokens present', '"cache_read_tokens"'],
    ['bro-5turn hook_injected_bytes present', '"hook_injected_bytes"'],
    ['bro-5turn tool_calls present', '"tool_calls"'],
    ['bro-5turn detects hook injection >0', '"hook_injected_bytes": 1'],
  ]) {
    test(label, () => assert.ok(replay5.includes(expect)));
  }

  const table = tool('replay-session', fixture('bro-5turn'), '--table');
  test('bro-5turn --table header', () => assert.ok(table.includes('TURN')));
  test('bro-5turn --table row 1', () => assert.ok(table.includes('task_list')));

  test('bro-with-spawn produces output', () => {
    assert.notEqual(tool('replay-session', fixture('bro-with-spawn')).trim(), '');
  });

  describe('tokens-per-turn.mjs', () => {
    const out = tool('tokens-per-turn', replay5File);
    test('tokens-per-turn produces output', () => assert.notEqual(out.trim(), ''));
    for (const [label, expect] of [
      ['tokens-per-turn has avg', 'avg='],
      ['tokens-per-turn has p50', 'p50='],
      ['tokens-per-turn has p95', 'p95='],
      ['tokens-per-turn has turn count', 'over'],
    ]) {
      test(label, () => assert.ok(out.includes(expect)));
    }
  });

  describe('cache-stability.mjs', () => {
    const out = tool('cache-stability', replay5File, replay5File);
    test('cache-stability produces output', () => assert.notEqual(out.trim(), ''));
    for (const [label, expect] of [
      ['cache-stability has SHARED_PFX column', 'SHARED_PFX'],
      ['cache-stability has DRIFT column', 'DRIFT'],
      ['cache-stability shows TOT row', 'TOT'],
      ['cache-stability identical sessions drift=0', '0         '],
    ]) {
      test(label, () => assert.ok(out.includes(expect)));
    }
  });
});

describe('spawn-reads.mjs', () => {
  const out = tool('spawn-reads', fixture('bro-with-spawn'));
  test('spawn-reads produces output', () => assert.notEqual(out.trim(), ''));
  for (const [label, expect] of [
    ['spawn-reads has spawns field', 'spawns='],
    ['spawn-reads has reads field', 'reads='],
    ['spawn-reads has mean field', 'mean_reads_per_spawn='],
    ['spawn-reads detects 2 spawns', 'spawns=2'],
  ]) {
    test(label, () => assert.ok(out.includes(expect)));
  }
  test('spawn-reads no-spawn reports N/A', () => {
    assert.ok(tool('spawn-reads', fixture('bro-5turn')).includes('mean_reads_per_spawn=N/A'));
  });
});

function goldenCases() {
  const sessionNames = [
    'bro-5turn',
    'bro-with-spawn',
    'bro-provision-reads',
    'edge-python-semantics',
    'edge-null-usage',
  ];
  const S = (name) => `fixtures/sessions/${name}.jsonl`;
  const R = (name) => `fixtures/golden/${name}.replay.stdout`;
  const cases = [];
  for (const name of sessionNames) {
    cases.push([`${name}.replay`, 'replay-session', [S(name)]]);
    if (name !== 'edge-null-usage') cases.push([`${name}.replay-table`, 'replay-session', [S(name), '--table']]);
    cases.push([`${name}.spawn-reads`, 'spawn-reads', [S(name)]]);
  }
  for (const name of sessionNames) {
    if (name !== 'edge-null-usage') cases.push([`${name}.tokens-per-turn`, 'tokens-per-turn', [R(name)]]);
    cases.push([`${name}.cache-stability-aa`, 'cache-stability', [R(name), R(name)]]);
  }
  for (const [a, b] of [
    ['bro-5turn', 'bro-with-spawn'],
    ['bro-with-spawn', 'bro-5turn'],
    ['bro-5turn', 'bro-provision-reads'],
    ['bro-5turn', 'edge-python-semantics'],
  ]) {
    cases.push([`${a}-vs-${b}.cache-stability-ab`, 'cache-stability', [R(a), R(b)]]);
  }
  return cases;
}

describe('golden output from the Python tools', () => {
  for (const [name, toolName, args] of goldenCases()) {
    test(name, () => {
      const result = run(`${toolName}.mjs`, args);
      const stdout = readFileSync(join(goldenDir, `${name}.stdout`), 'utf8');
      const stderrFile = join(goldenDir, `${name}.stderr`);
      assert.equal(result.stdout, stdout);
      if (existsSync(stderrFile)) {
        assert.equal(result.status, 1);
        assert.equal(result.stderr, readFileSync(stderrFile, 'utf8'));
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
      }
    });
  }
});

describe('Python semantics', () => {
  test('float formatting rounds half to even on exact ties', () => {
    assert.equal(pyFixed(new PyFloat(2.5), 0), '2');
    assert.equal(pyFixed(new PyFloat(3.5), 0), '4');
    assert.equal(pyFixed(0.5, 0), '0');
    assert.equal(pyFixed(1.5, 0), '2');
    assert.equal(pyFixed(0.125, 2), '0.12');
    assert.equal(pyFixed(0.375, 2), '0.38');
    assert.equal(pyFixed(0.625, 2), '0.62');
    assert.equal(pyFixed(2.675, 2), '2.67');
    assert.equal(pyFixed(1 / 3, 2), '0.33');
    assert.equal(pyFixed(-0, 0), '-0');
    assert.equal(pyFixed(1e22, 0), '10000000000000000000000');
    assert.equal(formatStats(tokenStats([2, 3])), 'avg=2 p50=2 p95=3 (over 2 turns)');
    assert.equal(formatSpawnReads({ spawns: 8, reads: 1 }), 'spawns=8 reads=1 mean_reads_per_spawn=0.12');
  });

  test('json.dumps ensure_ascii escaping and separators', () => {
    assert.equal(pyDumps('hé\u{1F600}\u007f\u001f "\\\n'), '"h\\u00e9\\ud83d\\ude00\\u007f\\u001f\\u2028\\"\\\\\\n"');
    assert.equal(pyDumps({ a: [1, null, true], b: {} }), '{"a": [1, null, true], "b": {}}');
    assert.equal(pyDumps([]), '[]');
    const [parsed] = parseJsonLines('[1.0, 1e-5, 0.0001, 1e16, -0.0, 123456789012345678901234567890]');
    assert.equal(pyDumps(parsed), '[1.0, 1e-05, 0.0001, 1e+16, -0.0, 123456789012345678901234567890]');
    assert.equal(pyFloatRepr(1.5), '1.5');
  });

  test('f-string padding counts code points and renders bool as int', () => {
    assert.equal(pyLeft('\u{1F600}', 3), '\u{1F600}  ');
    assert.equal(pyLeft(true, 3), '1  ');
    assert.equal(pyLeft(new PyFloat(2), 5), '2.0  ');
    assert.equal(pyLeft('toolong', 3), 'toolong');
    assert.throws(() => pyLeft(null, 5), TypeError);
  });

  test('usage keys default to 0 only when missing; a present null stays null', () => {
    const events = parseJsonLines(
      [
        '{"type":"assistant","message":{"usage":{"input_tokens":null}}}',
        '{"type":"assistant","message":{"usage":{}}}',
        '{"type":"assistant","message":{"usage":null}}',
        '{"type":"assistant","message":{"usage":{"output_tokens":4}}}',
      ].join('\n'),
    );
    const turns = replayTurns(events);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].input_tokens, null);
    assert.equal(turns[0].output_tokens, 0);
    assert.equal(turns[1].input_tokens, 0);
    assert.equal(turns[1].output_tokens, 4);
    assert.match([...formatReplay(turns)][0], /"input_tokens": null, "output_tokens": 0/);
    assert.throws(() => turnTotals(turns), TypeError);
  });

  test('hook bytes count code points and malformed lines are skipped', () => {
    const events = parseJsonLines(
      [
        '{oops',
        '{"type":"user","uuid":"u","message":{"content":[{"type":"text","text":"<system-reminder>\u{1F600}"}]}}',
        '{"type":"assistant","parentUuid":"u","message":{"usage":{"input_tokens":1}}}',
      ].join('\r\n'),
    );
    assert.equal(events.length, 2);
    assert.equal(replayTurns(events)[0].hook_injected_bytes, 18);
    assert.equal(pyStrip('\x1c {}\x85'), '{}');
  });

  test('cache-stability keeps float results as floats', () => {
    const rows = parseJsonLines('{"cache_read_tokens": 1.5, "cache_creation_tokens": 1e-05}');
    const lines = [...cacheStability(rows, rows)];
    assert.equal(lines[2], '1     1.5          1.5          1.5          0.0       ');
  });

  test('spawn-reads counts TaskCreate and Read tool_use items', () => {
    const events = parseJsonLines(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"TaskCreate"},{"type":"tool_use","name":"Read"},"Read"]}}',
    );
    assert.deepEqual(countSpawnReads(events), { spawns: 1, reads: 1 });
  });
});

describe('CLI exit paths', () => {
  const missing = join(scratch, 'missing.jsonl');
  const empty = join(scratch, 'empty.jsonl');
  writeFileSync(empty, '');

  for (const [name, args, usage] of [
    ['replay-session', [], '<session.jsonl> [--jsonl | --table]'],
    ['tokens-per-turn', [], '<replay-output.jsonl>'],
    ['cache-stability', [empty], '<replay-A.jsonl> <replay-B.jsonl>'],
    ['spawn-reads', [], '<session.jsonl>'],
  ]) {
    test(`${name} usage exits 1`, () => {
      const result = run(`${name}.mjs`, args);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      const prefix = 'Usage: ';
      const suffix = `${name}.mjs ${usage}\n`;
      assert.ok(result.stderr.startsWith(prefix), result.stderr);
      assert.ok(result.stderr.endsWith(suffix), result.stderr);
      assert.doesNotMatch(result.stderr.slice(prefix.length, result.stderr.length - suffix.length), /\s/);
    });
  }

  for (const [name, args] of [
    ['replay-session', [missing]],
    ['tokens-per-turn', [missing]],
    ['cache-stability', [missing, empty]],
    ['cache-stability', [empty, missing]],
    ['spawn-reads', [missing]],
  ]) {
    test(`${name} ${args.map((arg) => arg.split('/').pop()).join(' ')} missing file exits 1`, () => {
      const result = run(`${name}.mjs`, args);
      assert.equal(result.status, 1);
      assert.equal(result.stderr, `Error: file not found: ${missing}\n`);
    });
  }

  for (const [name, args, message] of [
    ['replay-session', [empty], 'No assistant turns with usage data found.'],
    ['tokens-per-turn', [empty], 'No turn data found.'],
    ['cache-stability', [empty, empty], 'No matching turns found.'],
  ]) {
    test(`${name} no turns exits 1`, () => {
      const result = run(`${name}.mjs`, args);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, `${message}\n`);
    });
  }

  test('a non-numeric token value exits 1', () => {
    const replay = join(scratch, 'null-replay.jsonl');
    writeFileSync(replay, '{"input_tokens": null, "output_tokens": 5}\n');
    const result = run('tokens-per-turn.mjs', [replay]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^TypeError: /);
  });
});
