// Awaits the tag-triggered release-gate verdict. Imported by scripts/release.ts
// and scripts/publish-rc-channel.ts, which refuse to make a build public until
// the tag's .github/workflows/release-gate.yml run has concluded `success`.
//
// Both gate functions take the plugin repo dir from their caller (default: the
// checkout holding this file) and run every git command with git -C; neither
// reads the cwd.
//
//   resolveGateTag(tag, repoDir?) maps a tag to the tag whose release-gate run
//   carries its verdict. The gate fires only on rc tags (#630), so an rc tag
//   resolves to itself; a stable tag resolves to the newest v*-rc.* tag merged
//   into repoDir's HEAD, the promoted rc. Code 0 with the tag, 2 when a stable
//   tag has no rc tag in HEAD's ancestry, 1 on a usage error.
//
//   awaitReleaseGate(tag, repoDir?, timeoutS?) polls the release-gate run whose
//   headBranch is <tag> every 30 s while it is queued or in progress. Returns
//   0 concluded success (the only publishing state), 2 no run for the tag,
//   3 concluded non-success, 4 timed out while still running, 1 usage error or
//   no gh. Timeout precedence: timeoutS, else env TMB_GATE_TIMEOUT, else 1800 s.

import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GATE_REPO = 'trustmybot/plugin';
const POLL_INTERVAL_S = 30;
const WAITING = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

export function hasCommand(name: string): boolean {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

export type GateTag = { code: 0; tag: string } | { code: 1 | 2 };

export function resolveGateTag(tag: string, repoDir: string = SELF_REPO): GateTag {
  if (tag === '') {
    process.stderr.write('❌ resolve_gate_tag: missing <tag> argument.\n');
    return { code: 1 };
  }
  if (tag.includes('-rc.')) return { code: 0, tag };

  const r = spawnSync('git', ['-C', repoDir, 'tag', '--list', 'v*-rc.*', '--merged', 'HEAD', '--sort=-creatordate'], { encoding: 'utf8' });
  const rcTag = r.status === 0 ? (r.stdout.split('\n')[0] ?? '') : '';
  if (rcTag === '') {
    process.stderr.write(
      `❌ resolve_gate_tag: no v*-rc.* tag in HEAD's ancestry for stable tag ${tag}.\n` +
        "   The release gate fires only on rc tags (#630), so a stable cut's\n" +
        '   functional-identity verdict is the promoted rc\'s run — but none is an\n' +
        `   ancestor of HEAD. Promote a green rc into main before cutting ${tag}.\n`,
    );
    return { code: 2 };
  }
  return { code: 0, tag: rcTag };
}

function field(run: unknown, key: string): string {
  if (typeof run !== 'object' || run === null) return '';
  const value = (run as Record<string, unknown>)[key];
  return value === undefined || value === null || value === false ? '' : String(value);
}

function latestRun(stdout: string): unknown {
  try {
    const runs: unknown = JSON.parse(stdout);
    return Array.isArray(runs) ? runs[0] : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export async function awaitReleaseGate(tag: string, repoDir: string = SELF_REPO, timeoutS?: number): Promise<number> {
  const envTimeout = process.env.TMB_GATE_TIMEOUT;
  const timeout = timeoutS ?? Number(envTimeout === undefined || envTimeout === '' ? 1800 : envTimeout);
  let waited = 0;

  if (tag === '') {
    process.stderr.write('❌ await_release_gate: missing <tag> argument.\n');
    return 1;
  }
  if (!hasCommand('gh')) {
    process.stderr.write('❌ await_release_gate: gh CLI is required to read the release-gate run.\n');
    return 1;
  }

  for (;;) {
    const r = spawnSync(
      'gh',
      ['run', 'list', '--repo', GATE_REPO, '--workflow=release-gate', '--branch', tag, '--json', 'databaseId,status,conclusion,url', '--limit', '1'],
      { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const runJson = (r.stdout ?? '').trim();
    if (runJson === '' || runJson === '[]') {
      process.stderr.write(
        `❌ No release-gate run found for tag ${tag}.\n` +
          '   Tag runs auto-fire on push — wait for GitHub to register it, or\n' +
          `   confirm the tag was pushed: git -C ${repoDir} ls-remote --tags origin refs/tags/${tag}\n`,
      );
      return 2;
    }

    const run = latestRun(runJson);
    const status = field(run, 'status');
    const conclusion = field(run, 'conclusion');
    const runUrl = field(run, 'url');

    if (status === 'completed') {
      if (conclusion === 'success') {
        process.stdout.write(`✓ release-gate for ${tag} concluded success.\n  Run: ${runUrl}\n`);
        return 0;
      }
      process.stderr.write(
        `❌ release-gate for ${tag} concluded ${conclusion || 'unknown'} — refusing to publish.\n` +
          `   Run: ${runUrl}\n` +
          '   A red tag gate means: roll back the channel/tag and ship a new rc\n' +
          '   (never publish over a failing gate). Investigate the run above.\n',
      );
      return 3;
    }

    if (WAITING.has(status)) {
      if (waited >= timeout) {
        process.stderr.write(
          `❌ release-gate for ${tag} still ${status} after ${timeout}s — timed out.\n` +
            `   Run: ${runUrl}\n` +
            '   Inconclusive is not green — do NOT publish. Re-run this check once\n' +
            '   the run concludes (raise the budget with TMB_GATE_TIMEOUT=<seconds>).\n',
        );
        return 4;
      }
      process.stdout.write(`… waiting on release-gate for ${tag} (status=${status}, ${waited}s/${timeout}s)\n  Run: ${runUrl}\n`);
    } else {
      if (waited >= timeout) {
        process.stderr.write(
          `❌ release-gate for ${tag}: unexpected status '${status || 'empty'}' after ${timeout}s — timed out.\n` +
            `   Run: ${runUrl}\n` +
            '   Inconclusive is not green — do NOT publish. Re-run this check.\n',
        );
        return 4;
      }
      process.stdout.write(`… release-gate for ${tag} reported status '${status || 'empty'}'; re-checking (${waited}s/${timeout}s)\n`);
    }
    await sleep(POLL_INTERVAL_S * 1000);
    waited += POLL_INTERVAL_S;
  }
}
