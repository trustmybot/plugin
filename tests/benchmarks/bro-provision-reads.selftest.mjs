#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeInputs,
  analyzeSession,
  classifyBash,
  classifyToolUse,
  isWorldModelTool,
  parseArguments,
  summarize,
  toolSuffix,
} from './bro-provision-reads.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'bro-provision-reads.mjs');
const fixture = join(here, 'fixtures', 'sessions', 'bro-provision-reads.jsonl');

assert.deepEqual(parseArguments(['--json', 'a.jsonl']), { json: true, inputs: ['a.jsonl'] });
assert.throws(() => parseArguments([]), /Usage/);
assert.throws(() => parseArguments(['--bogus', 'a.jsonl']), /Usage/);

assert.equal(toolSuffix('mcp__plugin_tmb_trajectory-server__task_provision'), 'task_provision');
assert.equal(toolSuffix('Read'), 'Read');
assert.ok(isWorldModelTool('mcp__plugin_tmb_trajectory-server__world_model_search'));
assert.ok(isWorldModelTool('scope_suggest'));
assert.ok(!isWorldModelTool('task_list'));

assert.deepEqual(classifyBash('cat src/b.ts | head -5'), { read: true, source: true });
assert.deepEqual(classifyBash('bun run build'), { read: false, source: false });
assert.deepEqual(classifyBash('git -C /repo log --oneline -3'), { read: true, source: false });
assert.deepEqual(classifyBash('git status && git diff src/x.ts'), { read: true, source: true });
assert.deepEqual(classifyBash('wc -l docs/guide.md'), { read: true, source: false });
assert.deepEqual(classifyBash('npm test; LC_ALL=C grep -rn foo lib/'), { read: true, source: true });
assert.deepEqual(classifyToolUse('Read', { file_path: '/r/README.md' }), { read: true, source: false });
assert.deepEqual(classifyToolUse('Read', { file_path: '/r/a.ts' }), { read: true, source: true });
assert.deepEqual(classifyToolUse('Grep', { pattern: 'x' }), { read: true, source: true });
assert.deepEqual(classifyToolUse('Glob', { pattern: '*.md' }), { read: true, source: true });
assert.deepEqual(classifyToolUse('Edit', {}), { read: false, source: false });

const report = analyzeInputs([fixture]);
assert.equal(report.provisions.length, 2);
const [first, second] = report.provisions;
assert.deepEqual(first, {
  session: 'bro-provision-reads',
  timestamp: '2026-01-01T12:00:15.000Z',
  task_id: 41,
  branch_id: 'feat/one',
  reads: 3,
  source_reads: 2,
  read_result_chars: 60,
  est_read_tokens: 15,
  wm_calls: 1,
});
assert.deepEqual(second, {
  session: 'bro-provision-reads',
  timestamp: '2026-01-01T12:00:27.000Z',
  task_id: null,
  branch_id: null,
  reads: 4,
  source_reads: 2,
  read_result_chars: 32,
  est_read_tokens: 8,
  wm_calls: 1,
});
assert.deepEqual(report.totals, {
  provisions: 2,
  reads: 7,
  source_reads: 4,
  est_read_tokens: 23,
  mean_source_reads_per_provision: 2,
});
assert.equal(summarize([]).mean_source_reads_per_provision, null);
assert.deepEqual(analyzeSession('not json\n\n', 'empty'), []);

const tempRoot = mkdtempSync(join(tmpdir(), 'bro-provision-reads-'));
try {
  copyFileSync(fixture, join(tempRoot, 'one.jsonl'));
  copyFileSync(fixture, join(tempRoot, 'two.jsonl'));
  writeFileSync(join(tempRoot, 'ignored.txt'), 'not a session\n');
  const dirReport = analyzeInputs([tempRoot]);
  assert.deepEqual(
    dirReport.provisions.map((row) => row.session),
    ['one', 'one', 'two', 'two'],
  );
  assert.equal(dirReport.totals.source_reads, 8);
  assert.equal(dirReport.totals.mean_source_reads_per_provision, 2);

  const json = spawnSync(process.execPath, [script, '--json', fixture], { encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), report);

  const table = spawnSync(process.execPath, [script, fixture], { encoding: 'utf8' });
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /^SESSION\s+TIMESTAMP/);
  assert.match(table.stdout, /mean_source_reads_per_provision=2\.00/);

  const missing = spawnSync(process.execPath, [script, join(tempRoot, 'missing.jsonl')], {
    encoding: 'utf8',
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ENOENT/);

  const noArgs = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(noArgs.status, 1);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

process.stdout.write('bro-provision-reads selftest passed\n');
