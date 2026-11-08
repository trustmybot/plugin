/**
 * Unit tests of the worktree-adopt-guard gate (GH 2032), run in process over a
 * temp repo with a linked session worktree: the allowlist matrix over a non-git
 * root, the main checkout and the linked root, each with adopt_worktree
 * missing, matching or mismatched, and a symlinked arg compared by realpath.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findGate, routerGates } from '../hooks/registry.js';
import { ADOPT_TOOLS, linkedWorktreeTop, worktreeAdoptGuard } from '../hooks/worktree-adopt-guard.js';

const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

const payload = (tool: string, adopt?: unknown, cwd?: string): string =>
  JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: `mcp__plugin_tmb_trajectory-server__${tool}`,
    ...(cwd === undefined ? {} : { cwd }),
    tool_input: adopt === undefined ? { issue_id: 1 } : { issue_id: 1, adopt_worktree: adopt },
  });

function reasonOf(stdout: string): string | null {
  if (stdout === '') return null;
  const out = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

describe('worktree-adopt-guard (GH 2032)', () => {
  let root: string;
  let main: string;
  let linked: string;
  let other: string;
  let nonGit: string;
  let link: string;

  const run = async (raw: string, sessionRoot: string): Promise<string | null> => {
    const r = await worktreeAdoptGuard(raw, { PATH: process.env.PATH, HOME: join(root, 'home'), CLAUDE_PROJECT_DIR: sessionRoot });
    assert.equal(r.code, 0);
    return reasonOf(r.stdout);
  };

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-wt-adopt-guard-')));
    main = join(root, 'main');
    linked = join(root, 'linked');
    other = join(root, 'other');
    nonGit = join(root, 'plain');
    link = join(root, 'linked-link');
    mkdirSync(main);
    mkdirSync(nonGit);
    git(main, 'init', '-q', '-b', 'main');
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@t.t', 'commit', '-q', '--allow-empty', '-m', 'base');
    git(main, 'worktree', 'add', '-q', '-b', 'claude/session', linked);
    git(main, 'worktree', 'add', '-q', '-b', 'claude/other', other);
    symlinkSync(linked, link);
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('is registered as an enforcement gate on exactly task_provision, task_reopen and task_retry', () => {
    assert.equal(findGate('worktree-adopt-guard'), worktreeAdoptGuard);
    for (const tool of ADOPT_TOOLS) {
      const gate = routerGates('PreToolUse', `mcp__plugin_tmb_trajectory-server__${tool}`).find((g) => g.name === 'worktree-adopt-guard');
      assert.equal(gate?.kind, 'enforcement', tool);
    }
    assert.equal(routerGates('PreToolUse', 'mcp__plugin_tmb_trajectory-server__task_list').some((g) => g.name === 'worktree-adopt-guard'), false);
  });

  it('linkedWorktreeTop: the linked worktree top (from a subdirectory and a symlink too), null for a main checkout, a non-git dir and a missing dir', async () => {
    mkdirSync(join(linked, 'sub'), { recursive: true });
    assert.equal(await linkedWorktreeTop(linked), linked);
    assert.equal(await linkedWorktreeTop(join(linked, 'sub')), linked);
    assert.equal(await linkedWorktreeTop(link), linked);
    assert.equal(await linkedWorktreeTop(main), null);
    assert.equal(await linkedWorktreeTop(nonGit), null);
    assert.equal(await linkedWorktreeTop(join(root, 'missing')), null);
    assert.equal(await linkedWorktreeTop(''), null);
  });

  for (const tool of ADOPT_TOOLS) {
    it(`${tool}: a non-git root and a main checkout without adopt_worktree are allowed`, async () => {
      assert.equal(await run(payload(tool), nonGit), null);
      assert.equal(await run(payload(tool), main), null);
    });

    it(`${tool}: a linked root without adopt_worktree is denied, naming the exact adopt_worktree to pass`, async () => {
      const reason = await run(payload(tool), linked);
      assert.ok(reason?.includes(`adopt_worktree: '${linked}'`), reason ?? '');
      assert.ok(reason?.includes(tool), reason ?? '');
    });

    it(`${tool}: a linked root with its own top level is allowed, also through a symlink compared by realpath`, async () => {
      assert.equal(await run(payload(tool, linked), linked), null);
      assert.equal(await run(payload(tool, link), linked), null);
      assert.equal(await run(payload(tool, linked), link), null);
    });

    it(`${tool}: a linked root with a mismatched arg is denied, naming the worktree it may adopt`, async () => {
      for (const asked of [other, main, join(linked, 'sub'), join(root, 'missing'), 'relative/path', 7]) {
        const reason = await run(payload(tool, asked), linked);
        assert.match(reason ?? '', /is not this session's worktree/, String(asked));
        assert.ok(reason?.includes(`adopt_worktree: '${linked}'`), reason ?? '');
      }
    });

    it(`${tool}: a main checkout or a non-git root with any arg is denied: no worktree may be adopted`, async () => {
      for (const sessionRoot of [main, nonGit]) {
        for (const asked of [linked, main, other]) {
          const reason = await run(payload(tool, asked), sessionRoot);
          assert.match(reason ?? '', /no worktree may be adopted/, `${sessionRoot} ${asked}`);
          assert.match(reason ?? '', new RegExp(`Allowed form: the same ${tool} call without adopt_worktree`));
        }
      }
    });
  }

  it('falls back to the payload cwd when CLAUDE_PROJECT_DIR is unset', async () => {
    const env = { PATH: process.env.PATH, HOME: join(root, 'home') };
    assert.match(reasonOf((await worktreeAdoptGuard(payload('task_provision', undefined, linked), env)).stdout) ?? '', new RegExp(`adopt_worktree: '${linked}'`));
    assert.equal((await worktreeAdoptGuard(payload('task_provision', linked, linked), env)).stdout, '');
    assert.equal((await worktreeAdoptGuard(payload('task_provision', undefined, main), env)).stdout, '');
  });

  it('allows other tools and denies an unreadable payload', async () => {
    assert.equal(await run(payload('task_list', other), linked), null);
    assert.match((await run('{not json', linked)) ?? '', /could not read the hook payload/);
  });
});
