/**
 * `cli.js feature-branch` (GH 2225): bro cuts and syncs an agile milestone
 * feature branch with one command each.
 *
 *   node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" feature-branch cut <name> [--repo <repo>]
 *   node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" feature-branch sync <name> [--repo <repo>]
 *
 * The repo is --repo, else the registered repo cwd is in, else the sole
 * registered repo. Its target is repos.target_branch, else the remote
 * default; with an origin remote that target is fetched once (bounded, as
 * `cli.js integrate` fetches) and origin/<target> is the base, else the local
 * <target> is. <name> must pass `git check-ref-format --branch` and be neither
 * the target nor one of repos.protected_branches.
 *
 * cut creates refs/heads/<name> at the base; a ref already there is refused.
 * sync merges the base into <name> with a merge commit made in a temporary
 * detached worktree, then moves <name> with an update-ref guarded on its old
 * tip, so every prior feature commit stays reachable; a <name> the base is
 * already under is left as is. A <name> checked out in any worktree is
 * refused, as `cli.js feature-merge` refuses it; a conflict aborts the merge
 * and lists the conflicting paths.
 *
 * Neither subcommand pushes or writes the DB: bro pushes the branch through
 * the guarded `git push`. stdout carries only the SHA the branch is at;
 * progress and failures go to stderr. The temporary worktree is removed on
 * every exit.
 * Exit 0 = done, 2 = merge conflict (branch unchanged),
 * 4 = usage error or a precondition not met (no ref created or moved).
 */
import { dbPath } from '../hooks/lib/db.js';
import { shellPwd } from '../hooks/lib/project-env.js';
import { repoGitRoot, repoNameForRoot } from '../hooks/lib/repo.js';
import type { CliIo } from './fallback-db.js';
import { runTaskRebase, TaskRebase } from './integrate.js';

const USAGE = 'usage: cli.js feature-branch <cut|sync> <name> [--repo <repo>]';

interface Args {
  action: string;
  name: string;
  repo: string;
}

class FeatureBranch extends TaskRebase {
  private baseRef = '';

  constructor(env: NodeJS.ProcessEnv, io: CliIo) {
    super(env, io, 'feature-branch');
  }

  private parseArgs(argv: readonly string[]): Args {
    const positional: string[] = [];
    let repo = '';
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === '--repo') {
        repo = argv[i + 1] ?? '';
        if (repo === '') this.die(4, USAGE);
        i += 1;
      } else {
        positional.push(argv[i]);
      }
    }
    const [action = '', name = ''] = positional;
    if (positional.length !== 2 || (action !== 'cut' && action !== 'sync')) this.die(4, USAGE);
    return { action, name, repo };
  }

  /** Exit 4 unless <name> is a valid branch name as written; `--branch` would expand `@{-1}` to another branch. */
  private checkName(name: string): void {
    const r = this.git(this.repoRoot, ['check-ref-format', '--branch', name]);
    if (!r.ok || r.out !== name) this.die(4, `'${name}' is not a valid branch name`);
  }

  /** Fetches <target> once when origin exists and sets baseRef to origin/<target>, else the local <target>; returns its sha. */
  private resolveBaseSha(target: string): string {
    if (this.g(['remote', 'get-url', 'origin']).ok) {
      this.fetchBase('origin', target);
      this.baseRef = `origin/${target}`;
    } else {
      this.baseRef = target;
    }
    const sha = this.revParse(this.repoRoot, `${this.baseRef}^{commit}`);
    if (sha === '') this.die(4, `${this.baseRef} does not resolve in ${this.repoRoot}`);
    return sha;
  }

  private cut(name: string, baseSha: string): number {
    const created = this.git(this.repoRoot, ['update-ref', '-m', `cli.js feature-branch: cut ${name} at ${this.baseRef}`, `refs/heads/${name}`, baseSha, '']);
    if (!created.ok) this.die(4, `git update-ref of refs/heads/${name} failed; no branch created: ${created.err.trim()}`);
    this.say(`${name} -> ${baseSha} (cut at ${this.baseRef})`);
    this.io.out(`${baseSha}\n`);
    return 0;
  }

  private sync(name: string, baseSha: string): number {
    const ref = `refs/heads/${name}`;
    const tip = this.revParse(this.repoRoot, `${ref}^{commit}`);
    if (this.g(['merge-base', '--is-ancestor', baseSha, tip]).ok) {
      this.say(`${name} already contains ${this.baseRef} (${baseSha})`);
      this.io.out(`${tip}\n`);
      return 0;
    }

    this.openTempWorktree(name.replaceAll('/', '-'), tip);
    this.say(`merging ${this.baseRef} (${baseSha}) into ${name} (${tip}) in ${this.wt}`);
    const message = `Merge ${this.baseRef} into ${name}`;
    if (!this.gitLoud(this.wt, ['merge', '--no-ff', '--no-edit', '-m', message, baseSha], { ...this.env, GIT_EDITOR: 'true' })) {
      const conflicted = this.git(this.wt, ['diff', '--name-only', '--diff-filter=U']).out;
      this.git(this.wt, ['merge', '--abort']);
      if (conflicted === '') this.die(4, `merging ${this.baseRef} into ${name} failed; ${name} is unchanged`);
      this.die(2, `merging ${this.baseRef} into ${name} conflicted; aborted, ${name} is unchanged. Conflicting paths:\n${conflicted}`);
    }
    const merged = this.revParse(this.wt, 'HEAD');
    if (merged === '') this.die(4, 'cannot read the merge commit');

    const holder = this.branchHolder(name);
    if (holder !== '') this.die(4, `${name} is now checked out at ${holder}; the merge commit is ${merged}, ${name} is unchanged`);
    const moved = this.git(this.repoRoot, ['update-ref', '-m', `cli.js feature-branch: sync ${name} with ${this.baseRef}`, ref, merged, tip]);
    if (!moved.ok) this.die(4, `${name} moved during the sync, or update-ref failed; left as is, the merge commit is ${merged}: ${moved.err.trim()}`);
    this.say(`${name} -> ${merged} (merged ${this.baseRef})`);
    this.io.out(`${merged}\n`);
    return 0;
  }

  async run(argv: readonly string[]): Promise<number> {
    const { action, name, repo } = this.parseArgs(argv);
    const db = dbPath(this.env);
    if (db === null) this.die(4, 'no trajectory DB resolved (set TRAJECTORY_DB_PATH or CLAUDE_PROJECT_DIR)');
    this.db = db;
    const cwdRoot = repo === '' ? await repoGitRoot(shellPwd(this.env), this.env) : '';
    await this.resolveRepo(repo || (cwdRoot === '' ? '' : repoNameForRoot(db, cwdRoot, this.env)));

    this.checkName(name);
    this.branch = name;
    const target = await this.sharedBaseTarget(name, 'feature branch');
    this.base = target;
    const exists = this.hasRef(`refs/heads/${name}`);
    if (action === 'cut' && exists) this.die(4, `branch '${name}' already exists in ${this.repoRoot}`);
    if (action === 'sync') {
      if (!exists) this.die(4, `feature branch '${name}' does not exist in ${this.repoRoot}`);
      const holder = this.branchHolder(name);
      if (holder !== '') this.die(4, `feature branch '${name}' is checked out at ${holder}; switch that worktree off it and run cli.js feature-branch sync again`);
    }
    const baseSha = this.resolveBaseSha(target);
    return action === 'cut' ? this.cut(name, baseSha) : this.sync(name, baseSha);
  }
}

export async function featureBranch(argv: readonly string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  return runTaskRebase(new FeatureBranch(env, io), argv);
}
