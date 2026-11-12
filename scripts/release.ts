// Cuts a release from main. Run AFTER `dev` is merged into `main` and the merge
// has landed the version bump in plugin.json + a matching CHANGELOG entry.
//
//   git checkout main && git pull origin main
//   node --experimental-strip-types scripts/release.ts
//
// What it does (each step asks for explicit y/N + skips if already done):
//   1. Tag main HEAD as v<plugin.json version>
//   2. Push the tag to origin
//   3. Await the tag's release-gate run; refuse unless it concluded success
//   4. Create the GitHub release with notes extracted from CHANGELOG.md
//   5. Run the L5 release canary (re-clone the tag in Docker, run install-smoke)
//   6. Re-pin the rc channel to the new stable tag's payload/<tag>
//      (publish-rc-channel.ts --stable-repin — docs/contributing/RELEASE.md Phase D step 14)
//
// Idempotent + safety-checked:
//   - Refuses to run unless current branch is `main`.
//   - Refuses to run unless the tree is clean and synced with origin/main.
//   - Refuses to run unless plugin.json version matches a v<version>
//     section in CHANGELOG.md (catches release-prep merges that didn't land).
//   - Refuses to run if mcp pkg.json version disagrees with plugin.json.
//   - Refuses to create the release unless the tag's release-gate run concluded
//     success (no bypass flag).

import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { awaitReleaseGate, hasCommand, resolveGateTag } from './lib/await-release-gate.ts';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_REPO = 'https://github.com/trustmybot/plugin.git';
const QUIET: SpawnSyncOptions = { stdio: ['ignore', 'pipe', 'ignore'] };
const CAPTURE: SpawnSyncOptions = { stdio: ['inherit', 'pipe', 'inherit'] };
const INHERIT: SpawnSyncOptions = { stdio: 'inherit' };

class Exit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

const out = (s: string): void => void process.stdout.write(s);
const err = (s: string): void => void process.stderr.write(s);

function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): SpawnSyncReturns<string> {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts }) as SpawnSyncReturns<string>;
}

function statusOf(r: SpawnSyncReturns<string>): number {
  if (r.status !== null) return r.status;
  return (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? 127 : 1;
}

function must(r: SpawnSyncReturns<string>): SpawnSyncReturns<string> {
  if (r.status !== 0) throw new Exit(statusOf(r));
  return r;
}

function git(args: string[], opts: SpawnSyncOptions = CAPTURE): string {
  return (must(run('git', args, opts)).stdout ?? '').replace(/\n+$/, '');
}

function succeeds(cmd: string, args: string[]): boolean {
  return run(cmd, args, QUIET).status === 0;
}

function remoteTagSha(tag: string): string {
  return git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], QUIET)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split(/\s+/)[0])
    .join('\n');
}

function readVersion(path: string): string {
  const version: unknown = (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>).version;
  return version === undefined || version === null ? 'null' : String(version);
}

function fileLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function releaseNotes(changelog: string, tag: string): string {
  const notes: string[] = [];
  let active = false;
  for (const line of fileLines(changelog)) {
    if (line.startsWith(`## ${tag} `)) {
      active = true;
      continue;
    }
    if (!active) continue;
    if (/^## v[0-9]/.test(line)) break;
    if (/^---[ \t\r\v\f]*$/.test(line)) continue;
    notes.push(`${line}\n`);
  }
  return notes.join('');
}

let prompts: { rl: Interface; lines: AsyncIterator<string> } | undefined;

async function confirm(question: string): Promise<boolean> {
  out(`${question} [y/N] `);
  if (prompts === undefined) {
    const rl = createInterface({ input: process.stdin, terminal: false });
    prompts = { rl, lines: rl[Symbol.asyncIterator]() };
  }
  const answer = await prompts.lines.next();
  return !answer.done && ['y', 'Y', 'yes', 'YES'].includes(answer.value);
}

const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

async function main(): Promise<void> {
  process.chdir(PLUGIN_ROOT);

  if (!hasCommand('gh')) {
    err('❌ gh CLI is required.\n');
    throw new Exit(1);
  }

  const newVersion = readVersion('.claude-plugin/plugin.json');
  const newTag = `v${newVersion}`;

  // ---------- safety checks ----------

  const currentBranch = git(['branch', '--show-current']);
  if (currentBranch !== 'main') {
    err(`❌ Refusing to run. Current branch: ${currentBranch} — must be 'main'.\n`);
    err('   Run: git checkout main && git pull origin main\n');
    throw new Exit(1);
  }

  if (!succeeds('git', ['diff', '--quiet', 'HEAD']) || !succeeds('git', ['diff', '--cached', '--quiet'])) {
    err('❌ Refusing to run. Working tree has uncommitted changes.\n');
    throw new Exit(1);
  }

  git(['fetch', 'origin', '--quiet'], INHERIT);
  const localHead = git(['rev-parse', 'main']);
  const remoteHead = git(['rev-parse', 'origin/main']);
  if (localHead !== remoteHead) {
    err(`❌ Refusing to run. Local main (${localHead.slice(0, 8)}) != origin/main (${remoteHead.slice(0, 8)}).\n`);
    err('   Run: git pull origin main\n');
    throw new Exit(1);
  }

  const mcpVersion = readVersion('mcp/trajectory-server/package.json');
  if (mcpVersion !== newVersion) {
    err(`❌ Refusing to run. mcp/trajectory-server/package.json version is ${mcpVersion} — expected ${newVersion} (from plugin.json).\n`);
    err('   Bump both in the same release-prep PR.\n');
    throw new Exit(1);
  }

  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  if (!fileLines(changelog).some((line) => line.startsWith(`## ${newTag} `))) {
    err(`❌ Refusing to run. CHANGELOG.md has no '## ${newTag}' section.\n`);
    err("   Either the dev → main merge didn't land the release-prep commit,\n");
    err('   or you forgot to add the CHANGELOG entry.\n');
    throw new Exit(1);
  }

  // The release gate is the CI release-gate (L1–L4 + L6 + L0, = local L6 15/15),
  // run on the rc tag before promotion — not a manual sign-off here.

  out('✓ Pre-flight checks passed.\n');
  out(`  Branch:        main @ ${localHead.slice(0, 8)}\n`);
  out(`  Version:       ${newVersion} (plugin.json + mcp pkg.json agree)\n`);
  out(`  Tag to create: ${newTag}\n\n`);

  // ---------- step 1: tag main HEAD ----------

  if (succeeds('git', ['rev-parse', newTag])) {
    const existingTagSha = git(['rev-parse', newTag]);
    const peeled = run('git', ['rev-parse', `${newTag}^{commit}`], QUIET);
    const existingTagTarget = peeled.status === 0 ? peeled.stdout.replace(/\n+$/, '') : existingTagSha;
    if (existingTagTarget === localHead) {
      out(`  Step 1: ${newTag} already points at HEAD — skipping retag.\n\n`);
    } else {
      // The local tag exists but points elsewhere. Re-tagging a published release
      // breaks every downstream consumer's pinning + the marketplace cache, so a
      // tag already on origin is refused: bump the version and ship a new tag.
      const publishedSha = remoteTagSha(newTag);
      if (publishedSha !== '') {
        err('❌ Refusing to re-tag a PUBLISHED release.\n');
        err('\n');
        err(`  ${newTag} is already on origin (sha=${publishedSha.slice(0, 8)}).\n`);
        err('  Re-tagging breaks every consumer that pinned to this version,\n');
        err('  silently corrupts marketplace caches, and destroys the audit trail.\n');
        err('\n');
        err(`  If you found a bug in ${newTag}, ship a NEW version with the fix:\n`);
        err(`    1. Bump plugin.json + mcp pkg.json + root pkg.json to v${newVersion.replace(/\.[^.]*$/, '')}.<next-patch>\n`);
        err('    2. Add a CHANGELOG section for the new version\n');
        err('    3. PR through dev → main → node --experimental-strip-types scripts/release.ts\n');
        err('\n');
        err('  Optionally annotate the broken release on GitHub:\n');
        err(`    gh release edit ${newTag} --notes "⚠️  Known bug: <describe>. Upgrade to v..."\n`);
        throw new Exit(1);
      }
      out(
        `  ⚠️  Local-only ${newTag} exists at ${existingTagTarget.slice(0, 8)} but points at ${existingTagTarget.slice(0, 8)}, not main HEAD ${localHead.slice(0, 8)}.\n`,
      );
      out('      (Not on origin yet — local-only retag is safe.)\n');
      if (await confirm(`  Move ${newTag} to current main HEAD?`)) {
        git(['tag', '-d', newTag], INHERIT);
        git(['tag', '-a', newTag, '-m', newTag], INHERIT);
        out(`  ✓ ${newTag} re-tagged locally on ${localHead.slice(0, 8)}\n\n`);
      } else {
        out(`  Skipped — ${newTag} left where it is.\n\n`);
      }
    }
  } else if (await confirm(`Step 1: Tag main HEAD as ${newTag}?`)) {
    git(['tag', '-a', newTag, '-m', newTag], INHERIT);
    out(`  ✓ ${newTag} tagged on ${localHead.slice(0, 8)}\n\n`);
  } else {
    out('  Skipped — exiting (downstream steps depend on the tag).\n');
    throw new Exit(1);
  }

  // ---------- step 2: push the tag ----------

  if (remoteTagSha(newTag) === '') {
    if (await confirm(`Step 2: Push ${newTag} to origin?`)) {
      git(['push', 'origin', newTag], INHERIT);
      out(`  ✓ ${newTag} pushed\n\n`);
    } else {
      out('  Skipped — exiting (release-create needs the remote tag).\n');
      throw new Exit(1);
    }
  } else {
    out(`  Step 2: ${newTag} already pushed to origin — skipping.\n\n`);
  }

  // ---------- step 3: await the tag-triggered release-gate verdict ----------
  //
  // The release gate fires only on rc tags (#630) — a stable cut is functionally
  // identical to the rc it promotes, so it is never re-gated. resolveGateTag maps
  // the tag we push to the tag whose run carries the verdict. Refuse to make the
  // release public unless that run concluded success: a red or missing rc verdict
  // must stop here, not 13 minutes after the release is already live.

  const gate = resolveGateTag(newTag);
  if (gate.code !== 0) throw new Exit(gate.code);
  if (gate.tag !== newTag) {
    out(`  Step 3: Awaiting the release-gate run for ${gate.tag} (the promoted rc's verdict for ${newTag}) ...\n`);
  } else {
    out(`  Step 3: Awaiting the release-gate run for ${gate.tag} ...\n`);
  }
  const verdict = await awaitReleaseGate(gate.tag);
  if (verdict !== 0) throw new Exit(verdict);
  out('\n');

  // ---------- step 4: create the GitHub release ----------

  if (succeeds('gh', ['release', 'view', newTag])) {
    out(`  Step 4: GitHub release ${newTag} already exists — skipping.\n\n`);
  } else if (await confirm(`Step 4: Create GitHub release ${newTag} with the CHANGELOG body?`)) {
    const notes = releaseNotes(changelog, newTag);
    if (notes === '') {
      err(`❌ Failed to extract ${newTag} notes from CHANGELOG.md — aborting.\n`);
      throw new Exit(1);
    }
    const notesFile = join(tempDir('tmb-release-notes-'), 'notes.md');
    writeFileSync(notesFile, notes);
    must(run('gh', ['release', 'create', newTag, '--title', newTag, '--notes-file', notesFile], INHERIT));
    out(`  ✓ GitHub release ${newTag} created\n\n`);
  } else {
    out('  Skipped.\n\n');
  }

  // ---------- step 5: L5 release canary (post-tag verify) ----------
  //
  // Re-clones the freshly-tagged release into a temp dir and builds the
  // install-smoke Dockerfile against it. Catches "the published artifact differs
  // from what we tested locally". Skipped if Docker is unavailable; warning
  // instead of failure since the release is already public at this point.

  if (await confirm('Step 5: Run L5 release canary (re-clone tag in Docker, run install-smoke)?')) {
    if (!hasCommand('docker')) {
      out('  ⊘ docker not available — skipping canary. Run manually before announcing the release:\n');
      out('      node --experimental-strip-types tests/l0-install/run-docker.ts install\n');
    } else {
      const canaryDir = tempDir('tmb-canary-');
      out(`  Cloning ${newTag} into ${canaryDir} ...\n`);
      const clone = run('git', ['clone', '--quiet', '--depth', '1', '--branch', newTag, PLUGIN_REPO, join(canaryDir, 'plugin')], INHERIT);
      if (clone.status === 0) {
        // A stalled buildkit must not hang the release (#643): default 600 s,
        // override with TMB_CANARY_TIMEOUT. --no-cache: the canary runs once per
        // release and must never reuse a stale layer.
        const canaryTimeout = process.env.TMB_CANARY_TIMEOUT || '600';
        const build = run(
          'docker',
          ['build', '-f', 'tests/l0-install/install-smoke.Dockerfile', '-t', `tmb-canary-${newVersion}`, '--no-cache', '--quiet', '.'],
          { ...INHERIT, cwd: join(canaryDir, 'plugin'), timeout: Number(canaryTimeout) * 1000, killSignal: 'SIGTERM' },
        );
        if (build.status === 0) {
          out(`  ✓ Canary PASSED — published ${newTag} installs cleanly from a fresh clone\n\n`);
        } else {
          if ((build.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
            err(`\n  ⚠️  CANARY TIMED OUT after ${canaryTimeout}s — docker build did not finish.\n`);
            err(`     The release ${newTag} is already public; the canary is INCONCLUSIVE, not green.\n`);
            err('     Re-run manually before announcing: node --experimental-strip-types tests/l0-install/run-docker.ts install\n');
            err('     (raise the budget with TMB_CANARY_TIMEOUT=<seconds> if the build is just slow).\n');
          } else {
            err(`\n  ⚠️  CANARY FAILED — published ${newTag} does NOT install cleanly!\n`);
            err('     The release is public but broken. Investigate before announcing.\n');
            err('     Likely causes: .gitignore excluded something needed; postinstall regression;\n');
            err('     bun.lock out of sync; etc.\n');
          }
          throw new Exit(1);
        }
      } else {
        err(`  ⚠️  Could not clone tag ${newTag} — release exists but git clone failed.\n`);
      }
    }
  } else {
    out("  Skipped — run 'node --experimental-strip-types tests/l0-install/run-docker.ts install' manually before announcing.\n\n");
  }

  // ---------- step 6: re-pin the rc channel to the stable tag ----------
  //
  // docs/contributing/RELEASE.md Phase D step 14. After a stable cut the rc channel must converge
  // on the released build: publish-rc-channel.ts --stable-repin pins
  // payload/<tag>, the runtime-only build release-payload.yml pushes on the tag
  // push of step 2. Fail-forward like the canary: the release is already public,
  // so a failure warns loudly and prints the manual re-pin command.

  const repin = `node --experimental-strip-types scripts/publish-rc-channel.ts --stable-repin ${newVersion}`;
  if (await confirm(`Step 6: Re-pin the rc channel to payload/${newTag}?`)) {
    const publish = run(
      process.execPath,
      ['--experimental-strip-types', join(PLUGIN_ROOT, 'scripts/publish-rc-channel.ts'), '--stable-repin', '--yes', newVersion],
      INHERIT,
    );
    if (publish.status === 0) {
      out(`  ✓ rc channel re-pinned to payload/${newTag}\n\n`);
    } else {
      err(`\n  ⚠️  rc-channel re-pin FAILED — ${newTag} is already public.\n`);
      err('     rc-channel installs may still serve the previous rc. Re-pin manually:\n');
      err(`       ${repin}\n\n`);
    }
  } else {
    out('  Skipped — re-pin manually before the next rc cycle:\n');
    out(`      ${repin}\n\n`);
  }

  // ---------- summary ----------

  out('Done. Verify:\n');
  out(`  - https://github.com/trustmybot/plugin/releases/tag/${newTag}\n`);
  out(`  - git ls-remote --tags origin | grep ${newTag}\n`);
  out(`  - git ls-remote origin refs/tags/payload/${newTag}   (the runtime payload, pushed by release-payload.yml)\n`);
  out(`  - git ls-remote origin refs/heads/stable-build   (should match refs/tags/payload/${newTag})\n`);
}

function finish(code: number): void {
  prompts?.rl.close();
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  process.exitCode = code;
}

main().then(
  () => finish(0),
  (e: unknown) => {
    if (!(e instanceof Exit)) err(`release: ${e instanceof Error ? e.message : String(e)}\n`);
    finish(e instanceof Exit ? e.code : 1);
  },
);
