/**
 * The TypeScript containment-guard gate (GH 1692) where it is stricter than
 * scripts/hooks/containment-guard.sh: an analyzer line `UNRESOLVED:$(parse):…`
 * or `UNRESOLVED:$(computed):…` is always denied, even when its raw text
 * starts with a literal path inside the root (which the .sh's literal-dir
 * allowance would let through). Everything else is the parity corpus's job.
 * The deny's phrase is pinned to dispatch.sh's UNJUDGED_PHRASE, which keeps
 * such a deny from recording boundary-deny paths (GH 1750); the deny of a
 * target behind a variable, substitution or cd the guard cannot resolve
 * carries it too (GH 1772). A python target name rebound at top level is
 * judged at every literal it is bound to (GH 1756). A loop body's later
 * assignment reaches an earlier use in it (GH 1944).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  containmentGuard,
  containmentGuardWith,
  NEVER_JUDGED,
  UNJUDGED_PHRASE,
  type WritePathsFn,
} from '../hooks/containment-guard.js';
import { findGate } from '../hooks/registry.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const FAKE_UID = 4242424;

const DISPATCH = readFileSync(join(SERVER_ROOT, '../../scripts/hooks/dispatch.sh'), 'utf8');

/** dispatch.sh's unjudged_deny run on <reason>: true when it records no boundary-deny path. */
function unjudgedDeny(reason: string): boolean {
  const fn = DISPATCH.match(/^unjudged_deny\(\) \{\n[\s\S]*?\n\}$/m);
  assert.ok(fn, 'dispatch.sh defines unjudged_deny');
  try {
    execFileSync('bash', ['-c', `UNJUDGED_PHRASE='${UNJUDGED_PHRASE}'\n${fn[0]}\nunjudged_deny "$1"`, '_', reason]);
    return true;
  } catch {
    return false;
  }
}

const PARSE_TEXT = 'the command could not be parsed, so its write targets are unknown; split it or fix its quoting.';
const COMPUTED_TEXT =
  'the program builds the path at run time (a computed or argv path, a program held in a variable, a substitution or stdin, or an exec placeholder under `sh -c`), so the guard cannot tell where it writes; use Edit or Write on the literal path, or a Bash command whose write target is a literal path.';
const UNPROVEN_TEXT =
  'the inline program is unproven: it calls something the guard can neither prove read-only nor judge as a write (an unlisted call, a callable held in a name, dynamic attribute access), or the shell fills in part of its text or command word, so the guard cannot tell what it writes; use Edit or Write, a plain read-only one-liner, or a script file.';

