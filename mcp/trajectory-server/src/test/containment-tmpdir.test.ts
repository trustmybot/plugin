/**
 * containment-guard (TS) and the sandbox TMPDIR (GH 1912): with no TMPDIR in
 * the hook env, a sandboxed Bash write to `$TMPDIR/…` is judged under
 * /tmp/claude-<uid>, the TMPDIR Claude Code's sandbox runs the command with.
 * Marked dangerouslyDisableSandbox, it is judged as today (denied); a hook env
 * TMPDIR keeps deciding. Runs the real
 * `node dist/hooks.js containment-guard` with a fake uid, so
 * /tmp/claude-<uid> never covers the sandbox.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const FAKE_UID = 4242424;
const NOW = '2026-10-25T10:00:00.000Z';

describe('containment-guard (TS): the sandbox TMPDIR (GH 1912)', () => {
  let sandbox: string;
  let project: string;
  let wt: string;
  let home: string;
  let hostTmp: string;
  let transcript: string;
  let env: NodeJS.ProcessEnv;

  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'tmb-cg-tmpdir-'));
    project = join(sandbox, 'project');
    wt = join(project, '.claude/worktrees/cg-task');
    home = join(sandbox, 'home');
    hostTmp = join(sandbox, 'host-tmp');
    const db = join(project, '.claude/tmb/trajectory.db');
    for (const dir of [join(wt, 'src'), dirname(db), home, hostTmp, join(sandbox, 'cache'), join(sandbox, 'cc')]) {
      mkdirSync(dir, { recursive: true });
    }
    const d = new DatabaseSync(db);
    d.exec(readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8'));
    d.prepare('INSERT INTO repos (name, path) VALUES (?, ?)').run('project', project);
    d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (7, 'tmpdir', 'open', ?, ?)").run(NOW, NOW);
    d.prepare(
      "INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at, repo) VALUES (5, 7, 'feat/cg-task', 'd', 'running', ?, ?, 'project')",
    ).run(NOW, NOW);
    d.close();
    transcript = join(sandbox, 'spawn-5.jsonl');
    writeFileSync(transcript, '{"message":{"content":[{"type":"text","text":"task_id=5"}]}}\n');
    env = {
      PATH: process.env.PATH,
      HOME: home,
      CLAUDE_PROJECT_DIR: project,
      CLAUDE_CONFIG_DIR: join(sandbox, 'cc'),
      TMB_MODEL_CACHE_DIR: join(sandbox, 'cache'),
      PWD: project,
      NODE_OPTIONS: `--import ${join(PLUGIN_ROOT, 'tests/lib/fake-uid.mjs')}`,
    };
  });

  after(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function run(command: string, opts: { disableSandbox?: boolean; tmpdir?: string } = {}): string | null {
    const toolInput: Record<string, unknown> = { command };
    if (opts.disableSandbox) toolInput.dangerouslyDisableSandbox = true;
    const payload = {
      hook_event_name: 'PreToolUse',
      session_id: 'tmpdir-test',
      cwd: wt,
      tool_name: 'Bash',
      tool_input: toolInput,
      agent_type: 'tmb:swe',
      agent_transcript_path: transcript,
    };
    const runEnv = opts.tmpdir === undefined ? env : { ...env, TMPDIR: opts.tmpdir };
    const r = spawnSync(process.execPath, [HOOKS_BUNDLE, 'containment-guard'], {
      input: JSON.stringify(payload),
      env: runEnv,
      cwd: project,
      encoding: 'utf8',
      timeout: 20_000,
    });
    if (r.error) throw r.error;
    assert.equal(r.status, 0, r.stderr);
    if (r.stdout.trim() === '') return null;
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    return out.hookSpecificOutput.permissionDecisionReason;
  }

  it('control: a write inside the worktree is allowed', () => {
    assert.equal(run(`echo x > ${wt}/src/t1912.out`), null);
  });

  it('allows $TMPDIR/… and ${TMPDIR}/… with no hook TMPDIR and the sandbox on', () => {
    assert.equal(run('echo x > "$TMPDIR/t1912.out"'), null);
    assert.equal(run('echo x > "${TMPDIR}/t1912.out"'), null);
  });

  it('denies $TMPDIR/.. with no hook TMPDIR, judged under /tmp/claude-<uid>', () => {
    const reason = run('echo x > "$TMPDIR/../x1912"');
    assert.ok(reason?.startsWith(`BLOCKED: containment — /tmp/claude-${FAKE_UID}/../x1912 is outside`), String(reason));
  });

  it('denies ${TMPDIR:-/tmp}/… marked dangerouslyDisableSandbox, as /tmp/…', () => {
    const reason = run('echo x > "${TMPDIR:-/tmp}/t1912.out"', { disableSandbox: true });
    assert.ok(reason?.startsWith('BLOCKED: containment — /tmp/t1912.out is outside'), String(reason));
  });

  it('denies $TMPDIR/… marked dangerouslyDisableSandbox', () => {
    assert.notEqual(run('echo x > "$TMPDIR/t1912.out"', { disableSandbox: true }), null);
  });

  it('denies /tmp/other1912', () => {
    const reason = run('echo x > /tmp/other1912');
    assert.ok(reason?.startsWith('BLOCKED: containment — /tmp/other1912 is outside'), String(reason));
  });

  it('denies $HOME/x1912', () => {
    const reason = run('echo x > "$HOME/x1912"');
    assert.ok(reason?.startsWith(`BLOCKED: containment — ${home}/x1912 is outside`), String(reason));
  });

  it('with a hook TMPDIR, judges under it as today', () => {
    assert.equal(run('echo x > "$TMPDIR/t1912.out"', { tmpdir: hostTmp }), null);
    assert.equal(run('echo x > "$TMPDIR/t1912.out"', { tmpdir: hostTmp, disableSandbox: true }), null);
    const reason = run('echo x > "$TMPDIR/../x1912"', { tmpdir: hostTmp });
    assert.ok(reason?.startsWith(`BLOCKED: containment — ${hostTmp}/../x1912 is outside`), String(reason));
    assert.ok(run('echo x > /tmp/other1912', { tmpdir: hostTmp })?.startsWith('BLOCKED: containment — /tmp/other1912'));
  });
});
