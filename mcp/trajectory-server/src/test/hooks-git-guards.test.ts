/**
 * The TypeScript git-guards where it is stricter than the bash git-guards.sh
 * (GH 1692): a command naming git, gh or glab that tree-sitter-bash cannot
 * parse is denied with PARSE_REASON, a git word after a non-ASCII letter is
 * analysed (the .sh skips it in a UTF-8 locale), the switch-then-fast-forward
 * sync needs an ASCII-only command, and the DB is read through
 * node:sqlite with no sqlite3 CLI on PATH. Plus the registry wiring.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { forgeRecovery, gitGuards, needsGitGuard, PARSE_FIX, PARSE_REASON as PARSE_TEXT, primaryRemoteUrl } from '../hooks/git-guards.js';
import { fixedReason } from '../hooks/lib/deny.js';
import { forgeSpecMatchesRemote } from '../hooks/lib/repo.js';
import { findGate, gateNames } from '../hooks/registry.js';

const PARSE_REASON = fixedReason(PARSE_TEXT, PARSE_FIX);

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(dir: string, ...args: string[]): void {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

function payload(command: string, cwd: string): string {
  return JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } });
}

function reason(stdout: string): string {
  if (stdout === '') return '';
  const out = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

describe('git-guards: the TypeScript gate', () => {
  let dir: string;
  let main: string;
  let sibling: string;
  let db: string;
  let gitOnly: string;
  let env: NodeJS.ProcessEnv;
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gg-')));
    main = join(dir, 'main');
    sibling = join(dir, 'sibling');
    for (const repo of [main, sibling]) {
      mkdirSync(repo);
      git(repo, 'init', '-q', '-b', 'main');
      writeFileSync(join(repo, 'README.md'), 'x\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'init');
    }
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', join(dir, 'origin.git')], { env: GIT_ENV });
    git(main, 'remote', 'add', 'origin', join(dir, 'origin.git'));
    git(main, 'push', '-q', '-u', 'origin', 'main');
    git(main, 'switch', '-q', '-c', 'feat/x');
    git(main, 'push', '-q', '-u', 'origin', 'feat/x');
    git(main, 'switch', '-q', 'main');
    db = join(dir, 'trajectory.db');
    const d = new DatabaseSync(db);
    d.exec(SCHEMA);
    d.prepare("INSERT INTO repos (name, path, target_branch, branching_model, protected_branches) VALUES ('main', ?, 'main', 'github-flow', '[\"main\"]')").run(main);
    d.close();
    gitOnly = join(dir, 'bin');
    mkdirSync(gitOnly);
    const which = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    symlinkSync(which, join(gitOnly, 'git'));
    env = { ...GIT_ENV, CLAUDE_PROJECT_DIR: dir, TRAJECTORY_DB_PATH: db };
    delete env.TMB_HOOKS_SQLITE;
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is registered, so the build lists it in dist/hooks-gates.txt', () => {
    assert.equal(findGate('git-guards'), gitGuards);
    assert.ok(gateNames().includes('git-guards'));
  });

  it('denies an unparseable command naming git with the parse reason (the .sh judges its awk skeleton)', async () => {
    const r = await gitGuards(payload(`cat <<E"M"\nx\nEM\ngit -C ${sibling} commit -m x`, dir), env);
    assert.equal(r.code, 0);
    assert.equal(reason(r.stdout), PARSE_REASON);
  });

  it('denies the same shape inside bash -c', async () => {
    const r = await gitGuards(payload(`bash -c 'cat <<E"M"\nx\nEM\ngh pr create --base main'`, dir), env);
    assert.equal(reason(r.stdout), PARSE_REASON);
  });

  it('allows an unparseable command that names no git, gh or glab word, before any parse', async () => {
    const r = await gitGuards(payload('cat <<E"M"\nx\nEM\nls', dir), env);
    assert.deepEqual(r, { stdout: '', code: 0 });
  });

  it('a well-terminated heredoc before a commit on a protected branch gets the rule deny, not the parse deny', async () => {
    const r = await gitGuards(payload(`cat <<EOF\nx\nEOF\ngit -C ${main} commit -m x`, dir), env);
    assert.match(reason(r.stdout), /^BLOCKED: main is a shared workflow base/);
  });

  it('applies the PR-target rule to every PR-create spelling, reading the base from --base, -B or a base= field (GH 2225)', async () => {
    for (const command of [
      'gh pr create --base dev --head feat/x',
      'gh pr new -B dev',
      'gh pr create',
      'gh api repos/o/r/pulls -f head=feat/x -f base=dev',
      'gh api --method POST /repos/o/r/pulls --input body.json',
      `gh api graphql -f query='mutation { createPullRequest(input: {baseRefName: "dev", headRefName: "feat/x"}) { pullRequest { id } } }'`,
      'glab mr new --target-branch dev --source-branch feat/x',
    ]) {
      assert.match(reason((await gitGuards(payload(command, main), env)).stdout), /^BLOCKED: (PR|MR)s must target main branch in repo main\./, command);
    }
    for (const command of [
      // o/r names no registered repo's origin, so these get no verdict (GH 3278).
      'gh -R o/r pr create --base dev --head feat/x',
      'gh --repo=o/r pr create',
      'glab -R o/r mr new --target-branch dev --source-branch feat/x',
      'gh -R o/r pr create --base main --head feat/x',
      'gh pr new -B main',
      'gh api repos/o/r/pulls -f head=feat/x -f base=main',
      `gh api graphql -f query='mutation { createPullRequest(input: {baseRefName: "main", headRefName: "feat/x"}) { pullRequest { id } } }'`,
      'glab --repo o/r mr new -b main -s feat/x',
      'gh pr view 3',
      'gh -R o/r pr list',
      'gh api repos/o/r/pulls',
      'gh api -X GET repos/o/r/pulls -f state=open',
      'gh api repos/o/r/pulls/3 -X PATCH -f base=dev',
      'gh api graphql -f query=\'{ viewer { login } }\'',
    ]) {
      assert.deepEqual(await gitGuards(payload(command, main), env), { stdout: '', code: 0 }, command);
    }
  });

  for (const command of ["git -C '' commit -m x", 'git -C "" commit -m x'])
    it(`${command} on a protected branch gets the deny git commit -m x gets (GH 2549)`, async () => {
      const bare = await gitGuards(payload('git commit -m x', main), env);
      assert.match(reason(bare.stdout), /^BLOCKED: main is a shared workflow base/);
      assert.deepEqual(await gitGuards(payload(command, main), env), bare);
    });

  it('analyses a git word after a non-ASCII letter, as the .sh does only in the C locale', () => {
    assert.equal(needsGitGuard('égit commit'), true);
    assert.equal(needsGitGuard('é git commit'), true);
    assert.equal(needsGitGuard('legit commit'), false);
    assert.equal(needsGitGuard('cat .git/config'), false);
    assert.equal(needsGitGuard('/usr/bin/git commit'), true);
    assert.equal(needsGitGuard('echo x\ngh pr create'), true);
    const sh = (locale: string) =>
      spawnSync('sh', ['-c', `printf '%s' "$1" | grep -E '(^|[^[:alnum:]_./-])(git|gh|glab)([[:space:]]|$)' >/dev/null`, '_', 'égit commit'], {
        env: { ...process.env, LC_ALL: locale },
      }).status;
    assert.equal(sh('C'), 0, 'the C locale reads é as two non-alnum bytes');
  });

  it('allows switch-then-fast-forward only in an ASCII-only command, in any locale', async () => {
    const sync = `cd ${main} && git switch feat/x && git merge --ff-only @{u}`;
    assert.deepEqual(await gitGuards(payload(sync, dir), env), { stdout: '', code: 0 });
    const quoted = `echo "é" && ${sync}`;
    const r = await gitGuards(payload(quoted, dir), env);
    assert.match(reason(r.stdout), /Syncing a branch with its own upstream/);
    const utf8 = await gitGuards(payload(quoted, dir), { ...env, LC_ALL: 'en_US.UTF-8' });
    assert.deepEqual(utf8, r, 'the locale picks no other answer');
  });

  it('reads the DB through node:sqlite with no sqlite3 CLI on PATH: an unregistered sibling stays unguarded', async () => {
    const r = await gitGuards(payload('git commit -m x', sibling), { ...env, PATH: gitOnly });
    assert.deepEqual(r, { stdout: '', code: 0 });
  });
});

describe('git-guards: the Rule 2 recovery names the forge of the remote (GH 2713)', () => {
  const remotes = (url: string, name = 'origin'): string => `${name}\t${url} (fetch)\n${name}\t${url} (push)\n`;

  it('primaryRemoteUrl reads origin, else the first remote', () => {
    assert.equal(primaryRemoteUrl(`${remotes('git@gitlab.com:a/b.git', 'up')}${remotes('git@github.com:a/b.git')}`), 'git@github.com:a/b.git');
    assert.equal(primaryRemoteUrl(remotes('https://gitlab.com/a/b.git', 'up')), 'https://gitlab.com/a/b.git');
    assert.equal(primaryRemoteUrl(''), '');
  });

  it('a GitLab remote, gitlab.com or self-hosted, gets glab mr create', () => {
    for (const url of ['git@gitlab.com:a/b.git', 'https://gitlab.example.com/a/b.git']) {
      assert.deepEqual(forgeRecovery(remotes(url), 'dev'), {
        text: ' Push your feature branch and open an MR into dev.',
        fix: { allowed: 'git push origin <branch> && glab mr create --target-branch dev --source-branch <branch>' },
      });
    }
  });

  it('a GitHub remote, or no URL, gets gh pr create', () => {
    for (const r of [remotes('git@github.com:a/b.git'), '']) {
      assert.deepEqual(forgeRecovery(r, 'main'), {
        text: ' Push your feature branch and open a PR into main.',
        fix: { allowed: 'git push origin <branch> && gh pr create --base main --head <branch>' },
      });
    }
  });
});

describe('git-guards: a PR/MR create naming -R/--repo is judged by that repo policy (GH 3278)', () => {
  let dir: string;
  let alpha: string;
  let beta: string;
  let outside: string;
  let env: NodeJS.ProcessEnv;
  const ALLOW_RESULT = { stdout: '', code: 0 };
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gg-repo-')));
    alpha = join(dir, 'alpha');
    beta = join(dir, 'beta');
    const aardvark = join(dir, 'aardvark');
    outside = join(dir, 'outside');
    mkdirSync(outside);
    for (const [repo, origin] of [
      [alpha, 'https://github.com/acme/alpha.git'],
      [beta, 'https://github.com/acme/beta.git'],
      [aardvark, 'git@github.com:acme/beta.git'],
    ]) {
      mkdirSync(repo);
      git(repo, 'init', '-q', '-b', 'main');
      writeFileSync(join(repo, 'README.md'), 'x\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'init');
      git(repo, 'remote', 'add', 'origin', origin);
    }
    const db = join(dir, 'trajectory.db');
    const d = new DatabaseSync(db);
    d.exec(SCHEMA);
    const row = d.prepare("INSERT INTO repos (name, path, target_branch, branching_model, protected_branches) VALUES (?, ?, ?, 'github-flow', '[\"main\"]')");
    row.run('alpha', alpha, 'develop');
    row.run('beta', beta, 'main');
    // A second registered checkout of acme/beta, first by name, with its own target.
    row.run('aardvark', aardvark, 'release');
    d.close();
    env = { ...GIT_ENV, CLAUDE_PROJECT_DIR: dir, TRAJECTORY_DB_PATH: db };
    delete env.TMB_HOOKS_SQLITE;
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const judge = async (command: string, cwd: string, e: NodeJS.ProcessEnv = env) => await gitGuards(payload(command, cwd), e);

  it("gh pr create --repo A from inside repo B: A's target is allowed, B's is denied naming A", async () => {
    for (const spec of ['acme/alpha', 'github.com/acme/alpha', 'https://github.com/ACME/alpha.git', 'git@github.com:acme/alpha.git']) {
      for (const flag of [`--repo ${spec}`, `--repo=${spec}`, `-R ${spec}`]) {
        assert.deepEqual(await judge(`gh pr create ${flag} --base develop --head feat/x`, beta), ALLOW_RESULT, flag);
        const r = reason((await judge(`gh pr create ${flag} --base main --head feat/x`, beta)).stdout);
        assert.match(r, /^BLOCKED: PRs must target develop branch in repo alpha\./, flag);
        assert.ok(r.endsWith(`Allowed form: gh pr create --repo ${spec} --base develop --head <branch>`), `${flag}: ${r}`);
      }
    }
    assert.deepEqual(await judge('gh -R acme/alpha pr create --base develop --head feat/x', beta), ALLOW_RESULT);
  });

  it("glab mr create -R/--repo A from inside repo B: A's target is allowed, B's is denied naming A", async () => {
    for (const flag of ['-R acme/alpha', '--repo acme/alpha', '--repo=acme/alpha', '-Racme/alpha']) {
      assert.deepEqual(await judge(`glab mr create ${flag} --target-branch develop --source-branch feat/x`, beta), ALLOW_RESULT, flag);
      assert.match(
        reason((await judge(`glab mr create ${flag} --target-branch main --source-branch feat/x`, beta)).stdout),
        /^BLOCKED: MRs must target develop branch in repo alpha\..* Allowed form: glab mr create --repo acme\/alpha --target-branch develop --source-branch <branch>$/,
        flag,
      );
    }
  });

  it('a --repo that names no registered repo gets no verdict, inside a registered repo or outside any', async () => {
    for (const cwd of [beta, outside]) {
      for (const command of [
        'gh pr create --repo acme/unknown --base anything --head feat/x',
        'gh pr create --repo gitlab.com/acme/alpha --base main --head feat/x',
        'glab mr create -R acme/unknown --target-branch anything',
      ]) {
        assert.deepEqual(await judge(command, cwd), ALLOW_RESULT, `${command} in ${cwd}`);
      }
    }
  });

  it('a --repo value the shell fills in keeps the cwd repo policy, as a create with no --repo does', async () => {
    for (const flag of [
      '--repo "$R"',
      '--repo=${R}',
      '-R "$(gh repo view --json nameWithOwner -q .nameWithOwner)"',
      '--repo "acme/$NAME"',
      '--repo="`echo acme/alpha`"',
    ]) {
      for (const prefix of ['', 'R=acme/alpha; ', 'R=acme/alpha ', 'export R=acme/alpha && ']) {
        const command = `${prefix}gh pr create ${flag} --base develop --head feat/x`;
        assert.match(reason((await judge(command, beta)).stdout), /^BLOCKED: PRs must target main branch in repo beta\./, command);
        assert.deepEqual(await judge(`${prefix}gh pr create ${flag} --base main --head feat/x`, beta), ALLOW_RESULT, command);
      }
      assert.match(
        reason((await judge(`glab mr create ${flag} --target-branch develop`, beta)).stdout),
        /^BLOCKED: MRs must target main branch in repo beta\./,
        flag,
      );
      // Outside any repo there is no cwd policy to fall back to, so no verdict, as before GH 3278.
      assert.deepEqual(await judge(`gh pr create ${flag} --base anything --head feat/x`, outside), ALLOW_RESULT, flag);
    }
    // An unquoted backtick cuts the statement in the listing; the create is still judged by the cwd repo.
    assert.match(reason((await judge('gh pr create --repo=`echo acme/alpha` --base develop --head feat/x', beta)).stdout), /^BLOCKED: PRs must target main branch in repo beta\./);
  });

  it('a create with no --repo outside any repo gets no verdict; inside one, the cwd repo policy applies and is named', async () => {
    assert.deepEqual(await judge('gh pr create --base anything --head feat/x', outside), ALLOW_RESULT);
    assert.deepEqual(await judge('gh pr create --base main --head feat/x', beta), ALLOW_RESULT);
    assert.match(reason((await judge('gh pr create --base develop --head feat/x', beta)).stdout), /^BLOCKED: PRs must target main branch in repo beta\..* Allowed form: gh pr create --base main --head <branch>$/);
    assert.match(reason((await judge('glab mr create --target-branch main', alpha)).stdout), /^BLOCKED: MRs must target develop branch in repo alpha\./);
  });

  it('a --repo from outside any repo is judged by the named repo', async () => {
    assert.deepEqual(await judge('gh pr create --repo acme/alpha --base develop --head feat/x', outside), ALLOW_RESULT);
    assert.match(reason((await judge('gh pr create --repo acme/alpha --base main --head feat/x', outside)).stdout), /in repo alpha\./);
  });

  it("several registered repos share the origin: the statement's own repo wins, else the first by name", async () => {
    assert.deepEqual(await judge('gh pr create --repo acme/beta --base main --head feat/x', beta), ALLOW_RESULT);
    assert.match(reason((await judge('gh pr create --repo acme/beta --base main --head feat/x', outside)).stdout), /^BLOCKED: PRs must target release branch in repo aardvark\./);
    assert.match(reason((await judge('gh pr create --repo acme/beta --base main --head feat/x', alpha)).stdout), /in repo aardvark\./);
  });

  it('without a readable DB a --repo create gets no verdict, and a cwd create is named by its root', async () => {
    const noDb = { ...env, TRAJECTORY_DB_PATH: join(dir, 'none.db') };
    assert.deepEqual(await judge('gh pr create --repo acme/alpha --base anything', beta, noDb), ALLOW_RESULT);
    const cwdDeny = reason((await judge('gh pr create --base anything', beta, noDb)).stdout);
    assert.ok(cwdDeny.startsWith(`BLOCKED: PRs must target main branch in repo ${beta}.`), cwdDeny);
  });

  it('forgeSpecMatchesRemote compares host only when the spec names one, ignoring case, scheme, user, port and .git', () => {
    const yes: Array<[string, string]> = [
      ['acme/alpha', 'https://github.com/acme/alpha.git'],
      ['ACME/Alpha', 'git@github.com:acme/alpha.git'],
      ['acme/alpha', 'ssh://git@ghe.example.com:2222/acme/alpha.git/'],
      ['github.com/acme/alpha', 'git@github.com:acme/alpha'],
      ['https://github.com/acme/alpha/', 'https://git@github.com/acme/alpha.git'],
      ['git@gitlab.com:g/sub/r.git', 'https://gitlab.com/g/sub/r'],
      ['g/sub/r', 'https://gitlab.example.com/g/sub/r.git'],
    ];
    for (const [spec, url] of yes) assert.equal(forgeSpecMatchesRemote(spec, url), true, `${spec} ~ ${url}`);
    const no: Array<[string, string]> = [
      ['acme/alpha', 'https://github.com/acme/alphabet.git'],
      ['gitlab.com/acme/alpha', 'https://github.com/acme/alpha.git'],
      ['https://gitlab.com/acme/alpha', 'git@github.com:acme/alpha.git'],
      ['alpha', 'https://github.com/acme/alpha.git'],
      ['acme/alpha', ''],
      ['', 'https://github.com/acme/alpha.git'],
    ];
    for (const [spec, url] of no) assert.equal(forgeSpecMatchesRemote(spec, url), false, `${spec} !~ ${url}`);
  });
});
