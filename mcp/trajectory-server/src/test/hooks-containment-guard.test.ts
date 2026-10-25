/**
 * The TypeScript containment-guard gate (GH 1692) where it is stricter than
 * scripts/hooks/containment-guard.sh: an analyzer line `UNRESOLVED:$(parse):…`
 * or `UNRESOLVED:$(computed):…` is always denied, even when its raw text
 * starts with a literal path inside the root (which the .sh's literal-dir
 * allowance would let through). Everything else is the parity corpus's job.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { containmentGuard, containmentGuardWith, type WritePathsFn } from '../hooks/containment-guard.js';
import { findGate } from '../hooks/registry.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const FAKE_UID = 4242424;

const PARSE_TEXT = 'the command could not be parsed, so its write targets are unknown; split it or fix its quoting.';
const COMPUTED_TEXT =
  'the program builds the path at run time (a computed or argv path, a program held in a variable, a substitution or stdin, or an exec placeholder under `sh -c`), so the guard cannot tell where it writes; write to a literal path.';

function reason(stdout: string): string | null {
  if (stdout === '') return null;
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

describe('containment-guard (TS): $(parse) and $(computed) always deny', () => {
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

  it('denies a real analyzer $(parse): an unclosed quote after cd into the root', async () => {
    const command = `cd ${project}/src && echo "x > a`;
    const r = await containmentGuard(bash(command), env);
    const raw = [...command].slice(0, 80).join('');
    assert.equal(reason(r.stdout), `BLOCKED: write target "${raw}" cannot be judged: ${PARSE_TEXT}`);
  });

  it('a bare in-root redirect still passes, so the denials above are the reasons, not the paths', async () => {
    const r = await containmentGuard(bash(`echo x > ${project}/src/a`), env);
    assert.deepEqual(r, { stdout: '', code: 0 });
  });
});
