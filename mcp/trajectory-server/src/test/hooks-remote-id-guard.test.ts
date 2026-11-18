/**
 * The TypeScript remote-id-guard's in-process deadline (GH 1821, GH 1861) and
 * the decision-703 divergences from the bash remote-id-guard.sh. The
 * overrun path is reached through TMB_REMOTE_ID_GUARD_TEST_OVERRUN=1, which
 * makes the budget read as spent from the start: no test waits on the clock.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { candidateTokens, deadlineSeconds, GATE_NAME, printfB, remoteIdGuard, repoOption } from '../hooks/remote-id-guard.js';
import { findGate } from '../hooks/registry.js';
import { localIssuesDb } from './hooks-remote-id-guard-parity.suite.js';
import { noCmdPath } from './hooks-swe-run-parity.suite.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const CITES_FIVE = "gh pr create --title x --body 'Closes #5'";
const UNSET = ['TMB_DISABLE_REMOTE_ID_GUARD', 'TMB_REMOTE_ID_GUARD_DEADLINE_S', 'TMB_REMOTE_ID_GUARD_TEST_OVERRUN', 'TMB_HOOKS_SQLITE', 'LANG', 'LC_CTYPE'];
const OVERRUN_LINE = /^remote-id-guard: analysis passed its (\S+)s deadline \(TMB_REMOTE_ID_GUARD_DEADLINE_S\) after (\d+\.\d{3})s; allowing\n$/;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function reason(stdout: string): string {
  if (stdout === '') return '';
  const out = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

interface OverrunRow {
  issue_id: number;
  from_node: string;
  event_type: string;
  summary: string;
  content_json: string;
}

describe('remote-id-guard: in-process deadline and decision-703 divergences', () => {
  let dir: string;
  let db: string;
  const run = (command: string, extra: NodeJS.ProcessEnv = {}): Run => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of UNSET) delete env[key];
    Object.assign(env, { CLAUDE_PROJECT_DIR: join(dir, 'project'), TRAJECTORY_DB_PATH: db, LC_ALL: 'C', ...extra });
    const r = spawnSync(process.execPath, [HOOKS_BUNDLE, GATE_NAME], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      env,
      cwd: dir,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (r.error) throw r.error;
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const overrunRows = (): OverrunRow[] => {
    const handle = new DatabaseSync(db, { readOnly: true });
    try {
      return handle.prepare("SELECT issue_id, from_node, event_type, summary, content_json FROM audit WHERE event_type = 'remote_id_guard_overrun' ORDER BY id").all() as unknown as OverrunRow[];
    } finally {
      handle.close();
    }
  };

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-rig-')));
    db = join(dir, 'db/trajectory.db');
    localIssuesDb(db);
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is registered in the gate registry', () => {
    assert.ok(findGate(GATE_NAME));
  });

  it('denies a local id that names a different remote issue', () => {
    const r = run(CITES_FIVE);
    assert.equal(r.code, 0);
    assert.ok(reason(r.stdout).includes('#5 → #42 (GitHub)'), r.stdout);
  });

  it('on overrun allows, prints one stderr line and writes one audit row on issue -1', () => {
    const before = overrunRows().length;
    const r = run(CITES_FIVE, { TMB_REMOTE_ID_GUARD_TEST_OVERRUN: '1', TMB_REMOTE_ID_GUARD_DEADLINE_S: '1' });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'allowed');
    const line = OVERRUN_LINE.exec(r.stderr);
    assert.ok(line, r.stderr);
    assert.equal(line[1], '1');
    assert.ok(Number(line[2]) >= 1, line[2]);
    const rows = overrunRows();
    assert.equal(rows.length, before + 1);
    const row = rows[rows.length - 1];
    assert.equal(row.issue_id, -1);
    assert.equal(row.from_node, 'hook:remote-id-guard');
    assert.equal(row.summary, 'remote-id-guard allowed a Bash command: its analysis passed the 1s deadline');
    const content = JSON.parse(row.content_json) as { deadline_s: number; elapsed_s: number };
    assert.equal(content.deadline_s, 1);
    assert.ok(content.elapsed_s >= 1, row.content_json);
  });

  it('on overrun with no DB still allows with the stderr line', () => {
    const r = run(CITES_FIVE, { TMB_REMOTE_ID_GUARD_TEST_OVERRUN: '1', TRAJECTORY_DB_PATH: join(dir, 'no-such.db') });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, OVERRUN_LINE);
  });

  it('an invalid deadline falls back to 3 s', () => {
    for (const bad of ['abc', '0', '00', '01', '1.', '.5', '-1', '0.0', '', ' 2']) assert.equal(deadlineSeconds({ TMB_REMOTE_ID_GUARD_DEADLINE_S: bad }), '3', JSON.stringify(bad));
    for (const good of ['1', '2.5', '0.5', '10']) assert.equal(deadlineSeconds({ TMB_REMOTE_ID_GUARD_DEADLINE_S: good }), good);
    assert.equal(deadlineSeconds({}), '3');
    const r = run(CITES_FIVE, { TMB_REMOTE_ID_GUARD_TEST_OVERRUN: '1', TMB_REMOTE_ID_GUARD_DEADLINE_S: 'abc' });
    assert.equal(OVERRUN_LINE.exec(r.stderr)?.[1], '3', r.stderr);
    assert.ok(reason(run(CITES_FIVE, { TMB_REMOTE_ID_GUARD_DEADLINE_S: 'abc' }).stdout).includes('#5 → #42'));
  });

  it('the bypass allows before any analysis', () => {
    const r = run(CITES_FIVE, { TMB_DISABLE_REMOTE_ID_GUARD: '1', TMB_REMOTE_ID_GUARD_TEST_OVERRUN: '1' });
    assert.deepEqual(r, { code: 0, stdout: '', stderr: '' });
  });

  it('decision 703: a command tree-sitter cannot parse is allowed', () => {
    const r = run("gh pr create --title x --body 'Closes #5");
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  });

  it('decision 703: no jq and no sqlite3 CLI on PATH still denies', () => {
    const path = process.env.PATH ?? '';
    for (const cmd of ['jq', 'sqlite3']) {
      const r = run(CITES_FIVE, { PATH: noCmdPath(join(dir, `no-${cmd}`), cmd, path) });
      assert.equal(r.code, 0, `${cmd}: ${r.stderr}`);
      assert.ok(reason(r.stdout).includes('#5 → #42 (GitHub)'), `${cmd}: ${r.stdout}`);
    }
  });

  it('printfB reads escapes as bash printf %b does', () => {
    for (const text of ['back\\slash \\t tab \\x41 \\101 \\c cut', 'a\\nb\\\\c', '\\0101\\08\\1x', '\\e\\E\\a\\v\\f\\r', '\\u00e9 ü \\q', 'trail\\', 'two\\n\\n']) {
      const bash = spawnSync('bash', ['-c', 'printf "%b" "$1"', '_', text], { encoding: 'utf8' });
      assert.equal(printfB(text), bash.stdout.replace(/\0/g, '').replace(/\n+$/, ''), JSON.stringify(text));
    }
  });

  it('candidateTokens drops remote markers and sorts unique ids', () => {
    assert.deepEqual(candidateTokens('see #5 #5 #12 GH-7 gl-6 remote:8 o/r#9 #042'), ['042', '12', '5']);
  });

  it("GH 2787: reads a #N spelled in $'…' or split by a line continuation as the plain one", () => {
    const plain = reason(run("gh issue comment 3116 --body 'Closes #10'").stdout);
    assert.ok(plain.includes('#10 → #50 (GitHub)'), plain);
    for (const command of [
      "gh issue comment 3116 --body $'Closes \\x2310'",
      'gh issue comment 3116 --body "Closes #1\\\n0"',
      'gh issue comment 3116 --body Closes\\ #1\\\n0',
      "gh issue comment 3116 --body $'Closes #\\x310'",
    ]) {
      assert.equal(reason(run(command).stdout), plain, command);
    }
    assert.equal(run("gh issue comment 3116 --body $'Closes \\x23x10'").stdout, '', 'no issue ref once decoded');
  });

  it('GH 2787: a #N only another statement holds still counts, a remote write in a quoted string does not', () => {
    assert.ok(reason(run("B='Closes #10'; gh issue comment 1 --body \"$B\"").stdout).includes('#10 → #50 (GitHub)'));
    assert.equal(run("echo \"gh issue comment 1 --body $'\\x2310'\"").stdout, '');
  });
});

describe('remote-id-guard judges a #N against the repo the command targets (GH 2143)', () => {
  let dir: string;
  let first: string;
  let other: string;
  const gitIn = (cwd: string, ...args: string[]): void => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(r.status, 0, r.stderr);
  };
  /** A DB registering both repos and holding <issues>: [id, repo, gh_iid]. */
  const twoRepoDb = (name: string, issues: ReadonlyArray<readonly [number, string | null, number]>): string => {
    const path = join(dir, `${name}.db`);
    localIssuesDb(path);
    const db = new DatabaseSync(path);
    try {
      db.exec('DELETE FROM issues');
      const repo = db.prepare('INSERT INTO repos (name, path) VALUES (?, ?)');
      repo.run('first', first);
      repo.run('other', other);
      const issue = db.prepare("INSERT INTO issues (id, objective, status, repo, gh_iid, created_at, updated_at) VALUES (?, ?, 'open', ?, ?, datetime('now'), datetime('now'))");
      for (const [id, repoName, gh] of issues) issue.run(id, `Local ${id}`, repoName, gh);
    } finally {
      db.close();
    }
    return path;
  };
  const verdict = async (db: string, command: string, cwd = first): Promise<string> => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: dir, TRAJECTORY_DB_PATH: db, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const r = await remoteIdGuard(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }), env);
    return reason(r.stdout);
  };
  const CREATE_OTHER = "gh pr create --repo owner/other --title t --body 'Closes #10'";

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-rig-repos-')));
    first = join(dir, 'first');
    other = join(dir, 'other');
    for (const [root, name] of [
      [first, 'first'],
      [other, 'other'],
    ]) {
      mkdirSync(root);
      gitIn(root, 'init', '-q');
      gitIn(root, 'remote', 'add', 'origin', `https://github.com/owner/${name}.git`);
    }
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('admits --repo <other> when local 10 belongs to the first repo', async () => {
    const db = twoRepoDb('first-owns-ten', [[10, 'first', 3151]]);
    assert.equal(await verdict(db, CREATE_OTHER), '');
    assert.ok((await verdict(db, "gh pr create --title t --body 'Closes #10'")).includes('#10 → #3151 (GitHub)'), 'the cwd repo still judges a command with no --repo');
  });

  it("admits --repo <other> when 10 is the other repo's remote iid of one of its local issues", async () => {
    const db = twoRepoDb('other-iid-ten', [
      [10, 'other', 3151],
      [20, 'other', 10],
    ]);
    assert.equal(await verdict(db, CREATE_OTHER), '');
    assert.equal(await verdict(db, "gh pr create -R owner/other --title t --body 'Closes #10'"), '');
  });

  it('denies --repo <other> when a local issue of the other repo has id 10 and a different remote iid', async () => {
    const db = twoRepoDb('other-owns-ten', [
      [10, 'other', 3151],
      [20, 'first', 10],
    ]);
    assert.ok((await verdict(db, CREATE_OTHER)).includes('#10 → #3151 (GitHub)'));
    assert.ok((await verdict(db, "gh pr create --repo=owner/other --title t --body 'Closes #10'")).includes('#10 → #3151 (GitHub)'));
    assert.ok((await verdict(db, "gh pr create --title t --body 'Closes #10'", other)).includes('#10 → #3151 (GitHub)'), 'run in the other repo');
  });

  it('repoOption reads -R/--repo in each spelling, never a text value', () => {
    assert.equal(repoOption('gh pr create --repo o/r --body x'), 'o/r');
    assert.equal(repoOption('gh pr create --repo=o/r'), 'o/r');
    assert.equal(repoOption('gh issue comment 1 -R o/r -b x'), 'o/r');
    assert.equal(repoOption('gh issue comment 1 -Ro/r'), 'o/r');
    assert.equal(repoOption('gh pr create --body see_--repo_o/r'), '');
  });

  it('admits a --repo that names no registered repo', async () => {
    const db = twoRepoDb('unregistered', [[10, 'other', 3151]]);
    assert.equal(await verdict(db, "gh pr create --repo owner/elsewhere --title t --body 'Closes #10'"), '');
  });
});
