// Publishes an rc tag to the rc channel.
//
// Sanctioned, guard-compatible companion to scripts/release.ts. The session
// git-guards inspect only the top-level command, so running this script runs its
// internal `git push` legitimately — unlike a hand edit + push to the production
// marketplace-rc main, which the classifier blocks.
//
// Run AFTER the vX.Y.Z-rc.N tag is pushed to origin (scripts/release.ts, or a
// manual rc tag). Points the rc-channel catalog at payload/<tag>, the tag's
// runtime-only build that .github/workflows/release-payload.yml pushes, so
// installs of `tmb@trustmybot-rc` serve the rc under validation.
//
//   node --experimental-strip-types scripts/publish-rc-channel.ts [version] [--stable-repin] [--yes] [--dry-run]
//
// What it does:
//   1. Resolve VERSION (arg or .claude-plugin/plugin.json .version) → TAG=v$VERSION.
//   2. Refuse unless VERSION is rc-only (X.Y.Z-rc.N).
//   3. Verify the tag exists on origin (must be pushed first).
//   4. Await the tag's release-gate run; refuse unless it concluded success
//      (read-only — runs in --dry-run too).
//   5. Await payload/TAG on origin (scripts/await-payload-tag.ts); refuse when
//      it does not appear (read-only — runs in --dry-run too).
//   6. Clone trustmybot/marketplace-rc into a temp dir (removed on exit).
//   7. Set .claude-plugin/marketplace.json plugins[0].source.ref → payload/TAG; validate JSON.
//   8. Ensure a marketplace-rc README.md exists.
//   9. Show the diff, confirm y/N (skipped by --yes), then commit + push origin main.
//
// --stable-repin mode (docs/contributing/RELEASE.md Phase D step 14):
//   Re-pins the rc channel to a STABLE tag (X.Y.Z) after a release so rc-channel
//   installs converge on the released build between rc cycles. VERSION must match
//   a stable tag; the rc-only refusal and the release-gate pre-check are bypassed
//   (stable tags fire no gate — the content was gated at its rc). Every other
//   step is identical. Fired by scripts/release.ts step 6.
//
// Idempotent + safety-checked:
//   - Refuses any non-rc version (or, in --stable-repin, any non-stable version).
//   - Refuses if the tag is not on origin.
//   - Refuses unless the tag's release-gate run concluded success (no bypass flag;
//     skipped in --stable-repin, where no gate fires).
//   - Refuses unless payload/TAG reaches origin within the helper's timeout
//     (TMB_PAYLOAD_TIMEOUT, default 600s).
//   - Never operates on a hardcoded local catalog path — always a fresh temp clone.
//   - If the ref already points at payload/TAG AND the README is present → prints
//     'already published' and exits 0.
//   - --dry-run prints the intended change and never commits or pushes.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { awaitReleaseGate } from './lib/await-release-gate.ts';

const PLUGIN_REPO = 'https://github.com/trustmybot/plugin.git';
const CATALOG_REPO = 'https://github.com/trustmybot/marketplace-rc.git';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'node --experimental-strip-types scripts/publish-rc-channel.ts [version] [--stable-repin] [--yes] [--dry-run]';

const README_TEMPLATE = [
  '# TMB plugin marketplace — RC',
  '',
  "Catalog for the **rc channel** of the [TMB plugin](https://github.com/trustmybot/plugin). Pins the rc's `payload/vX.Y.Z-rc.N` tag, the runtime-only build of the latest `vX.Y.Z-rc.N` under validation — the release candidate that's passed the local L6 chain and is being re-confirmed by the CI release-gate before it ships as stable. Use this when you want to dogfood a build that's close to release but ahead of the stable channel.",
  '',
  '## Install',
  '',
  'From the project root:',
  '',
  '```',
  'claude plugin marketplace add trustmybot/marketplace-rc --scope local', // cli-config-scope: printed
  'claude plugin install tmb@trustmybot-rc --scope local', // cli-config-scope: printed
  '```',
  '',
  'The rc channel installs as `tmb` (same name as the released plugin), so only one can be enabled at a time.',
  '',
  '### Disable any existing `tmb` install first',
  '',
  'From the project root, with `<marketplace>` the channel it came from (e.g. `trustmybot`):',
  '',
  '```',
  'claude plugin disable tmb@<marketplace> --scope local', // cli-config-scope: printed
  '```',
  '',
  'Disable rather than uninstall so you can flip back to the released channel with `claude plugin enable tmb@<marketplace> --scope local` when done. Fully quit and relaunch Claude Code after each change; a plugin change applies only on a fresh start.', // cli-config-scope: printed
  '',
  'The rc channel is a per-developer choice, so every command here installs at local scope; see [Recommended scope](https://github.com/trustmybot/plugin/blob/main/docs/reference/INSTALL.md#recommended-scope-project-or-local).',
  '',
  '## Pull the latest rc',
  '',
  "The marketplace ref is the current rc's `payload/vX.Y.Z-rc.N` tag, but CC caches a clone — when the channel re-pins to a newer rc tag, refresh to pick it up:",
  '',
  '```',
  'claude plugin marketplace update trustmybot-rc', // cli-config-scope: printed
  'claude plugin update tmb@trustmybot-rc --scope local', // cli-config-scope: printed
  '```',
  '',
  'A restart alone only loads what CC already has on disk; you need `marketplace update` + `update` to fetch the newly-pinned tag from the remote, then fully quit and relaunch Claude Code.',
  '',
  '## Flip back to the released channel when done',
  '',
  '```',
  'claude plugin uninstall tmb@trustmybot-rc --scope local', // cli-config-scope: printed
  'claude plugin enable tmb@<marketplace> --scope local', // cli-config-scope: printed
  '```',
  '',
  'Then fully quit and relaunch Claude Code.',
  '',
  '## Channel routing',
  '',
  '- This catalog: **RC channel** (latest `payload/vX.Y.Z-rc.N` tag — pre-release builds under validation)',
  '- [trustmybot/marketplace-dev](https://github.com/trustmybot/marketplace-dev) — dev channel (`trustmybot/plugin@dev` — bleeding edge)',
  '- [trustmybot/marketplace](https://github.com/trustmybot/marketplace) — production (stable tags from main)',
  '',
  '## Source',
  '',
  'Plugin code lives at [trustmybot/plugin](https://github.com/trustmybot/plugin). This repo contains only the marketplace catalog (`.claude-plugin/marketplace.json`).',
  '',
].join('\n');

