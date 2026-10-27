/**
 * Unit tests of the TypeScript no-source-edit-from-main gate (GH 1692):
 * registration, and the GH 1796 fix: a write under /tmp/claude-<uid>, in its
 * /tmp or canonical /private/tmp form, or through a link into
 * .claude/tmb/scratch/, is allowed, while main-checkout source and a `..`
 * climb out of scratch stay denied. process.getuid is stubbed to a fake uid so
 * the host's own /tmp/claude-<uid> never covers the sandbox.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findGate, gateNames } from '../hooks/registry.js';
import { noSourceEditFromMain } from '../hooks/no-source-edit-from-main.js';
import { buildSourceEditSandbox } from './hooks-no-source-edit-parity.suite.js';

const FAKE_UID = 4242424;
const SOURCE_DENY = 'BLOCKED: source edits from the main checkout are denied.';

describe('no-source-edit-from-main is registered', () => {
  it('is a gate dist/hooks-gates.txt lists', () => {
    assert.equal(findGate('no-source-edit-from-main'), noSourceEditFromMain);
    assert.ok(gateNames().includes('no-source-edit-from-main'));
  });
});

describe('no-source-edit-from-main compares scratch roots canonically (GH 1796)', () => {
  const realGetuid = process.getuid;
  let base: string;
  let s: string;
  let checkout: string;

  before(() => {
    process.getuid = () => FAKE_UID;
    base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-no-source-edit-unit-')));
    s = join(base, 'sandbox');
    buildSourceEditSandbox(s);
    checkout = join(s, 'project/checkout');
  });
  after(() => {
    process.getuid = realGetuid;
    rmSync(base, { recursive: true, force: true });
  });

  function env(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      HOME: join(s, 'home'),
      CLAUDE_PROJECT_DIR: join(s, 'project'),
      CLAUDE_PLUGIN_ROOT: join(s, 'running-plugin'),
      TRAJECTORY_DB_PATH: join(s, 'project/.claude/tmb/trajectory.db'),
      PWD: checkout,
    };
  }

  async function decide(filePath: string): Promise<string> {
    const payload = JSON.stringify({ hook_event_name: 'PreToolUse', cwd: checkout, tool_name: 'Write', tool_input: { file_path: filePath, content: 'x' } });
    const r = await noSourceEditFromMain(payload, env());
    assert.equal(r.code, 0);
    return r.stdout;
  }

  it('allows a new file under the canonical /tmp/claude-<uid>', async () => {
    assert.equal(await decide(`${realpathSync('/tmp')}/claude-${FAKE_UID}/x/y.mjs`), '');
  });

  it('allows the /tmp/claude-<uid> form and, on macOS, the /private/tmp/claude-<uid> form', async () => {
    assert.equal(await decide(`/tmp/claude-${FAKE_UID}/x/y.mjs`), '');
    if (process.platform === 'darwin') assert.equal(await decide(`/private/tmp/claude-${FAKE_UID}/x/y.mjs`), '');
  });

  it('allows a write through a link into .claude/tmb/scratch/', async () => {
    assert.equal(await decide(join(s, 'scratchlink/x.ts')), '');
  });

  it('still denies main-checkout source and a climb out of scratch', async () => {
    assert.ok((await decide(join(checkout, 'src/x.ts'))).includes(SOURCE_DENY));
    assert.ok((await decide(`${checkout}/.claude/tmb/scratch/../../../src/x.ts`)).includes(SOURCE_DENY));
    assert.ok((await decide(join(s, 'scratchlink/../src/x.ts'))).includes(SOURCE_DENY));
  });
});
