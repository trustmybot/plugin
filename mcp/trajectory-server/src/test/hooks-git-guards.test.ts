/**
 * The TypeScript git-guards where it is stricter than scripts/hooks/git-guards.sh
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
import { gitGuards, needsGitGuard, PARSE_REASON } from '../hooks/git-guards.js';
import { findGate, gateNames } from '../hooks/registry.js';

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

  it('analyses a git word after a non-ASCII letter, as the .sh does only in the C locale', () => {
    assert.equal(needsGitGuard('égit commit'), true);
    assert.equal(needsGitGuard('é git commit'), true);
    assert.equal(needsGitGuard('legit commit'), false);
    assert.equal(needsGitGuard('cat .git/config'), false);
    assert.equal(needsGitGuard('echo x\ngh pr create'), true);
    const sh = (locale: string) =>
      spawnSync('sh', ['-c', `printf '%s' "$1" | grep -E '(^|[^[:alnum:]_./-])(git|gh|glab)([[:space:]]|$)' >/dev/null`, '_', 'égit commit'], {
        env: { ...process.env, LC_ALL: locale },
      }).status;
    assert.equal(sh('C'), 0, 'the C locale reads é as two non-alnum bytes');
  });

  it('allows switch-then-fast-forward only in an ASCII-only command, as the .sh does where awk fails on UTF-8', async () => {
    const sync = `cd ${main} && git switch feat/x && git merge --ff-only @{u}`;
    assert.deepEqual(await gitGuards(payload(sync, dir), env), { stdout: '', code: 0 });
    const quoted = `echo "é" && ${sync}`;
    const r = await gitGuards(payload(quoted, dir), env);
    assert.match(reason(r.stdout), /To sync a branch with its own upstream/);
    const utf8 = { ...env, LC_ALL: 'en_US.UTF-8' };
    const awkFails = spawnSync('bash', ['-c', '. "$1"; tmb_cmd_strip_literals "$2"', '_', join(PLUGIN_ROOT, 'scripts/hooks/lib/cmd-analysis.sh'), 'echo "é"'], { env: utf8 }).status !== 0;
    const sh = spawnSync('bash', [join(PLUGIN_ROOT, 'scripts/hooks/git-guards.sh')], { input: payload(quoted, dir), encoding: 'utf8', env: utf8 });
    assert.equal(sh.stdout, awkFails ? r.stdout : '');
  });

  it('reads the DB through node:sqlite with no sqlite3 CLI on PATH: an unregistered sibling stays unguarded', async () => {
    const r = await gitGuards(payload('git commit -m x', sibling), { ...env, PATH: gitOnly });
    assert.deepEqual(r, { stdout: '', code: 0 });
  });

  it('with the CLI backend and no sqlite3 on PATH it falls back to the defaults, as the .sh does', async () => {
    const r = await gitGuards(payload('git commit -m x', sibling), { ...env, PATH: gitOnly, TMB_HOOKS_SQLITE: 'cli' });
    assert.match(reason(r.stdout), /^BLOCKED: main is a shared workflow base/);
  });
});
