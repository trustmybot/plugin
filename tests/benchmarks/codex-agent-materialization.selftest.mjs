#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  assertArtifactMatchesSource,
  assertInstalledArtifactIsolation,
  assertMaterializationStatus,
  hashDirectory,
  nearestRank,
  parseArguments,
  parseArtifactProvenance,
  readArtifactProvenance,
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
assert.doesNotThrow(() => assertInstalledArtifactIsolation(installedDir));
const artifactWithDependencies = join(tempRoot, 'artifact-with-dependencies');
mkdirSync(join(artifactWithDependencies, 'node_modules'), { recursive: true });
assert.throws(
  () => assertInstalledArtifactIsolation(artifactWithDependencies),
  /must not contain node_modules/,
);
const artifactWithGit = join(tempRoot, 'artifact-with-git');
mkdirSync(join(artifactWithGit, '.git'), { recursive: true });
assert.throws(
  () => assertInstalledArtifactIsolation(artifactWithGit),
  /must not contain \.git/,
);

const sourceCheckout = join(tempRoot, 'source-checkout');
const matchedArtifact = join(tempRoot, 'matched-artifact');
mkdirSync(join(sourceCheckout, 'scripts'), { recursive: true });
mkdirSync(join(sourceCheckout, 'skills'), { recursive: true });
writeFileSync(join(sourceCheckout, 'README.md'), 'fixed source\n');
writeFileSync(join(sourceCheckout, 'scripts', 'tool.sh'), '#!/bin/sh\nexit 0\n');
chmodSync(join(sourceCheckout, 'scripts', 'tool.sh'), 0o755);
symlinkSync('../scripts/tool.sh', join(sourceCheckout, 'skills', 'tool.sh'));
const fixtureGit = (args) => execFileSync(
  'git',
  [
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.hooksPath=/dev/null',
    ...args,
  ],
  { encoding: 'utf8', env: sanitizedGitEnvironment() },
);
fixtureGit(['init', '--quiet', sourceCheckout]);
fixtureGit(['-C', sourceCheckout, 'add', '.']);
fixtureGit([
  '-C',
  sourceCheckout,
  '-c',
  'user.name=Scope 4 Selftest',
  '-c',
  'user.email=scope4-selftest@example.invalid',
  'commit',
  '--quiet',
  '-m',
  'fixture',
]);
const sourceSha = fixtureGit(['-C', sourceCheckout, 'rev-parse', 'HEAD']).trim();

mkdirSync(join(matchedArtifact, 'scripts'), { recursive: true });
mkdirSync(join(matchedArtifact, 'skills'), { recursive: true });
writeFileSync(join(matchedArtifact, 'README.md'), 'fixed source\n');
writeFileSync(join(matchedArtifact, 'scripts', 'tool.sh'), '#!/bin/sh\nexit 0\n');
chmodSync(join(matchedArtifact, 'scripts', 'tool.sh'), 0o755);
symlinkSync('../scripts/tool.sh', join(matchedArtifact, 'skills', 'tool.sh'));
writeFileSync(
  join(matchedArtifact, '.tmb-artifact-provenance.json'),
  `${JSON.stringify({ source_sha: sourceSha })}\n`,
);
assert.doesNotThrow(() =>
  assertArtifactMatchesSource(matchedArtifact, sourceCheckout, sourceSha));
assert.throws(
  () => assertArtifactMatchesSource(matchedArtifact, sourceCheckout, 'a'.repeat(40)),
  /does not match harness HEAD/,
);

writeFileSync(join(matchedArtifact, 'README.md'), 'mutated artifact\n');
assert.throws(
  () => assertArtifactMatchesSource(matchedArtifact, sourceCheckout, sourceSha),
  /file does not match source_sha/,
);
writeFileSync(join(matchedArtifact, 'README.md'), 'fixed source\n');
chmodSync(join(matchedArtifact, 'scripts', 'tool.sh'), 0o644);
assert.throws(
  () => assertArtifactMatchesSource(matchedArtifact, sourceCheckout, sourceSha),
  /type or mode does not match source_sha/,
);
chmodSync(join(matchedArtifact, 'scripts', 'tool.sh'), 0o755);
writeFileSync(join(sourceCheckout, 'README.md'), 'dirty source\n');
assert.throws(
  () => assertArtifactMatchesSource(matchedArtifact, sourceCheckout, sourceSha),
  /must have no tracked changes/,
);
writeFileSync(join(sourceCheckout, 'README.md'), 'fixed source\n');

const originalArtifactHash = hashDirectory(matchedArtifact);
unlinkSync(join(matchedArtifact, 'skills', 'tool.sh'));
symlinkSync('../README.md', join(matchedArtifact, 'skills', 'tool.sh'));
assert.notEqual(hashDirectory(matchedArtifact), originalArtifactHash);

const artifactWithEscapingLink = join(tempRoot, 'artifact-with-escaping-link');
mkdirSync(artifactWithEscapingLink);
symlinkSync(sourceCheckout, join(artifactWithEscapingLink, 'outside'));
assert.throws(
  () => assertInstalledArtifactIsolation(artifactWithEscapingLink),
  /symlink escapes its root/,
);
const artifactWithProvenanceLink = join(tempRoot, 'artifact-with-provenance-link');
mkdirSync(artifactWithProvenanceLink);
writeFileSync(join(artifactWithProvenanceLink, 'payload'), '{}\n');
symlinkSync('payload', join(artifactWithProvenanceLink, '.tmb-artifact-provenance.json'));
assert.throws(
  () => readArtifactProvenance(artifactWithProvenanceLink),
  /must be a regular file/,
);
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
