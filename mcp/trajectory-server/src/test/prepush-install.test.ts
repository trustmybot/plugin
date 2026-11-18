/**
 * prepush-install (GH 3281 slice 2): the SessionStart gate that installs TMB's
 * config-defined pre-push hook, the script it installs, the agent-shell mark,
 * prepushHookLive and `cli.js prepush-uninstall`, against real git repos and
 * real pushes to a bare origin.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isAgentSession } from '../hooks/pre-push/judge.js';
import { gitCommonDir, installPrepushHook, PREPUSH_MARKER, prepushHookLive, prepushScriptPath, pluginCliPath } from '../hooks/lib/prepush-hook.js';
import { AGENT_SHELL_MARK, markAgentShell, parseGitVersion, supportsConfigHooks } from '../hooks/prepush-install.js';
import { makeSandbox, PLUGIN_ROOT, runGate, type Sandbox } from './hook-sandbox.js';

const GATE = 'prepush-install';
const CLI = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/cli.js');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');

let sb: Sandbox;
let n = 0;

function git(dir: string, ...args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...sb.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' }, timeout: 60_000 });
  return { code: r.status, out: r.stdout.replace(/\n+$/, ''), err: r.stderr };
}

function gitOk(dir: string, ...args: string[]): string {
  const r = git(dir, ...args);
  assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.err}`);
  return r.out;
}

/** A fresh case dir holding a repo `work` with one commit, pushed to a bare `origin.git`. */
function repoCase(): { dir: string; work: string; origin: string } {
  n += 1;
  const dir = join(sb.dir, `case-${n}`);
  const work = join(dir, 'work');
  const origin = join(dir, 'origin.git');
  mkdirSync(work, { recursive: true });
  gitOk(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  gitOk(work, 'init', '-q', '-b', 'main');
  writeFileSync(join(work, 'a.txt'), 'a\n');
  gitOk(work, 'add', 'a.txt');
  gitOk(work, 'commit', '-qm', 'a');
  gitOk(work, 'remote', 'add', 'origin', origin);
  return { dir, work, origin };
}

function newDb(dir: string, repos: Record<string, string>): string {
  const db = join(dir, 'trajectory.db');
  const d = new DatabaseSync(db);
  try {
    d.exec(SCHEMA);
    for (const [name, path] of Object.entries(repos)) d.prepare('INSERT INTO repos (name, path) VALUES (?, ?)').run(name, path);
  } finally {
    d.close();
  }
  return db;
}

/** Stores the project's prepush_hook setting in <db>, as /onboard does; null deletes it. */
function setPrepushHook(db: string, value: 'on' | 'off' | null): void {
  const d = new DatabaseSync(db);
  try {
    if (value === null) d.prepare("DELETE FROM plugin_config WHERE key = 'prepush_hook'").run();
    else d.prepare("INSERT INTO plugin_config (key, value_json) VALUES ('prepush_hook', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(JSON.stringify(value));
  } finally {
    d.close();
  }
}

function gateEnv(project: string, db: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...sb.env, CLAUDE_PROJECT_DIR: project, TRAJECTORY_DB_PATH: db, ...extra };
}

function commit(work: string, file: string): void {
  writeFileSync(join(work, file), `${file}\n`);
  gitOk(work, 'add', file);
  gitOk(work, 'commit', '-qm', file);
}

/** A stand-in cli.js that logs its args and stdin to <log>, then runs <tail> (an exit or a throw). */
function fakeCli(dir: string, log: string, tail: string): string {
  const cli = join(dir, `fake-cli-${n}.js`);
  writeFileSync(
    cli,
    `const fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(log)}, 'args=' + process.argv.slice(2).join(' ') + '\\n' + fs.readFileSync(0, 'utf8'));\n${tail}\n`,
  );
  return cli;
}

function pushEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...sb.env, ...extra };
}

function push(work: string, env: NodeJS.ProcessEnv, ...args: string[]): { code: number | null; err: string } {
  const r = spawnSync('git', ['-C', work, 'push', ...args], { encoding: 'utf8', env, timeout: 120_000 });
  return { code: r.status, err: r.stderr };
}

function remoteSha(origin: string, ref: string): string {
  return git(origin, 'rev-parse', '--verify', '-q', ref).out;
}

before(() => {
  sb = makeSandbox('prepush-install');
});
after(() => sb.remove());

