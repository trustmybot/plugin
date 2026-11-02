/**
 * Node guard (GH 2215): with `node` off PATH every router registration exits
 * 127 before substrate-preflight can name the cause, so the SessionStart
 * default registration and the WorktreeCreate one start with a POSIX
 * `command -v node` guard that prints the TMB DEGRADED line and exits 2. The
 * fail-closed PreToolUse registrations keep `onFailure: "block"` unguarded.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { PLUGIN_ROOT } from './router-sandboxes.js';

interface Registration {
  command: string;
  timeout?: number;
  onFailure?: string;
}
interface HooksJson {
  hooks: Record<string, { matcher?: string; hooks: Registration[] }[]>;
}

const HOOKS = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks/hooks.json'), 'utf8')) as HooksJson;
const MESSAGE = 'TMB DEGRADED: missing node — MCP trajectory-server and every TMB hook cannot start. Install Node.js 22 or later on PATH and restart Claude Code.';
const GUARD = `command -v node >/dev/null 2>&1 || { echo '${MESSAGE}' >&2; exit 2; }; `;
const tail = (event: string): string => `node "\${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js" ${event}`;
const FAIL_CLOSED_PRETOOLUSE = ['Write|Edit|MultiEdit|NotebookEdit', 'Bash', 'Agent', 'SendMessage', 'mcp__.*trajectory-server__.*'];

function registration(event: string): Registration {
  const found = HOOKS.hooks[event].flatMap((g) => g.hooks).filter((h) => h.command.endsWith(`dist/hooks.js" ${event}`));
  assert.equal(found.length, 1, event);
  return found[0];
}

function runSh(command: string, path: string) {
  return spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: { PATH: path, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
}

describe('hooks.json node guard (GH 2215)', () => {
  const dirs: string[] = [];
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'tmb-node-guard-'));
    dirs.push(dir);
    return dir;
  };
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  for (const event of ['SessionStart', 'WorktreeCreate']) {
    it(`${event}: the guard then the unchanged router tail`, () => {
      assert.equal(registration(event).command, `${GUARD}${tail(event)}`);
    });

    it(`${event}: with no node on PATH, /bin/sh exits 2 naming the missing node on stderr`, () => {
      const r = runSh(registration(event).command, tempDir());
      assert.equal(r.status, 2, r.stderr);
      assert.equal(r.stderr, `${MESSAGE}\n`);
      assert.equal(r.stdout, '');
    });

    it(`${event}: with node on PATH, the router tail runs`, () => {
      const bin = tempDir();
      writeFileSync(join(bin, 'node'), '#!/bin/sh\necho "$@"\n');
      chmodSync(join(bin, 'node'), 0o755);
      const r = runSh(registration(event).command, bin);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, `${PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js ${event}\n`);
      assert.equal(r.stderr, '');
    });
  }

  it('only those two registrations carry the guard', () => {
    const guarded = Object.entries(HOOKS.hooks).flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.filter((h) => h.command.startsWith('command -v node')).map(() => event)));
    assert.deepEqual(guarded.sort(), ['SessionStart', 'WorktreeCreate']);
  });

  it('every fail-closed PreToolUse registration keeps onFailure: block and the bare router command', () => {
    const blocking = HOOKS.hooks.PreToolUse.filter((g) => g.hooks.some((h) => h.onFailure === 'block')).map((g) => g.matcher);
    assert.deepEqual(blocking.sort(), [...FAIL_CLOSED_PRETOOLUSE].sort());
    for (const matcher of FAIL_CLOSED_PRETOOLUSE) {
      const [entry] = HOOKS.hooks.PreToolUse.filter((g) => g.matcher === matcher);
      for (const h of entry.hooks) {
        assert.equal(h.onFailure, 'block', matcher);
        assert.equal(h.command, tail('PreToolUse'), matcher);
      }
    }
  });
});