class Exit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

const out = (s: string): void => void process.stdout.write(s);
const err = (s: string): void => void process.stderr.write(s);

function statusOf(r: SpawnSyncReturns<string>): number {
  if (r.status !== null) return r.status;
  return (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? 127 : 1;
}

function must(r: SpawnSyncReturns<string>): void {
  if (r.status !== 0) throw new Exit(statusOf(r));
}

function gitIn(dir: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'inherit' });
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

interface Options {
  version: string;
  assumeYes: boolean;
  dryRun: boolean;
  stableRepin: boolean;
}

function parseArgs(argv: string[]): Options {
  const o: Options = { version: '', assumeYes: false, dryRun: false, stableRepin: false };
  for (const arg of argv) {
    if (arg === '--stable-repin') o.stableRepin = true;
    else if (arg === '--yes') o.assumeYes = true;
    else if (arg === '--dry-run') o.dryRun = true;
    else if (arg.startsWith('-')) {
      err(`❌ Unknown flag: ${arg}\n`);
      err(`   Usage: ${USAGE}\n`);
      throw new Exit(1);
    } else if (o.version !== '') {
      err(`❌ Multiple versions given: ${o.version} and ${arg}\n`);
      throw new Exit(1);
    } else {
      o.version = arg;
    }
  }
  return o;
}