describe('prepush-install: the SessionStart gate (SC1)', () => {
  it('installs the script and the hook.tmb keys in the project repo and each registered repo, skips a non-git dir, never touches core.hooksPath', () => {
    const { dir, work } = repoCase();
    const other = join(dir, 'other');
    gitOk(dir, 'init', '-q', 'other');
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    gitOk(work, 'config', 'core.hooksPath', '.husky');
    const db = newDb(dir, { other, plain });

    const r = runGate(GATE, { cwd: work, env: gateEnv(work, db) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', 'the gate never denies or injects');
    const lines = r.stderr.split('\n').filter((l) => l !== '');
    assert.deepEqual(lines, [
      `tmb: installed TMB's pre-push hook (observe mode) in ${work}`,
      `tmb: installed TMB's pre-push hook (observe mode) in ${other}`,
      `tmb: pre-push hook skipped for ${plain}: not a git repository`,
    ]);

    for (const repo of [work, other]) {
      const script = join(repo, '.git/tmb/pre-push');
      assert.equal(statSync(script).mode & 0o777, 0o755);
      const text = readFileSync(script, 'utf8');
      assert.ok(text.split('\n').includes(PREPUSH_MARKER), text);
      assert.ok(text.includes(`cli='${CLI}'`), `the script bakes in the absolute CLI path:\n${text}`);
      assert.equal(gitOk(repo, 'config', '--local', 'hook.tmb.event'), 'pre-push');
      assert.equal(gitOk(repo, 'config', '--local', 'hook.tmb.command'), script);
      assert.equal(gitOk(repo, 'config', '--local', 'hook.tmb.enabled'), 'true');
    }
    assert.equal(gitOk(work, 'config', 'core.hooksPath'), '.husky');
    assert.equal(git(other, 'config', 'core.hooksPath').code, 1, 'core.hooksPath stays unset');
  });

  it('a second run changes nothing', () => {
    const { dir, work } = repoCase();
    const db = newDb(dir, {});
    assert.equal(runGate(GATE, { cwd: work, env: gateEnv(work, db) }).status, 0);
    const script = join(work, '.git/tmb/pre-push');
    const config = join(work, '.git/config');
    const before = [statSync(script).mtimeMs, readFileSync(config, 'utf8'), statSync(config).mtimeMs];
    const r = runGate(GATE, { cwd: work, env: gateEnv(work, db) });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '', 'nothing changed, so nothing to say');
    assert.deepEqual([statSync(script).mtimeMs, readFileSync(config, 'utf8'), statSync(config).mtimeMs], before);
  });

  it('a linked worktree shares the install: the hook is listed there and runs on its push', async () => {
    const { dir, work, origin } = repoCase();
    const db = newDb(dir, {});
    assert.equal(runGate(GATE, { cwd: work, env: gateEnv(work, db) }).status, 0);
    const wt = join(dir, 'wt');
    gitOk(work, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
    assert.match(gitOk(wt, 'hook', 'list', 'pre-push'), /^tmb$/m);
    const log = join(dir, 'cli.log');
    const cli = fakeCli(dir, log, 'process.exit(0);');
    // The gate baked in the real CLI; point the same script at a stand-in that logs.
    await installPrepushHook(work, await gitCommonDir(work, sb.env), cli, sb.env);
    commit(wt, 'x.txt');
    const r = push(wt, pushEnv({ TMB_AGENT_SHELL: '1' }), 'origin', 'feat/x');
    assert.equal(r.code, 0, r.err);
    assert.match(readFileSync(log, 'utf8'), /args=pre-push origin /);
    assert.notEqual(remoteSha(origin, 'refs/heads/feat/x'), '');
  });

  it('below git 2.54 it installs nothing and says the command-text judge stays on', () => {
    const { dir, work } = repoCase();
    const db = newDb(dir, {});
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: sb.env, timeout: 10_000 }).stdout.trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = version ] && { echo 'git version 2.53.0'; exit 0; }; done\nexec '${realGit}' "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const r = runGate(GATE, { cwd: work, env: gateEnv(work, db, { PATH: `${bin}:${sb.env.PATH}` }) });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'tmb: pre-push hook not installed: git 2.53 is older than 2.54, so the command-text push judge stays on alone\n');
    assert.equal(existsSync(join(work, '.git/tmb')), false);
    assert.equal(git(work, 'config', '--local', '--get-regexp', '^hook\\.').code, 1);
  });

  it('prepush_hook off installs nothing and prints one notice naming the setting, /onboard and prepush-uninstall', () => {
    const { dir, work } = repoCase();
    const db = newDb(dir, {});
    setPrepushHook(db, 'off');
    const r = runGate(GATE, { cwd: work, env: gateEnv(work, db) });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    const lines = r.stderr.split('\n').filter((l) => l !== '');
    assert.equal(lines.length, 1, r.stderr);
    assert.match(lines[0], /^tmb: prepush_hook is off for this project, so TMB's pre-push hook is off: no installed hook to remove; the command-text push judge stays on\./);
    assert.match(lines[0], /\/onboard/);
    assert.match(lines[0], /prepush-uninstall/);
    assert.equal(existsSync(join(work, '.git/tmb')), false);
  });

  it('prepush_hook off removes an installed hook from each repo it would install in, exempt or not; on installs it again', async () => {
    const { dir, work } = repoCase();
    const free = join(dir, 'free');
    gitOk(dir, 'init', '-q', 'free');
    const db = newDb(dir, { free });
    const d = new DatabaseSync(db);
    d.prepare("UPDATE repos SET mode = 'exempt' WHERE name = 'free'").run();
    d.close();
    for (const repo of [work, free]) {
      const commonDir = await gitCommonDir(repo, sb.env);
      await installPrepushHook(repo, commonDir, CLI, sb.env);
    }
    gitOk(work, 'config', 'user.name', 'kept');
    assert.equal((await prepushHookLive(work, gateEnv(work, db))).switched_off, false, 'unset reads as on');

    setPrepushHook(db, 'off');
    const r = runGate(GATE, { cwd: work, env: gateEnv(work, db) });
    assert.equal(r.status, 0);
    const lines = r.stderr.split('\n').filter((l) => l !== '');
    assert.equal(lines.length, 1, r.stderr);
    assert.ok(lines[0].includes(`removed it from ${work}, ${free}`), lines[0]);
    for (const repo of [work, free]) {
      assert.equal(git(repo, 'config', '--local', '--get-regexp', '^hook\\.tmb\\.').code, 1, `no hook.tmb key left in ${repo}`);
      assert.equal(existsSync(join(repo, '.git/tmb')), false, repo);
      assert.equal((await prepushHookLive(repo, gateEnv(work, db))).switched_off, true);
    }
    assert.equal(gitOk(work, 'config', 'user.name'), 'kept', 'other config stays');

    // Set back on, the next session start installs it again.
    setPrepushHook(db, 'on');
    assert.equal((await prepushHookLive(work, gateEnv(work, db))).switched_off, false);
    const again = runGate(GATE, { cwd: work, env: gateEnv(work, db) });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(existsSync(join(work, '.git/tmb')), true);
  });

  it('a prepush_hook the DB cannot read keeps the hook on', async () => {
    const { dir, work } = repoCase();
    const junk = join(dir, 'junk.db');
    writeFileSync(junk, 'not a sqlite file');
    assert.equal((await prepushHookLive(work, gateEnv(work, junk))).switched_off, false);
  });

  it('an exempt repo gets no script and no hook.tmb keys; a non-exempt one beside it still does (SC10)', () => {
    const { dir, work } = repoCase();
    const free = join(dir, 'free');
    gitOk(dir, 'init', '-q', 'free');
    const db = newDb(dir, { free });
    const d = new DatabaseSync(db);
    d.prepare("UPDATE repos SET mode = 'exempt' WHERE name = 'free'").run();
    d.close();

    const r = runGate(GATE, { cwd: work, env: gateEnv(work, db) });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stderr.split('\n').filter((l) => l !== ''), [
      `tmb: installed TMB's pre-push hook (observe mode) in ${work}`,
      `tmb: pre-push hook skipped for ${free}: repo free is exempt`,
    ]);
    assert.equal(existsSync(join(free, '.git/tmb')), false);
    assert.equal(git(free, 'config', '--local', '--get-regexp', '^hook\\.').code, 1, 'no hook.* key in the exempt repo');
  });

  it('parses git versions and gates on 2.54', () => {
    assert.deepEqual(parseGitVersion('git version 2.56.1\n'), [2, 56]);
    assert.deepEqual(parseGitVersion('git version 2.54.0.windows.1'), [2, 54]);
    assert.equal(parseGitVersion('not git'), null);
    assert.equal(supportsConfigHooks([2, 53]), false);
    assert.equal(supportsConfigHooks([2, 54]), true);
    assert.equal(supportsConfigHooks([3, 0]), true);
  });

  it('the CLI path is the plugin\'s own dist/cli.js', () => {
    assert.equal(pluginCliPath(), CLI);
  });
});

