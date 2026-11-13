/**
 * Build attribution for change impact (GH 2600): which first-parent commit of
 * a repo's base branch a sample's build was cut from.
 *
 * - `X.Y.Z-dev.<n>.gh<P>` is the build of PR P's squash commit.
 * - A stable or rc `X.Y.Z[-rc.K]` is the merge-base of the base and tag `v<version>`.
 * - A NULL version is estimated: the newest base commit at or before the sample.
 * - Any other version is unattributed.
 */
import { execFileSync } from 'node:child_process';
export const PR_SUBJECT = /\(#(\d+)\)\s*$/;
export const DEV_VERSION = /^\d+\.\d+\.\d+-dev\.\d+\.gh(\d+)$/;
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/;
export class BuildHistory {
    git;
    commits;
    times;
    shaIndex = new Map();
    prIndex = new Map();
    tagIndex = new Map();
    constructor(git) {
        this.git = git;
        this.commits = git.commits();
        this.times = this.commits.map((c) => Date.parse(c.at));
        this.commits.forEach((c, i) => {
            this.shaIndex.set(c.sha, i);
            const m = PR_SUBJECT.exec(c.subject);
            if (m)
                this.prIndex.set(Number(m[1]), i);
        });
    }
    get target() {
        return this.git.target;
    }
    indexOfPr(pr) {
        return this.prIndex.get(pr);
    }
    /** Every PR on the target with its first-parent index, oldest first. */
    prs() {
        return [...this.prIndex.entries()].map(([pr, idx]) => ({ pr, idx })).sort((a, b) => a.idx - b.idx);
    }
    attribute(version, at) {
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
    tagIdx(tag) {
        if (!this.tagIndex.has(tag)) {
            const sha = this.git.mergeBase(tag);
            this.tagIndex.set(tag, sha === null ? null : this.shaIndex.get(sha) ?? null);
        }
        return this.tagIndex.get(tag) ?? null;
    }
    newestAtOrBefore(t) {
        if (Number.isNaN(t))
            return null;
        let found = null;
        for (let i = 0; i < this.times.length; i++) {
            if (this.times[i] <= t)
                found = i;
        }
        return found;
    }
}
export const defaultGit = (path, args) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
function succeeds(git, path, args) {
    try {
        git(path, args);
        return true;
    }
    catch {
        return false;
    }
}
function refExists(git, path, ref) {
    return succeeds(git, path, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
}
export function hasOriginRemote(git, path) {
    return succeeds(git, path, ['remote', 'get-url', 'origin']);
}
/**
 * A repo's base branch: `origin/<targetBranch>` when it resolves, else
 * <targetBranch>; with neither, the target of `origin/HEAD`, else `HEAD`.
 */
export function baseRef(git, path, targetBranch) {
    if (targetBranch) {
        if (refExists(git, path, `origin/${targetBranch}`))
            return `origin/${targetBranch}`;
        if (refExists(git, path, targetBranch))
            return targetBranch;
    }
    try {
        const head = git(path, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).trim();
        if (head)
            return head.replace(/^refs\/remotes\//, '');
    }
    catch {
        // No origin/HEAD: fall back to the checkout's HEAD.
    }
    return 'HEAD';
}
/** A git source over the first-parent history of <target> in the repo at <path>. */
export function gitSourceFor(git, path, target) {
    return {
        target,
        commits() {
            return git(path, ['log', '--first-parent', target, '--format=%H%x09%cI%x09%s'])
                .split('\n')
                .filter((l) => l.length > 0)
                .map((l) => {
                const [sha, at, ...rest] = l.split('\t');
                return { sha: sha, at: at, subject: rest.join('\t') };
            })
                .reverse();
        },
        mergeBase(ref) {
            try {
                return git(path, ['merge-base', target, ref]).trim() || null;
            }
            catch {
                return null;
            }
        },
    };
}
//# sourceMappingURL=attribution.js.map