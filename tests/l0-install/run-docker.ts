// Local runner for the L0 Docker images (GH 1692).
//
// Usage:
//   node --experimental-strip-types tests/l0-install/run-docker.ts <install|canary|upgrade>
//
// install  builds install-smoke.Dockerfile: a fresh marketplace install boots cleanly.
// canary   builds release-canary.Dockerfile: L0 install only without CLAUDE_CODE_OAUTH_TOKEN,
//          L0 + L5 flows with it (passed as a BuildKit secret, never baked into a layer).
// upgrade  archives the v1.0.2 tag into a temp dir, passes it as the `v102` build context to
//          upgrade-smoke.Dockerfile: a real-shape v1.0.2 DB upgraded by the current server
//          passes trajectory-doctor.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasCommand } from '../../scripts/lib/await-release-gate.ts';

export type Mode = 'install' | 'canary' | 'upgrade';
export const MODES: readonly Mode[] = ['install', 'canary', 'upgrade'];
export const OLD_TAG = 'v1.0.2';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const USAGE = 'Usage: node --experimental-strip-types tests/l0-install/run-docker.ts <install|canary|upgrade>\n';

export interface BuildInputs {
  version: string;
  token?: string;
  oldTree?: string;
}

export interface DockerBuild {
  argv: string[];
  env: Record<string, string>;
}

export function dockerBuild(mode: Mode, { version, token, oldTree }: BuildInputs): DockerBuild {
  const tail = ['--progress=plain', '.'];
  switch (mode) {
    case 'install':
      return {
        argv: ['build', '-f', 'tests/l0-install/install-smoke.Dockerfile', '-t', `tmb-install-smoke:${version}`, ...tail],
        env: {},
      };
    case 'canary':
      return {
        argv: [
          'build',
          ...(token ? ['--secret', 'id=cc_token,env=CLAUDE_CODE_OAUTH_TOKEN'] : []),
          '--build-arg',
          `PLUGIN_VERSION=${version}`,
          '-f',
          'tests/l0-install/release-canary.Dockerfile',
          '-t',
          `tmb-release-canary:${version}`,
          ...tail,
        ],
        env: { DOCKER_BUILDKIT: '1' },
      };
    case 'upgrade':
      if (!oldTree) throw new Error('upgrade needs oldTree');
      return {
        argv: [
          'build',
          '-f',
          'tests/l0-install/upgrade-smoke.Dockerfile',
          '--build-context',
          `v102=${oldTree}`,
          '-t',
          `tmb-upgrade-smoke:${version}`,
          ...tail,
        ],
        env: { DOCKER_BUILDKIT: '1' },
      };
  }
}

function readVersion(): string {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')) as { version: string };
  return manifest.version;
}

function runDocker(build: DockerBuild): number {
  const r = spawnSync('docker', build.argv, {
    cwd: PLUGIN_ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...build.env },
  });
  if (r.error) {
    process.stderr.write(`❌ docker build failed to start: ${r.error.message}\n`);
    return 1;
  }
  return r.status ?? 1;
}

function archiveOldTag(dir: string): boolean {
  const archive = spawnSync('git', ['archive', OLD_TAG], { cwd: PLUGIN_ROOT, maxBuffer: 1024 * 1024 * 1024 });
  if (archive.status !== 0) {
    process.stderr.write(archive.stderr);
    return false;
  }
  const untar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout, stdio: ['pipe', 'inherit', 'inherit'] });
  return untar.status === 0;
}

export function main(args: string[]): number {
  const mode = args[0] as Mode;
  if (args.length !== 1 || !MODES.includes(mode)) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (!hasCommand('docker')) {
    process.stderr.write('❌ docker not found. Install Docker Desktop or run via CI.\n');
    return 1;
  }
  const version = readVersion();

  if (mode === 'install') {
    process.stdout.write(`Building tmb-install-smoke:${version} from a clean tree (this strips dist/ + node_modules first)...\n\n`);
    const status = runDocker(dockerBuild(mode, { version }));
    if (status === 0) process.stdout.write('\n✓ Layer 0 install-smoke passed. A fresh marketplace install would boot.\n');
    return status;
  }

  if (mode === 'canary') {
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || undefined;
    if (token) {
      process.stdout.write(`Building tmb-release-canary:${version} with CLAUDE_CODE_OAUTH_TOKEN secret (L0 + L5 flows)...\n\n`);
    } else {
      process.stdout.write('⚠️  CLAUDE_CODE_OAUTH_TOKEN not set — building install-only (L0 piece).\n');
      process.stdout.write('   To run the L5 piece too, export the token first.\n\n');
    }
    const status = runDocker(dockerBuild(mode, { version, token }));
    if (status === 0) process.stdout.write('\n✓ Release canary check passed.\n');
    return status;
  }

  const tagCheck = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${OLD_TAG}`], { cwd: PLUGIN_ROOT, stdio: 'ignore' });
  if (tagCheck.status !== 0) {
    process.stderr.write(`❌ tag ${OLD_TAG} not found. Run: git fetch origin tag ${OLD_TAG}\n`);
    return 1;
  }
  const oldTree = mkdtempSync(join(tmpdir(), 'tmb-run-upgrade-smoke-'));
  try {
    if (!archiveOldTag(oldTree)) {
      process.stderr.write(`❌ could not extract ${OLD_TAG} into ${oldTree}\n`);
      return 1;
    }
    process.stdout.write(`Building tmb-upgrade-smoke:${version}: ${OLD_TAG} DB upgraded by the current tree...\n\n`);
    const status = runDocker(dockerBuild(mode, { version, oldTree }));
    if (status === 0) process.stdout.write(`\n✓ Layer 0 upgrade-smoke passed. A ${OLD_TAG} DB upgrades cleanly.\n`);
    return status;
  } finally {
    rmSync(oldTree, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