describe('prepush-install: the installed script (SC2)', () => {
  it('beside a husky core.hooksPath hook: git hook list shows both, and a real agent push runs both with the refs on stdin', async () => {
    const { dir, work, origin } = repoCase();
    const log = join(dir, 'cli.log');
    const husky = join(dir, 'husky.log');
    mkdirSync(join(work, '.husky'));
    writeFileSync(join(work, '.husky/pre-push'), `#!/bin/sh\necho husky >> '${husky}'\n`);
    chmodSync(join(work, '.husky/pre-push'), 0o755);
    gitOk(work, 'config', 'core.hooksPath', '.husky');
    await installPrepushHook(work, await gitCommonDir(work, sb.env), fakeCli(dir, log, 'process.exit(0);'), sb.env);
    const listed = gitOk(work, 'hook', 'list', 'pre-push').split('\n');
    assert.ok(listed.includes('tmb'), listed.join('\n'));
    assert.ok(listed.some((l) => l.includes('hookdir')), listed.join('\n'));

    const r = push(work, pushEnv({ TMB_AGENT_SHELL: '1' }), 'origin', 'main');
    assert.equal(r.code, 0, r.err);
    const head = gitOk(work, 'rev-parse', 'HEAD');
    assert.equal(readFileSync(log, 'utf8'), `args=pre-push origin ${origin}\nrefs/heads/main ${head} refs/heads/main ${'0'.repeat(40)}\n`);
    assert.equal(readFileSync(husky, 'utf8'), 'husky\n');
  });

  for (const [name, tail] of [
    ['exits 1', 'process.exit(1);'],
    ['crashes', "throw new Error('boom');"],
  ] as const) {
    it(`a CLI that ${name} still lets the push through`, async () => {
      const { dir, work, origin } = repoCase();
      const log = join(dir, 'cli.log');
      await installPrepushHook(work, await gitCommonDir(work, sb.env), fakeCli(dir, log, tail), sb.env);
      const r = push(work, pushEnv({ TMB_AGENT_SHELL: '1' }), 'origin', 'main');
      assert.equal(r.code, 0, r.err);
      assert.ok(existsSync(log), 'the CLI ran');
      assert.equal(remoteSha(origin, 'refs/heads/main'), gitOk(work, 'rev-parse', 'HEAD'));
    });
  }

  it('outside a marked agent shell the script exits 0 without running the CLI', async () => {
    const { dir, work, origin } = repoCase();
    const log = join(dir, 'cli.log');
    await installPrepushHook(work, await gitCommonDir(work, sb.env), fakeCli(dir, log, 'process.exit(1);'), sb.env);
    const r = push(work, pushEnv(), 'origin', 'main');
    assert.equal(r.code, 0, r.err);
    assert.equal(existsSync(log), false);
    assert.notEqual(remoteSha(origin, 'refs/heads/main'), '');
  });

  it('with the baked CLI path gone the script exits 0', async () => {
    const { dir, work, origin } = repoCase();
    await installPrepushHook(work, await gitCommonDir(work, sb.env), join(dir, 'gone/cli.js'), sb.env);
    const script = prepushScriptPath(await gitCommonDir(work, sb.env));
    const direct = spawnSync(script, ['origin', origin], { encoding: 'utf8', env: pushEnv({ TMB_AGENT_SHELL: '1' }), input: '', timeout: 10_000 });
    assert.equal(direct.status, 0, direct.stderr);
    const r = push(work, pushEnv({ TMB_AGENT_SHELL: '1' }), 'origin', 'main');
    assert.equal(r.code, 0, r.err);
    assert.notEqual(remoteSha(origin, 'refs/heads/main'), '');
  });
});

