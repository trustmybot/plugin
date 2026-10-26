// Waits until release-payload.yml has pushed payload/<tag> (the tag's
// runtime-only build) to the plugin remote, then prints the payload commit SHA.
// Run by publish-rc-channel.sh before it pins a catalog to payload/<tag>.
//
//   node --experimental-strip-types scripts/await-payload-tag.ts <tag> [--remote <url>] [--timeout <s>] [--interval <s>]
//
// Exit codes: 0 found (SHA on stdout), 4 timed out, 1 usage error or bad tag.
// Timeout precedence: --timeout, else env TMB_PAYLOAD_TIMEOUT, else 600 s.

import { spawnSync } from 'node:child_process';

const DEFAULT_REMOTE = 'https://github.com/trustmybot/plugin.git';
const DEFAULT_TIMEOUT_S = 600;
const DEFAULT_INTERVAL_S = 10;
const TAG_RE = /^v\d+\.\d+\.\d+(-rc\.\d+)?$/;
const USAGE = 'usage: await-payload-tag.ts <tag> [--remote <url>] [--timeout <s>] [--interval <s>]\n';

interface Options {
  tag: string;
  remote: string;
  timeoutS: number;
  intervalS: number;
}

function usageError(message: string): never {
  process.stderr.write(`await-payload-tag: ${message}\n${USAGE}`);
  process.exit(1);
}

function seconds(name: string, value: string | undefined, min: number): number {
  if (value === undefined || !/^\d+$/.test(value) || Number(value) < min) {
    usageError(`${name} must be an integer of at least ${min} seconds, got ${JSON.stringify(value ?? '')}`);
  }
  return Number(value);
}

function parseArgs(argv: string[]): Options {
  let tag: string | undefined;
  let remote = DEFAULT_REMOTE;
  let timeoutArg: string | undefined;
  let intervalArg: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--remote' || a === '--timeout' || a === '--interval') {
      const value = argv[++i];
      if (value === undefined) usageError(`${a} needs a value`);
      if (a === '--remote') remote = value;
      else if (a === '--timeout') timeoutArg = value;
      else intervalArg = value;
    } else if (a !== undefined && a.startsWith('-')) {
      usageError(`unknown flag ${a}`);
    } else if (tag === undefined) {
      tag = a;
    } else {
      usageError(`unexpected argument ${a}`);
    }
  }
  if (tag === undefined) usageError('missing <tag>');
  if (!TAG_RE.test(tag)) usageError(`tag ${JSON.stringify(tag)} is not vX.Y.Z or vX.Y.Z-rc.N`);
  if (remote === '') usageError('--remote must not be empty');

  const envTimeout = process.env.TMB_PAYLOAD_TIMEOUT;
  const timeoutS =
    timeoutArg !== undefined
      ? seconds('--timeout', timeoutArg, 0)
      : envTimeout !== undefined && envTimeout !== ''
        ? seconds('TMB_PAYLOAD_TIMEOUT', envTimeout, 0)
        : DEFAULT_TIMEOUT_S;
  const intervalS = intervalArg !== undefined ? seconds('--interval', intervalArg, 1) : DEFAULT_INTERVAL_S;
  return { tag, remote, timeoutS, intervalS };
}

type Lookup = { sha: string } | { missing: true } | { error: string };

function lookup(remote: string, ref: string): Lookup {
  const r = spawnSync('git', ['ls-remote', '--tags', remote, ref, `${ref}^{}`], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.status !== 0) return { error: (r.stderr || r.error?.message || `git exited ${r.status}`).trim() };
  let direct: string | undefined;
  let peeled: string | undefined;
  for (const line of r.stdout.split('\n')) {
    const [sha, name] = line.split('\t');
    if (sha === undefined || name === undefined) continue;
    if (name === ref) direct = sha;
    else if (name === `${ref}^{}`) peeled = sha;
  }
  const sha = peeled ?? direct;
  return sha === undefined ? { missing: true } : { sha };
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function main(): Promise<void> {
  const { tag, remote, timeoutS, intervalS } = parseArgs(process.argv.slice(2));
  const ref = `refs/tags/payload/${tag}`;
  const deadline = Date.now() + timeoutS * 1000;

  for (let attempt = 1; ; attempt++) {
    process.stderr.write(`await-payload-tag: waiting for ${ref} on ${remote} (poll ${attempt}, timeout ${timeoutS}s)\n`);
    const found = lookup(remote, ref);
    if ('sha' in found) {
      process.stderr.write(`await-payload-tag: payload/${tag} is on the remote at ${found.sha}\n`);
      process.stdout.write(`${found.sha}\n`);
      return;
    }
    if ('error' in found) process.stderr.write(`await-payload-tag: git ls-remote failed: ${found.error}\n`);

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      process.stderr.write(
        `❌ await-payload-tag: payload/${tag} is still not on ${remote} after ${timeoutS}s.\n` +
          `   The release-payload workflow run for ${tag} builds it. Re-run that run, then this command:\n` +
          `     gh run list --repo trustmybot/plugin --workflow release-payload.yml --branch ${tag}\n` +
          `     gh run rerun <run-id> --repo trustmybot/plugin\n`,
      );
      process.exit(4);
    }
    await sleep(Math.min(intervalS * 1000, remaining));
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`await-payload-tag: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
