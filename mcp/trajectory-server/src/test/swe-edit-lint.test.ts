/**
 * swe-edit-lint (GH 2570): a swe Write, Edit or MultiEdit runs the repo's
 * .config/tmb/edit-lint.json lints on the edited file, blocking on a failure
 * and staying silent otherwise; `**` and `*` globs match dot paths, a command
 * past the budget is killed with a note, and a malformed config gives a note.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { after, before, describe, it } from 'node:test';
import type { GateResult } from '../hooks/gate.js';
import { runWithDeadline } from '../hooks/lib/deadline.js';
import { endsWithFix } from '../hooks/lib/deny.js';
import { findGate, ROUTER_GROUPS, routerGates } from '../hooks/registry.js';
import { EDIT_LINT_FILE, parseEditLint, sweEditLint } from '../hooks/swe-edit-lint.js';

const MARKER_CMD = '! grep -n BAD';
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function post(tool: string, filePath: string | undefined, extra: object = { agent_id: 'a1', agent_type: 'tmb:swe' }): string {
  return JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', cwd: '/', tool_name: tool, tool_input: filePath === undefined ? {} : { file_path: filePath, content: 'x' }, tool_response: {}, ...extra });
}

function makeRepo(root: string, name: string, config: string | null): string {
  const repo = join(root, name);
  mkdirSync(join(repo, '.config/tmb'), { recursive: true });
  execFileSync('git', ['init', '-q', repo], { env: { ...process.env, ...GIT_ENV } });
  if (config !== null) writeFileSync(join(repo, EDIT_LINT_FILE), config);
  return repo;
}

function block(r: GateResult): { decision: string; reason: string } {
  const out = JSON.parse(r.stdout) as { decision: string; reason: string };
  assert.equal(out.decision, 'block');
  return out;
}

function noteOf(r: GateResult): string {
  const out = JSON.parse(r.stdout) as { decision?: string; hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(out.decision, undefined);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /\n/);
  return out.hookSpecificOutput.additionalContext;
}

describe('swe-edit-lint (GH 2570)', () => {
  let root: string;
  let repo: string;
  const env = { ...process.env, ...GIT_ENV };

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-edit-lint-test-')));
    repo = makeRepo(root, 'repo', JSON.stringify({ version: 1, lints: [{ glob: '**/*.txt', command: MARKER_CMD }] }));
    mkdirSync(join(repo, 'sub dir'), { recursive: true });
    writeFileSync(join(repo, 'good.txt'), 'fine\n');
    writeFileSync(join(repo, 'sub dir/bad.txt'), 'line one\nBAD here\n');
    writeFileSync(join(repo, 'code.ts'), 'BAD\n');
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('blocks a swe Write of a matching file that fails the lint, with the command, exit code and output', async () => {
    const r = await sweEditLint(post('Write', join(repo, 'sub dir/bad.txt')), env);
    const { reason } = block(r);
    assert.match(reason, /! grep -n BAD "sub dir\/bad\.txt"/);
    assert.match(reason, /exited 1/);
    assert.match(reason, /2:BAD here/);
    assert.ok(endsWithFix(reason), reason);
  });

  it('blocks an Edit and a MultiEdit too', async () => {
    for (const tool of ['Edit', 'MultiEdit']) block(await sweEditLint(post(tool, join(repo, 'sub dir/bad.txt')), env));
  });

  it('allows a passing file, a non-matching glob, a relative or missing file_path, a non-swe role and another tool', async () => {
    const cases: [string, string][] = [
      ['passing file', post('Write', join(repo, 'good.txt'))],
      ['non-matching glob', post('Write', join(repo, 'code.ts'))],
      ['relative file_path', post('Write', 'sub dir/bad.txt')],
      ['missing file_path', post('Write', undefined)],
      ['bro (no agent_type)', post('Write', join(repo, 'sub dir/bad.txt'), {})],
      ['code-reviewer', post('Write', join(repo, 'sub dir/bad.txt'), { agent_type: 'tmb:code-reviewer' })],
      ['NotebookEdit', post('NotebookEdit', join(repo, 'sub dir/bad.txt'))],
      ['unparseable payload', 'not json'],
    ];
    for (const [what, payload] of cases) assert.deepEqual(await sweEditLint(payload, env), { stdout: '', code: 0 }, what);
  });

  it('allows a repo with no edit-lint.json and a file outside any git checkout', async () => {
    const bare = makeRepo(root, 'no-config', null);
    writeFileSync(join(bare, 'bad.txt'), 'BAD\n');
    assert.deepEqual(await sweEditLint(post('Write', join(bare, 'bad.txt')), env), { stdout: '', code: 0 });
    const outside = join(realpathSync(mkdtempSync(join(tmpdir(), 'tmb-edit-lint-nogit-'))), 'bad.txt');
    try {
      writeFileSync(outside, 'BAD\n');
      assert.deepEqual(await sweEditLint(post('Write', outside), env), { stdout: '', code: 0 });
    } finally {
      rmSync(join(outside, '..'), { recursive: true, force: true });
    }
  });

  it('runs only the matching entries, in order, stopping at the first failure', async () => {
    const r2 = makeRepo(
      root,
      'ordered',
      JSON.stringify({
        version: 1,
        lints: [
          { glob: '**/*.ts', command: 'exit 9 #' },
          { glob: '*.md', command: 'echo first-ran; exit 3 #' },
          { glob: '**/*.md', command: 'echo second-ran; exit 4 #' },
        ],
      }),
    );
    writeFileSync(join(r2, 'a.md'), 'x\n');
    const { reason } = block(await sweEditLint(post('Write', join(r2, 'a.md')), env));
    assert.match(reason, /exited 3/);
    assert.match(reason, /first-ran/);
    assert.doesNotMatch(reason, /second-ran/);
  });

  it('matches a dot path such as .github/.foo.yml with a **/* glob (F641-1)', async () => {
    const dots = makeRepo(root, 'dots', JSON.stringify({ version: 1, lints: [{ glob: '**/*', command: 'echo dot-path-linted; exit 5 #' }] }));
    mkdirSync(join(dots, '.github'), { recursive: true });
    writeFileSync(join(dots, '.github/.foo.yml'), 'x: 1\n');
    const { reason } = block(await sweEditLint(post('Write', join(dots, '.github/.foo.yml')), env));
    assert.match(reason, /`echo dot-path-linted; exit 5 # "\.github\/\.foo\.yml"` \(\.config\/tmb\/edit-lint\.json, glob \*\*\/\*\) exited 5/);
    assert.match(reason, /dot-path-linted/);
  });

  it('hands the path to the command as one literal word that bash never parses', async () => {
    const odd = makeRepo(root, 'odd', JSON.stringify({ version: 1, lints: [{ glob: '*.txt', command: "f() { printf 'seen=[%s] n=%s\\n' \"$1\" \"$#\"; exit 6; }; f" }] }));
    const name = '$(touch pwned) a;b"c`touch pwned2`.txt';
    writeFileSync(join(odd, name), 'x\n');
    const { reason } = block(await sweEditLint(post('Write', join(odd, name)), env));
    assert.ok(reason.includes(`seen=[${name}] n=1`), reason);
    assert.equal(existsSync(join(odd, 'pwned')), false);
    assert.equal(existsSync(join(odd, 'pwned2')), false);
  });

  it('kills a command past the budget and gives a note, not a block, inside the deadline', async () => {
    const slow = makeRepo(root, 'slow', JSON.stringify({ version: 1, lints: [{ glob: '*.txt', command: 'sleep 30; false #' }] }));
    writeFileSync(join(slow, 'a.txt'), 'x\n');
    const { value, expired } = await runWithDeadline(performance.now() + 1500, () =>
      sweEditLint(post('Write', join(slow, 'a.txt')), env),
    );
    assert.equal(expired, false, 'it returned inside the deadline, so the router keeps the note for swe');
    assert.match(noteOf(value), /was killed at the \d+ ms of budget left; .*nothing blocked/);
  });

  it('a malformed config gives a one-line note and no block', async () => {
    const configs: [string, RegExp][] = [
      ['{not json', /not valid JSON/],
      ['[]', /must be a JSON object/],
      [JSON.stringify({ version: 2, lints: [] }), /version must be 1, got 2/],
      [JSON.stringify({ version: 1, lints: [{ glob: '*.txt' }] }), /lints must be an array/],
      [JSON.stringify({ version: 1 }), /lints must be an array/],
    ];
    for (const [i, [config, want]] of configs.entries()) {
      const bad = makeRepo(root, `malformed-${i}`, config);
      writeFileSync(join(bad, 'a.txt'), 'BAD\n');
      const ctx = noteOf(await sweEditLint(post('Write', join(bad, 'a.txt')), env));
      assert.match(ctx, /^TMB: swe-edit-lint: \.config\/tmb\/edit-lint\.json: /);
      assert.match(ctx, want, config);
    }
  });

  it('parseEditLint accepts an empty lints list and keeps only glob and command', () => {
    assert.deepEqual(parseEditLint(JSON.stringify({ version: 1, lints: [] })), { lints: [] });
    assert.deepEqual(parseEditLint(JSON.stringify({ version: 1, lints: [{ glob: 'a', command: 'b', x: 1 }] })), { lints: [{ glob: 'a', command: 'b' }] });
  });

  it('is registered: the GATES map and an advisory PostToolUse Write|Edit|MultiEdit router group', () => {
    assert.equal(findGate('swe-edit-lint'), sweEditLint);
    const group = ROUTER_GROUPS.find((g) => g.event === 'PostToolUse' && g.matcher === 'Write|Edit|MultiEdit');
    assert.ok(group);
    assert.deepEqual(group.gates.map((g) => [g.name, g.kind]), [['swe-edit-lint', 'advisory']]);
    for (const tool of ['Write', 'Edit', 'MultiEdit']) assert.deepEqual(routerGates('PostToolUse', tool).map((g) => g.name), ['swe-edit-lint'], tool);
    assert.deepEqual(routerGates('PostToolUse', 'NotebookEdit'), []);
  });
});