describe('prepush-install: the agent-shell mark (SC3)', () => {
  it('the gate appends the mark to CLAUDE_ENV_FILE once', () => {
    const { dir, work } = repoCase();
    const envFile = join(dir, 'claude-env');
    writeFileSync(envFile, 'export FOO=1');
    const db = newDb(dir, {});
    for (let i = 0; i < 2; i++) assert.equal(runGate(GATE, { cwd: work, env: gateEnv(work, db, { CLAUDE_ENV_FILE: envFile }) }).status, 0);
    assert.equal(readFileSync(envFile, 'utf8'), `export FOO=1\n${AGENT_SHELL_MARK}\n`);
  });

  it('markAgentShell creates a missing file', () => {
    const envFile = join(sb.dir, `env-${++n}`);
    markAgentShell(envFile);
    markAgentShell(envFile);
    assert.equal(readFileSync(envFile, 'utf8'), `${AGENT_SHELL_MARK}\n`);
  });

  it('isAgentSession counts TMB_AGENT_SHELL=1 as an agent', () => {
    assert.equal(isAgentSession({ TMB_AGENT_SHELL: '1' }), true);
    assert.equal(isAgentSession({ TMB_AGENT_SHELL: '0' }), false);
    assert.equal(isAgentSession({}), false);
  });
});