function reason(stdout: string): string | null {
  if (stdout === '') return null;
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

describe('containment-guard (TS): denies that judge no path', () => {
  let sandbox: string;
  let project: string;
  let db: string;
  let env: NodeJS.ProcessEnv;
  const realGetuid = process.getuid;

  before(() => {
    process.getuid = () => FAKE_UID;
    sandbox = mkdtempSync(join(tmpdir(), 'tmb-cg-unit-'));
    project = join(sandbox, 'project');
    db = join(project, '.claude/tmb/trajectory.db');
    mkdirSync(join(project, 'src'), { recursive: true });
    mkdirSync(dirname(db), { recursive: true });
    const d = new DatabaseSync(db);
    d.exec(SCHEMA);
    d.close();
    env = {
      PATH: process.env.PATH,
      HOME: join(sandbox, 'home'),
      CLAUDE_PROJECT_DIR: project,
      CLAUDE_CONFIG_DIR: join(sandbox, 'cc'),
      TMB_MODEL_CACHE_DIR: join(sandbox, 'cache'),
      TMPDIR: join(sandbox, 'host-tmp'),
    };
  });

  after(() => {
    process.getuid = realGetuid;
    rmSync(sandbox, { recursive: true, force: true });
  });

  const bash = (command: string) =>
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: project, tool_input: { command } });

  const lines = (...out: string[]): WritePathsFn => async () => out;

  function denials(): { summary: string; content: string }[] {
    const d = new DatabaseSync(db, { readOnly: true });
    try {
      return d
        .prepare("SELECT summary, content_json AS content FROM audit WHERE event_type = 'containment_denied' ORDER BY id")
        .all() as { summary: string; content: string }[];
    } finally {
      d.close();
    }
  }

  it('the registry runs this gate under containment-guard', () => {
    assert.equal(findGate('containment-guard'), containmentGuard);
  });

  it('control: another unresolved variable behind an in-root literal dir is allowed', async () => {
    const raw = `${project}/src/$OUT`;
    const r = await containmentGuardWith(lines(`UNRESOLVED:OUT:${raw}`))(bash('x'), env);
    assert.deepEqual(r, { stdout: '', code: 0 });
  });

  it('denies $(parse) whose raw text starts with an in-root literal path', async () => {
    const raw = `${project}/src/a "unterminated`;
    const before = denials().length;
    const r = await containmentGuardWith(lines(`UNRESOLVED:$(parse):${raw}`))(bash('x'), env);
    assert.equal(r.code, 0);
    assert.equal(reason(r.stdout), `BLOCKED: write target "${raw}" cannot be judged: ${PARSE_TEXT}`);
    const rows = denials();
    assert.equal(rows.length, before + 1, 'one containment_denied row');
    assert.equal(rows.at(-1)?.summary, `Bash denied: ${raw} is outside ${project}`);
    assert.deepEqual(JSON.parse(rows.at(-1)?.content ?? ''), { tool: 'Bash', path: raw, root: project, task_id: null });
  });

  it('denies $(computed) whose raw text starts with an in-root literal path', async () => {
    const raw = `${project}/src/$(computed)`;
    const r = await containmentGuardWith(lines(`UNRESOLVED:$(computed):${raw}`))(bash('x'), env);
    assert.equal(reason(r.stdout), `BLOCKED: write target "${raw}" cannot be judged: ${COMPUTED_TEXT}`);
  });

  it('denies $(computed) even when the raw text holds no variable at all', async () => {
    const raw = `${project}/src/out.txt`;
    const r = await containmentGuardWith(lines(`UNRESOLVED:$(computed):${raw}`))(bash('x'), env);
    assert.equal(reason(r.stdout), `BLOCKED: write target "${raw}" cannot be judged: ${COMPUTED_TEXT}`);
  });

  it('denies $(unproven) naming the program as unproven, even with no path in its text (GH 1739)', async () => {
    const raw = "import os; os.chmod('src/a', 0o777)";
    const r = await containmentGuardWith(lines(`UNRESOLVED:$(unproven):${raw}`))(bash('x'), env);
    assert.equal(reason(r.stdout), `BLOCKED: write target "${raw}" cannot be judged: ${UNPROVEN_TEXT}`);
  });

  it('denies a real analyzer $(unproven): a python call outside the safe set inside the root (GH 1739)', async () => {
    const r = await containmentGuard(bash(`cd ${project}/src && python3 -c "import os; os.chmod('a', 0o777)"`), env);
    assert.equal(reason(r.stdout), `BLOCKED: write target "import os; os.chmod('a', 0o777)" cannot be judged: ${UNPROVEN_TEXT}`);
  });

  it('denies a real analyzer $(parse): an unclosed quote after cd into the root', async () => {
    const command = `cd ${project}/src && echo "x > a`;
    const r = await containmentGuard(bash(command), env);
    const raw = [...command].slice(0, 80).join('');
    assert.equal(reason(r.stdout), `BLOCKED: write target "${raw}" cannot be judged: ${PARSE_TEXT}`);
  });

  it('allows a python heredoc whose target name is rebound at top level to in-root literals (GH 1756)', async () => {
    const command = "python3 - <<'EOF'\np = 'src/a.ts'\nopen(p, 'w').write('x')\np = 'src/b.ts'\nopen(p, 'w').write('y')\nEOF";
    assert.deepEqual(await containmentGuard(bash(command), env), { stdout: '', code: 0 });
  });

  it('denies a python target name rebound at top level to an outside literal (GH 1756)', async () => {
    const r = await containmentGuard(bash(`python3 -c "p='a'; p='/etc/x'; open(p,'w')"`), env);
    assert.match(reason(r.stdout) ?? '', /\/etc\/x/);
  });

  it('denies as cannot be judged a python target name walrus-bound in an annotation string (GH 1756)', async () => {
    const command = `python3 - <<'EOF'\nimport typing\np = 'src/a.txt'\ndef f(x: '(p := chr(47) + "etc/x")'): pass\ntyping.get_type_hints(f)\nopen(p, 'w').write('x')\nEOF`;
    const r = await containmentGuard(bash(command), env);
    assert.equal(reason(r.stdout), `BLOCKED: write target "python3" cannot be judged: ${COMPUTED_TEXT}`);
  });

  it("dispatch.sh's UNJUDGED_PHRASE is the deny's phrase, and no reason text holds the quote it stops at", () => {
    assert.deepEqual(DISPATCH.match(/^UNJUDGED_PHRASE='([^']*)'$/gm), [`UNJUDGED_PHRASE='${UNJUDGED_PHRASE}'`]);
    assert.deepEqual(Object.keys(NEVER_JUDGED).sort(), ['$(computed)', '$(parse)', '$(unproven)']);
    for (const text of Object.values(NEVER_JUDGED)) assert.ok(!text.includes('"'), text);
  });

  for (const variable of ['$(proc)', '$(alias-write)', '$()', 'PWD', '', 'OUT']) {
    it(`an unresolved ${variable || "''"} target outside the root is denied as unjudged (GH 1772)`, async () => {
      const raw = '/etc/tmb-cg/$OUT';
      const r = await containmentGuardWith(lines(`UNRESOLVED:${variable}:${raw}`))(bash('x'), env);
      const why = reason(r.stdout) ?? '';
      assert.ok(why.startsWith(`BLOCKED: write target "${raw}" ${UNJUDGED_PHRASE} `), why);
      assert.ok(unjudgedDeny(why), `dispatch.sh records paths for: ${why}`);
    });
  }

  it('a judged deny of a literal target outside the root is not unjudged', async () => {
    const r = await containmentGuard(bash('echo x > /etc/tmb-cg/a'), env);
    const why = reason(r.stdout) ?? '';
    assert.ok(!why.includes(UNJUDGED_PHRASE), why);
    assert.equal(unjudgedDeny(why), false);
  });

  it('a bare in-root redirect still passes, so the denials above are the reasons, not the paths', async () => {
    const r = await containmentGuard(bash(`echo x > ${project}/src/a`), env);
    assert.deepEqual(r, { stdout: '', code: 0 });
  });

  for (const head of ['while :', 'until false', 'for i in 1 2']) {
    it(`denies a write through $x before a later in-body x=/etc/p1944 under \`${head}\` (GH 1944)`, async () => {
      const r = await containmentGuard(bash(`x=${project}/src/a; ${head}; do echo > $x; x=/etc/p1944; done`), env);
      assert.match(reason(r.stdout) ?? '', /\/etc\/p1944/);
    });
  }

  it('denies a nested-loop use and an in-body read it cannot name (GH 1944)', async () => {
    const nested = await containmentGuard(bash(`x=${project}/src/a; while :; do while :; do echo > $x; done; x=/etc/p1944; done`), env);
    assert.match(reason(nested.stdout) ?? '', /\/etc\/p1944/);
    const read = await containmentGuard(bash(`x=${project}/src/a; while :; do echo > $x; read -r x; done`), env);
    assert.ok((reason(read.stdout) ?? '').includes(UNJUDGED_PHRASE), read.stdout);
  });

  for (const body of [
    'for ((i=0;i<2;i++)) { echo > $x; x=/etc/p1944; }',
    'for i in 1 2; { echo > $x; x=/etc/p1944; }',
    'select i in 1 2; { echo > $x; x=/etc/p1944; }',
    'while :; do coproc for i in 1; do :; done; echo > $x; x=/etc/p1944; done',
  ]) {
    it(`denies a braced or coproc-nested loop body: \`${body}\` (GH 1944)`, async () => {
      const r = await containmentGuard(bash(`x=${project}/src/a; ${body}`), env);
      assert.ok(reason(r.stdout), r.stdout);
    });
  }

  it('allows a for-loop and a loop that never reassigns when every target is under the root (GH 1944)', async () => {
    assert.deepEqual(await containmentGuard(bash(`for f in a b; do x=${project}/src/$f; echo > $x; done`), env), { stdout: '', code: 0 });
    assert.deepEqual(await containmentGuard(bash(`x=${project}/src/a; while :; do echo > $x; done`), env), { stdout: '', code: 0 });
  });
});
