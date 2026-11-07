/**
 * containment-guard (TS) and mktemp scratch paths (GH 1912 part 3): a
 * substitution whose whole text is an allowlisted mktemp call (flags only -d,
 * -q, `-t <prefix>`, at most one template) resolves to the path mktemp prints,
 * so a sandboxed swe write into `$(mktemp -d)` lands under /tmp/claude-<uid>;
 * `${NAME:-def}` for a name envVar knows reads the run env first, as bash does.
 * Runs the real `node dist/hooks.js containment-guard` with a fake uid, and
 * the write-path analyzer directly.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { writePaths } from '../hooks/cmd-analysis/index.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const FAKE_UID = 4242424;
const HARNESS_TMP = `/tmp/claude-${FAKE_UID}`;
const NOW = '2026-11-07T10:00:00.000Z';

describe('containment-guard (TS): mktemp scratch paths and env-backed defaults (GH 1912)', () => {
  let sandbox: string;
  let project: string;
  let wt: string;
  let home: string;
  let transcript: string;
  let env: NodeJS.ProcessEnv;

  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'tmb-cg-mktemp-'));
    project = join(sandbox, 'project');
    wt = join(project, '.claude/worktrees/cg-task');
    home = join(sandbox, 'home');
    const db = join(project, '.claude/tmb/trajectory.db');
    for (const dir of [join(wt, 'src'), dirname(db), home, join(sandbox, 'cache'), join(sandbox, 'cc')]) {
      mkdirSync(dir, { recursive: true });
    }
    const d = new DatabaseSync(db);
    d.exec(readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8'));
    d.prepare('INSERT INTO repos (name, path) VALUES (?, ?)').run('project', project);
    d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (7, 'mktemp', 'open', ?, ?)").run(NOW, NOW);
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

  function run(command: string, opts: { disableSandbox?: boolean } = {}): string | null {
    const toolInput: Record<string, unknown> = { command };
    if (opts.disableSandbox) toolInput.dangerouslyDisableSandbox = true;
    const payload = {
      hook_event_name: 'PreToolUse',
      session_id: 'mktemp-test',
      cwd: wt,
      tool_name: 'Bash',
      tool_input: toolInput,
      agent_type: 'tmb:swe',
      agent_transcript_path: transcript,
    };
    const r = spawnSync(process.execPath, [HOOKS_BUNDLE, 'containment-guard'], {
      input: JSON.stringify(payload),
      env,
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

  function deniedOutside(command: string, path: string, opts: { disableSandbox?: boolean } = {}): void {
    const reason = run(command, opts) ?? '';
    assert.ok(reason.startsWith(`BLOCKED: containment — ${path} is outside`), `${command}: ${reason}`);
    assert.ok(reason.includes('/scratch/') && reason.includes(`(or ${HARNESS_TMP})`), `${command}: no scratch root in ${reason}`);
  }

  function unjudged(command: string, opts: { disableSandbox?: boolean } = {}): void {
    const reason = run(command, opts) ?? '';
    assert.ok(reason.startsWith('BLOCKED: write target ') && reason.includes('cannot be judged:'), `${command}: ${reason}`);
  }

  const NO_TEMPLATE = [
    'T=$(mktemp -d); echo x > "$T/f"',
    'F=$(mktemp); echo x > "$F"',
    'cat > "$(mktemp)" < /dev/null',
    'T=`mktemp -d -t s`; echo x > "$T/f"',
  ];

  it('allows writes into a sandboxed mktemp path with no hook TMPDIR', () => {
    for (const cmd of [...NO_TEMPLATE, 'D=$(mktemp -d "$TMPDIR/w.XXXXXX"); echo x > "$D/f"']) assert.equal(run(cmd), null, cmd);
  });

  it('denies a mktemp path climbed out of with ..', () => {
    deniedOutside('T=$(mktemp -d); echo x > "$T/../../x"', `${HARNESS_TMP}/tmp.XXXXXXXX/../../x`);
  });

  it('denies a template outside the scratch roots', () => {
    deniedOutside('D=$(mktemp -d /tmp/other/w.XXXXXX); echo x > "$D/f"', '/tmp/other/w.XXXXXX/f');
    deniedOutside('D=$(mktemp -d "$HOME/w.XXXXXX"); echo x > "$D/f"', `${home}/w.XXXXXX/f`);
  });

  it("denies a template under another session's scratchpad", () => {
    const uid = process.getuid?.() ?? 0;
    assert.notEqual(uid, FAKE_UID);
    const other = `/tmp/claude-${uid}/-other-project/other-session/scratchpad/w.XXXXXX`;
    deniedOutside(`D=$(mktemp -d ${other}); echo x > "$D/f"`, `${other}/f`);
  });

  it('denies mktemp shapes off the allowlist as a substitution it cannot judge', () => {
    unjudged('T=$(mktemp -d -p /etc); echo x > "$T/f"');
    unjudged('T=$(mktemp -d | cat); echo x > "$T/f"');
  });

  it('denies the no-template forms marked dangerouslyDisableSandbox with no hook TMPDIR', () => {
    for (const cmd of NO_TEMPLATE) unjudged(cmd, { disableSandbox: true });
  });

  it('reads ${TMPDIR:-/tmp} from the run env: allowed sandboxed, /tmp marked dangerouslyDisableSandbox', () => {
    assert.equal(run('echo x > "${TMPDIR:-/tmp}/f"'), null);
    deniedOutside('echo x > "${TMPDIR:-/tmp}/f"', '/tmp/f', { disableSandbox: true });
  });

  it('reads ${HOME:-/w} from the run env and keeps the default for a name envVar does not know', () => {
    deniedOutside('echo x > "${HOME:-/w}/x"', `${home}/x`);
    deniedOutside('echo x > "${FOO:-/w}/x"', '/w/x');
  });
});

describe('write-path analyzer: mktemp substitutions (GH 1912)', () => {
  const env = { HOME: '/h', TMPDIR: '/t/' };
  const paths = (cmd: string, e: NodeJS.ProcessEnv = env): Promise<string[]> => writePaths(cmd, { cwd: '/w', raw: false, root: '/w', env: e });

  it('resolves each allowlisted shape, quoted, unquoted, in backticks or a loop list', async () => {
    const cases: [string, string[]][] = [
      ['T=$(mktemp -d); touch "$T/f"', ['/t/tmp.XXXXXXXX/f']],
      ['T=$(mktemp -q -d -t pre.x); touch $T/f', ['/t/pre.x.XXXXXXXX/f']],
      ['touch $(mktemp)', ['/t/tmp.XXXXXXXX']],
      ['touch "$(mktemp -d)/a" "$(mktemp -d)/b"', ['/t/tmp.XXXXXXXX/a', '/t/tmp.XXXXXXXX/b']],
      ['T=$(mktemp -d w.XXX); touch $T/f', ['/w/w.XXX/f']],
      ['cd /a && T=$(mktemp -d ../w.XXX); touch $T/f', ['/w.XXX/f']],
      ["T=$(mktemp -d '/s/w.XXXX'); touch $T/f", ['/s/w.XXXX/f']],
      ['for d in $(mktemp -d); do touch $d/f; done', ['/t/tmp.XXXXXXXX/f']],
    ];
    for (const [cmd, want] of cases) assert.deepEqual(await paths(cmd), want, cmd);
  });

  it('fails closed on every other substitution text', async () => {
    for (const cmd of [
      'T=$(mktemp -u); touch $T/f',
      'T=$(mktemp -d -p /etc); touch $T/f',
      'T=$(mktemp --tmpdir); touch $T/f',
      'T=$(mktemp -dq); touch $T/f',
      'T=$(mktemp -t s w.XXX); touch $T/f',
      'T=$(mktemp -t "a b"); touch $T/f',
      'T=$(mktemp -t); touch $T/f',
      'T=$(mktemp w.XXX -d); touch $T/f',
      'T=$(mktemp a.XXX b.XXX); touch $T/f',
      'T=$(mktemp -d /s/w.XX); touch $T/f',
      'T=$(mktemp -d /s/w.XXX/); touch $T/f',
      'T=$(mktemp -d "/s s/w.XXX"); touch $T/f',
      'T=$(mktemp -d /s/*.XXX); touch $T/f',
      'T=$(mktemp -d ~/w.XXX); touch $T/f',
      'T=$(mktemp -d $(pwd)/w.XXX); touch $T/f',
      'T=$(mktemp -d $NOPE/w.XXX); touch $T/f',
      'T=$(mktemp -d; true); touch $T/f',
      'T=$(mktemp -d | cat); touch $T/f',
      'T=$(TMPDIR=/etc mktemp -d); touch $T/f',
      'T=$(/usr/bin/mktemp -d); touch $T/f',
      'TMPDIR=/etc; T=$(mktemp -d); touch $T/f',
      "T='$(mktemp)'; touch $T",
      'T="\\$(mktemp)"; touch $T',
      'T=\x18; touch $T/$(mktemp)',
    ]) {
      const got = await paths(cmd);
      assert.ok(got.length > 0 && got.every((l) => l.startsWith('UNRESOLVED:')), `${cmd}: ${JSON.stringify(got)}`);
      assert.ok(got.every((l) => !l.includes('\x18')), `${cmd}: mark leaked: ${JSON.stringify(got)}`);
    }
  });

  it('fails closed with no absolute TMPDIR', async () => {
    for (const e of [{ HOME: '/h' }, { HOME: '/h', TMPDIR: 'rel' }]) {
      assert.deepEqual(await paths('T=$(mktemp -d); touch $T/f', e), ['UNRESOLVED:T:$T/f']);
      assert.deepEqual(await paths('touch "$(mktemp)"', e), ['UNRESOLVED:$():$(mktemp)']);
    }
  });

  it('keeps the frozen output of a quoted mktemp the allowlist rejects', async () => {
    assert.deepEqual(await paths('touch "$(mktemp -u)"'), ['UNRESOLVED:$():$(mktemp -u)']);
  });
});

describe('write-path analyzer: ${NAME:-def} reads the run env for envVar names (GH 1912)', () => {
  const paths = (cmd: string, env: NodeJS.ProcessEnv): Promise<string[]> => writePaths(cmd, { cwd: '/w', raw: false, root: '/w', env });

  it('takes the env value when bash would, else the default', async () => {
    const env = { HOME: '/h', TMPDIR: '', CLAUDE_PROJECT_DIR: '/p', TMB_MODEL_CACHE_DIR: '/m' };
    const cases: [string, string][] = [
      ['touch ${HOME:-/d}/x', '/h/x'],
      ['touch ${HOME:=/d}/x', '/h/x'],
      ['touch ${HOME-/d}/x', '/h/x'],
      ['touch ${CLAUDE_PROJECT_DIR:-/d}/x', '/p/x'],
      ['touch ${TMB_MODEL_CACHE_DIR:-/d}/x', '/m/x'],
      ['touch ${PWD:-/d}/x', '/w/x'],
      ['touch ${TMPDIR:-/d}/x', '/d/x'],
      ['touch ${TMPDIR-/d}x', '/w/x'],
      ['touch ${FOO:-/d}/x', '/d/x'],
      ['H=/k; touch ${H:-/d}/x', '/k/x'],
      ['HOME=/k; touch ${HOME:-/d}/x', '/k/x'],
    ];
    for (const [cmd, want] of cases) assert.deepEqual(await paths(cmd, env), [want], cmd);
  });

  it('takes the default for an unset name and fails closed on an unknown PWD or OLDPWD', async () => {
    assert.deepEqual(await paths('touch ${TMB_MODEL_CACHE_DIR:-/d}/x', { HOME: '/h' }), ['/d/x']);
    assert.deepEqual(await paths('touch ${HOME-/d}/x', {}), ['/d/x']);
    assert.deepEqual(await paths('touch ${OLDPWD:-/d}/x', { HOME: '/h' }), ['UNRESOLVED:OLDPWD:${OLDPWD:-/d}/x']);
  });

  it('reads ${NAME=def} like ${NAME-def} (GH 2440)', async () => {
    const env = { HOME: '/h' };
    const cases: [string, string][] = [
      ['touch ${HOME=/d}/x', '/h/x'],
      ['touch "${HOME=/d}/x"', '/h/x'],
      ['touch ${FOO=/d}/x', '/d/x'],
      ['FOO=/k; touch ${FOO=/d}/x', '/k/x'],
    ];
    for (const [cmd, want] of cases) assert.deepEqual(await paths(cmd, env), [want], cmd);
  });

  it('never resolves a later use of a ${NAME=def} name to another value (GH 2440)', async () => {
    const env = { HOME: '/h' };
    for (const [cmd, want] of [
      ['touch ${FOO=/d}/x; touch $FOO/y', ['/d/x', 'UNRESOLVED:FOO:$FOO/y']],
      ['touch ${HOME=/d}/x; touch $HOME/y', ['/h/x', 'UNRESOLVED:HOME:$HOME/y']],
      ['touch ${TMB_MODEL_CACHE_DIR=/d}/x; touch $TMB_MODEL_CACHE_DIR/y', ['/d/x', 'UNRESOLVED:TMB_MODEL_CACHE_DIR:$TMB_MODEL_CACHE_DIR/y']],
      ['touch ${FOO=/d}/x $FOO/y', ['UNRESOLVED:FOO:${FOO=/d}/x', 'UNRESOLVED:FOO:$FOO/y']],
      ['touch ${FOO=/d}/x ${FOO=/e}/y', ['UNRESOLVED:FOO:${FOO=/d}/x', 'UNRESOLVED:FOO:${FOO=/e}/y']],
      ['for i in 1 2; do touch $FOO/y; touch ${FOO=/d}/x; done', ['UNRESOLVED:FOO:$FOO/y', 'UNRESOLVED:FOO:${FOO=/d}/x']],
      ['X=${FOO=/d}; touch $X', ['UNRESOLVED:X:$X']],
    ] as [string, string[]][]) {
      assert.deepEqual(await paths(cmd, env), want, cmd);
    }
  });
});