describe('prepushHookLive (SC7)', () => {
  async function installed(): Promise<{ work: string; script: string }> {
    const { work } = repoCase();
    const commonDir = await gitCommonDir(work, sb.env);
    await installPrepushHook(work, commonDir, CLI, sb.env);
    return { work, script: prepushScriptPath(commonDir) };
  }

  it('enabled: listed, command matches, script intact', async () => {
    const { work } = await installed();
    assert.deepEqual(await prepushHookLive(work, sb.env), { listed: true, command_matches: true, script_intact: true, switched_off: false });
  });

  it('hook.tmb.enabled=false: not listed', async () => {
    const { work } = await installed();
    gitOk(work, 'config', 'hook.tmb.enabled', 'false');
    assert.deepEqual(await prepushHookLive(work, sb.env), { listed: false, command_matches: true, script_intact: true, switched_off: false });
  });

  it('hook.pre-push.enabled=false (the event disabled): not listed', async () => {
    const { work } = await installed();
    gitOk(work, 'config', 'hook.pre-push.enabled', 'false');
    assert.equal((await prepushHookLive(work, sb.env)).listed, false);
  });

  it('command swapped: command_matches false', async () => {
    const { work } = await installed();
    gitOk(work, 'config', 'hook.tmb.command', '/bin/true');
    assert.deepEqual(await prepushHookLive(work, sb.env), { listed: true, command_matches: false, script_intact: true, switched_off: false });
  });

  it('script missing: script_intact false', async () => {
    const { work, script } = await installed();
    rmSync(script);
    assert.equal((await prepushHookLive(work, sb.env)).script_intact, false);
  });

  it('nothing installed: all false', async () => {
    const { work } = repoCase();
    assert.deepEqual(await prepushHookLive(work, sb.env), { listed: false, command_matches: false, script_intact: false, switched_off: false });
  });
});

describe('cli.js prepush-uninstall (SC8)', () => {
  function uninstall(...args: string[]): { code: number | null; out: string; err: string } {
    const r = spawnSync(process.execPath, ['--experimental-sqlite', CLI, 'prepush-uninstall', ...args], { encoding: 'utf8', env: sb.env, timeout: 60_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  }

  it('removes the hook.tmb section and the script, a push still succeeds, and a second run exits 0', async () => {
    const { work, origin } = repoCase();
    const commonDir = await gitCommonDir(work, sb.env);
    await installPrepushHook(work, commonDir, CLI, sb.env);
    gitOk(work, 'config', 'user.name', 'kept');

    const first = uninstall('--repo', work);
    assert.equal(first.code, 0, first.err);
    assert.equal(first.out, `removed TMB's pre-push hook from ${work}\n`);
    assert.equal(git(work, 'config', '--local', '--get-regexp', '^hook\\.tmb\\.').code, 1, 'no hook.tmb key left');
    assert.equal(existsSync(prepushScriptPath(commonDir)), false);
    assert.equal(existsSync(join(commonDir, 'tmb')), false);
    assert.equal(gitOk(work, 'config', 'user.name'), 'kept', 'other config stays');
    assert.equal(push(work, pushEnv({ TMB_AGENT_SHELL: '1' }), 'origin', 'main').code, 0);
    assert.notEqual(remoteSha(origin, 'refs/heads/main'), '');

    const second = uninstall(`--repo=${work}`);
    assert.equal(second.code, 0, second.err);
    assert.equal(second.out, `no TMB pre-push hook in ${work}\n`);
  });

  it('a --repo that is no git repo exits 1; a bad argument exits 2', () => {
    const plain = join(sb.dir, `plain-${++n}`);
    mkdirSync(plain);
    const r = uninstall('--repo', plain);
    assert.equal(r.code, 1);
    assert.match(r.err, /is not a git repository/);
    assert.equal(uninstall('--bogus').code, 2);
  });
});
