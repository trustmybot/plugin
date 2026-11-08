/**
 * Build attribution for change impact (GH 2600): which first-parent commit of
 * the target branch a sample's plugin build was cut from.
 *
 * - `X.Y.Z-dev.<n>.gh<P>` is the build of PR P's squash commit.
 * - A stable or rc `X.Y.Z[-rc.K]` is the merge-base of the target and tag `v<version>`.
 * - A NULL version is estimated: the newest target commit at or before the sample.
 * - Any other version is unattributed.
 */
import { execFileSync } from 'node:child_process';
import type { StatsReader } from '../tools/stats.js';

export interface GitCommit {
  sha: string;
  at: string;
  subject: string;
}

export interface GitSource {
  target: string;
  /** First-parent commits of the target, oldest first. */
  commits(): GitCommit[];
  /** The merge-base of the target and <ref>, or null when there is none. */
  mergeBase(ref: string): string | null;
}

export class GitUnavailableError extends Error {
  constructor(reason: string) {
    super(`plugin git history not available: ${reason}`);
    this.name = 'GitUnavailableError';
  }
}

const PR_SUBJECT = /\(#(\d+)\)\s*$/;
const DEV_VERSION = /^\d+\.\d+\.\d+-dev\.\d+\.gh(\d+)$/;
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/;

export interface Attribution {
  idx: number;
  estimated: boolean;
}

export class BuildHistory {
  readonly commits: GitCommit[];
  private readonly times: number[];
  private readonly shaIndex = new Map<string, number>();
  private readonly prIndex = new Map<number, number>();
  private readonly tagIndex = new Map<string, number | null>();

  constructor(private readonly git: GitSource) {
    this.commits = git.commits();
    this.times = this.commits.map((c) => Date.parse(c.at));
    this.commits.forEach((c, i) => {
      this.shaIndex.set(c.sha, i);
      const m = PR_SUBJECT.exec(c.subject);
      if (m) this.prIndex.set(Number(m[1]), i);
    });
  }

  get target(): string {
    return this.git.target;
  }

  indexOfPr(pr: number): number | undefined {
    return this.prIndex.get(pr);
  }

  /** Every PR on the target with its first-parent index, oldest first. */
  prs(): { pr: number; idx: number }[] {
    return [...this.prIndex.entries()].map(([pr, idx]) => ({ pr, idx })).sort((a, b) => a.idx - b.idx);
  }

  attribute(version: string | null, at: string): Attribution | null {
    if (version === null) {
      const idx = this.newestAtOrBefore(Date.parse(at));
      return idx === null ? null : { idx, estimated: true };
    }
    const dev = DEV_VERSION.exec(version);
    if (dev) {
      const idx = this.prIndex.get(Number(dev[1]));
      return idx === undefined ? null : { idx, estimated: false };
    }
    if (RELEASE_VERSION.test(version)) {
      const idx = this.tagIdx(`v${version}`);
      return idx === null ? null : { idx, estimated: false };
    }
    return null;
  }

  private tagIdx(tag: string): number | null {
    if (!this.tagIndex.has(tag)) {
      const sha = this.git.mergeBase(tag);
      this.tagIndex.set(tag, sha === null ? null : this.shaIndex.get(sha) ?? null);
    }
    return this.tagIndex.get(tag) ?? null;
  }

  private newestAtOrBefore(t: number): number | null {
    if (Number.isNaN(t)) return null;
    let found: number | null = null;
    for (let i = 0; i < this.times.length; i++) {
      if (this.times[i]! <= t) found = i;
    }
    return found;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function refExists(cwd: string, ref: string): boolean {
  try {
    git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** A git source over the repo at <path>: `origin/<branch>` when it resolves, else <branch>. */
export function gitSourceAt(path: string, branch = 'dev'): GitSource {
  const target = refExists(path, `origin/${branch}`) ? `origin/${branch}` : branch;
  if (!refExists(path, target)) throw new GitUnavailableError(`no ref ${target} in ${path}`);
  return {
    target,
    commits() {
      let out: string;
      try {
        out = git(path, ['log', '--first-parent', target, '--format=%H%x09%cI%x09%s']);
      } catch (e) {
        throw new GitUnavailableError((e as Error).message.split('\n')[0] ?? 'git log failed');
      }
      return out
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => {
          const [sha, at, ...rest] = l.split('\t');
          return { sha: sha!, at: at!, subject: rest.join('\t') };
        })
        .reverse();
    },
    mergeBase(ref) {
      try {
        return git(path, ['merge-base', target, ref]).trim() || null;
      } catch {
        return null;
      }
    },
  };
}

/** The default git source: the `plugin` repo row (else the sole repo), its target branch, else `dev`; <pathOverride> replaces the row's path. */
export function defaultGitSource(reader: StatsReader, pathOverride?: string): GitSource {
  const rows = reader.all<{ name: string; path: string; target_branch: string | null }>(
    'SELECT name, path, target_branch FROM repos ORDER BY name',
  );
  const row = rows.find((r) => r.name === 'plugin') ?? (rows.length === 1 ? rows[0] : undefined);
  const path = pathOverride ?? row?.path;
  if (!path) throw new GitUnavailableError(rows.length === 0 ? 'no repos row' : 'no plugin repo row');
  try {
    return gitSourceAt(path, row?.target_branch || 'dev');
  } catch (e) {
    if (e instanceof GitUnavailableError) throw e;
    throw new GitUnavailableError((e as Error).message.split('\n')[0] ?? 'git failed');
  }
}