let workDir: string | undefined;

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));

  // ---------- resolve version ----------

  let version = o.version;
  if (version === '') {
    const v: unknown = (JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin/plugin.json'), 'utf8')) as Record<string, unknown>).version;
    version = v === undefined || v === null ? 'null' : String(v);
  }

  // ---------- refuse a version that doesn't match the mode ----------

  if (o.stableRepin) {
    // The deliberate inverse of the default rc-only refusal: an rc version here
    // is a mode mismatch and is refused fail-closed.
    if (!/^v?[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
      err(`❌ Refusing to re-pin. Version '${version}' is not a stable version.\n`);
      err('   --stable-repin re-pins the rc channel to a stable tag (e.g. 1.0.0).\n');
      err('   For an rc tag, drop --stable-repin and pass the rc version.\n');
      throw new Exit(1);
    }
    version = version.replace(/^v/, '');
  } else if (!/^[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$/.test(version)) {
    err(`❌ Refusing to publish. Version '${version}' is not an rc version.\n`);
    err('   The rc channel only serves rc tags (e.g. 0.10.0-rc.2).\n');
    err('   For a stable tag, re-pin the rc channel with --stable-repin.\n');
    throw new Exit(1);
  }

  const tag = `v${version}`;
  const payloadRef = `payload/${tag}`;

  // ---------- verify the tag exists on origin ----------

  const remoteTag = spawnSync('git', ['ls-remote', '--tags', PLUGIN_REPO, `refs/tags/${tag}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if ((remoteTag.stdout ?? '').trim() === '') {
    err(`❌ Refusing to publish. Tag ${tag} is not on origin.\n`);
    err('   Push the rc tag first (scripts/release.ts tags + pushes it),\n');
    err('   then re-run this script.\n');
    throw new Exit(1);
  }

  // ---------- await the tag-triggered release-gate verdict ----------
  //
  // Read-only, so it runs in --dry-run too. No bypass flag: a red tag gate means
  // roll back the channel/tag and ship a new rc. --stable-repin skips it: stable
  // tags fire no gate (gated at its rc, re-checked by release.ts step 3).

  if (o.stableRepin) {
    out(`Re-pinning the rc channel to the stable tag ${tag} (no gate — gated at its rc) ...\n`);
  } else {
    out(`Checking the release-gate run for ${tag} ...\n`);
    const verdict = await awaitReleaseGate(tag, PLUGIN_ROOT);
    if (verdict !== 0) throw new Exit(verdict);
  }

  // ---------- await the tag's runtime payload ----------
  //
  // The tag push also fired release-payload.yml, which pushes payload/TAG — the
  // runtime-only build the catalog pins. Read-only, so it runs in --dry-run too.

  out(`Waiting for ${payloadRef} on origin ...\n`);
  const payload = spawnSync(
    process.execPath,
    ['--experimental-strip-types', join(PLUGIN_ROOT, 'scripts/await-payload-tag.ts'), tag, '--remote', PLUGIN_REPO],
    { cwd: PLUGIN_ROOT, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] },
  );
  must(payload);
  out(`✓ ${payloadRef} is on origin at ${payload.stdout.replace(/\n+$/, '')}.\n`);

  // ---------- clone the catalog into a temp dir ----------

  workDir = mkdtempSync(join(tmpdir(), 'tmb-rc-catalog-'));
  const clone = join(workDir, 'marketplace-rc');

  out(`Cloning ${CATALOG_REPO} ...\n`);
  must(spawnSync('git', ['clone', '--quiet', '--depth', '1', CATALOG_REPO, clone], { encoding: 'utf8', stdio: 'inherit' }));

  const marketplaceJson = join(clone, '.claude-plugin/marketplace.json');
  const readme = join(clone, 'README.md');

  if (!existsSync(marketplaceJson)) {
    err(`❌ ${CATALOG_REPO} has no .claude-plugin/marketplace.json — unexpected catalog layout.\n`);
    throw new Exit(1);
  }

  const catalog = JSON.parse(readFileSync(marketplaceJson, 'utf8')) as { plugins?: Array<{ source?: { ref?: unknown } }> };
  const currentRefValue = catalog.plugins?.[0]?.source?.ref;
  const currentRef = currentRefValue === undefined || currentRefValue === null ? 'null' : String(currentRefValue);

  // ---------- idempotency check ----------

  if (currentRef === payloadRef && existsSync(readme)) {
    out(`✓ Already published — ref is ${payloadRef} and README.md is present. Nothing to do.\n`);
    return;
  }

  // ---------- update the ref ----------

  catalog.plugins ??= [];
  catalog.plugins[0] ??= {};
  catalog.plugins[0].source ??= {};
  catalog.plugins[0].source.ref = payloadRef;
  const updated = `${JSON.stringify(catalog, null, 2)}\n`;
  try {
    JSON.parse(updated);
  } catch {
    err('❌ Updated marketplace.json failed JSON validation — aborting.\n');
    throw new Exit(1);
  }
  const updatedJson = join(workDir, 'marketplace.json.new');
  writeFileSync(updatedJson, updated);
  renameSync(updatedJson, marketplaceJson);

  // ---------- ensure README ----------

  const readmeCreated = !existsSync(readme);
  if (readmeCreated) writeFileSync(readme, README_TEMPLATE);

  // ---------- show intent ----------

  out('\n✓ rc-channel publish plan:\n');
  out(`  Catalog:       ${CATALOG_REPO}\n`);
  out(`  source.ref:    ${currentRef} → ${payloadRef}\n`);
  out(readmeCreated ? '  README.md:     create (was missing)\n' : '  README.md:     present (unchanged)\n');
  out('\n');

  gitIn(clone, ['--no-pager', 'diff']);
  out('\n');

  // ---------- dry-run ----------

  if (o.dryRun) {
    out(`✓ --dry-run: would set ref to ${payloadRef}${readmeCreated ? ' and create README.md' : ''}. No commit, no push.\n`);
    return;
  }

  // ---------- confirm ----------

  if (!o.assumeYes && !(await confirm('Commit and push this to marketplace-rc main?'))) {
    out('Aborted — no changes pushed.\n');
    throw new Exit(1);
  }

  // ---------- commit + push ----------

  must(gitIn(clone, ['add', '.claude-plugin/marketplace.json', 'README.md']));
  must(gitIn(clone, ['commit', '-m', `🚀 chore(rc): publish ${tag} to the rc channel`]));
  must(gitIn(clone, ['push', 'origin', 'main']));

  out(`\n✓ Published ${tag} to the rc channel.\n`);
  out(`  Installs of tmb@trustmybot-rc now serve ${tag} (${payloadRef}).\n`);
}

function finish(code: number): void {
  prompts?.rl.close();
  if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
  process.exitCode = code;
}

main().then(
  () => finish(0),
  (e: unknown) => {
    if (!(e instanceof Exit)) err(`publish-rc-channel: ${e instanceof Error ? e.message : String(e)}\n`);
    finish(e instanceof Exit ? e.code : 1);
  },
);
