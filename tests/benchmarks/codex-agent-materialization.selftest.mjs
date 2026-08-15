#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  assertMaterializationStatus,
  nearestRank,
  parseArguments,
  parseArtifactProvenance,
  resolveOutputCandidate,
  sanitizedGitEnvironment,
  summarizeDurations,
  thresholdStatusFor,
  writeEvidence,
} from './codex-agent-materialization.mjs';

const tempRoot = process.argv[2];
assert.ok(tempRoot && isAbsolute(tempRoot), 'selftest temp root must be absolute');

assert.deepEqual(
  parseArguments([
    '--installed-plugin-root',
    '/tmp/installed',
    '--output-dir',
    '/tmp/evidence',
  ]),
  {
    installedPluginRoot: '/tmp/installed',
    outputDir: '/tmp/evidence',
  },
);
assert.deepEqual(
  parseArtifactProvenance(JSON.stringify({ source_sha: 'a'.repeat(40) })),
  { source_sha: 'a'.repeat(40) },
);
assert.throws(() => parseArtifactProvenance('{}'), /source_sha/);
assert.throws(
  () => parseArtifactProvenance(JSON.stringify({ source_sha: 'A'.repeat(40) })),
  /source_sha/,
);
const gitEnvironment = sanitizedGitEnvironment({
  PATH: '/usr/bin',
  GIT_DIR: '/tmp/poison.git',
  GIT_WORK_TREE: '/tmp/poison-worktree',
  GIT_CONFIG_COUNT: '1',
});
assert.equal(gitEnvironment.PATH, '/usr/bin');
assert.equal('GIT_DIR' in gitEnvironment, false);
assert.equal('GIT_WORK_TREE' in gitEnvironment, false);
assert.equal('GIT_CONFIG_COUNT' in gitEnvironment, false);
assert.equal(gitEnvironment.GIT_TERMINAL_PROMPT, '0');
assert.equal(gitEnvironment.GIT_CONFIG_NOSYSTEM, '1');
assert.equal(gitEnvironment.GIT_CONFIG_GLOBAL, '/dev/null');

const installedDir = join(tempRoot, 'installed-artifact');
const installedParentLink = join(tempRoot, 'installed-parent-link');
mkdirSync(installedDir);
symlinkSync(installedDir, installedParentLink);
assert.throws(
  () => resolveOutputCandidate(
    realpathSync(installedDir),
    join(installedParentLink, 'evidence'),
  ),
  /must not be inside/,
);
assert.throws(() => parseArguments([]), /Usage:/);
assert.throws(
  () =>
    parseArguments([
      '--installed-plugin-root',
      'relative',
      '--output-dir',
      '/tmp/evidence',
    ]),
  /absolute/,
);

const successfulStatus = (overallStatus) => ({
  content: [{
    type: 'text',
    text: JSON.stringify({ ok: true, data: { overall_status: overallStatus } }),
  }],
});
assert.doesNotThrow(() =>
  assertMaterializationStatus(successfulStatus('current'), 'current'));
assert.throws(
  () => assertMaterializationStatus(successfulStatus('absent'), 'current'),
  /expected current, received absent/,
);
assert.throws(
  () => assertMaterializationStatus({ content: [{ type: 'text', text: 'not json' }] }, 'absent'),
  /malformed JSON/,
);

const oneToOneHundred = Array.from({ length: 100 }, (_, index) => index + 1);
assert.equal(nearestRank(oneToOneHundred, 0.5), 50);
assert.equal(nearestRank(oneToOneHundred, 0.95), 95);
assert.deepEqual(summarizeDurations(7, oneToOneHundred), {
  cold_ns: 7,
  warm_p50_ns: 50,
  warm_p95_ns: 95,
  warm_max_ns: 100,
});
assert.throws(() => summarizeDurations(7, oneToOneHundred.slice(1)), /100/);

const passingState = {
  cold_ns: 1,
  warm_p50_ns: 2,
  warm_p95_ns: 100_000_000,
  warm_max_ns: 3,
};
assert.equal(thresholdStatusFor({ absent: passingState }), 'pass');
assert.equal(
  thresholdStatusFor({
    absent: { ...passingState, warm_p95_ns: 100_000_001 },
  }),
  'investigate',
);

const evidenceDir = join(tempRoot, 'materialization-evidence');
mkdirSync(evidenceDir);
const samples = Array.from({ length: 303 }, (_, index) => ({ index }));
const paths = writeEvidence(evidenceDir, samples, {
  threshold_status: 'pass',
});
assert.ok(existsSync(paths.samplesPath));
assert.ok(existsSync(paths.summaryPath));
assert.equal(
  readFileSync(paths.samplesPath, 'utf8').trim().split('\n').length,
  303,
);
assert.equal(
  JSON.parse(readFileSync(paths.summaryPath, 'utf8')).threshold_status,
  'pass',
);
assert.throws(
  () => writeEvidence(evidenceDir, samples, { threshold_status: 'pass' }),
  /EEXIST/,
);

process.stdout.write('codex-agent-materialization selftest passed\n');
