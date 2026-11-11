/**
 * test-run-nudge (GH 1907): swe's raw test runs get one PreToolUse
 * additionalContext line naming dist/test-run.js and no decision; wrapped
 * runs, non-test commands, other callers, other tools and the bypass get
 * nothing. Plus the Bash router group wiring.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findGate, gateNames, routerGates } from '../hooks/registry.js';
import { GATE_NAME, testRunNudge } from '../hooks/test-run-nudge.js';

const SWE = { agent_id: 'a1', agent_type: 'tmb:swe' };
const ENV: NodeJS.ProcessEnv = { CLAUDE_PLUGIN_ROOT: '/plugin' };
const WRAP = 'node "/plugin/mcp/trajectory-server/dist/test-run.js" --';

function payload(command: string, extra: object = SWE, tool = 'Bash'): string {
  return JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: tool, tool_input: { command }, ...extra });
}

const RAW = [
  'cd mcp/trajectory-server && node --experimental-sqlite --test dist/test/x.test.js </dev/null',
  'node --test',
  'node --experimental-sqlite --no-warnings --test dist/test/a.test.js dist/test/b.test.js',
  'bun test',
  'bun run test',
  'npm test',
  'npm run test',
  'vitest run',
  'npx vitest',
  'jest --runInBand',
  './node_modules/.bin/jest',
  'pytest -q tests/',
  'python3 -m pytest tests/',
  'bash tests/l1-lint/run.sh',
  'sh scripts/test/check.sh',
  'bash -x test/smoke.sh',
  'bash scripts/hooks.test.sh',
  './tests/run.test.sh',
  'git status && npm test 2>&1 | tail -20',
  'FOO=1 timeout 120 npm test',
  "bash -c 'cd x && npm test'",
  'echo start; (cd a && bun test)',
];

const SILENT = [
  ...RAW.map((cmd) => `${WRAP} bash -c '${cmd.replace(/'/g, '')}'`),
  `${WRAP} node --experimental-sqlite --test dist/test/x.test.js`,
  'node mcp/trajectory-server/src/test-run.ts -- npm test',
  'test -f x && echo y',
  '[ -f tests/a.sh ] && echo y',
  'git add tests/x.test.sh',
  'git log -- tests/run.sh',
  'git diff mcp/trajectory-server/src/test/x.test.ts',
  'cat tests/a.sh',
  "sed -n '1,20p' tests/run.test.sh",
  'grep -n pytest tests/a.sh',
  'node dist/cli.js --test',
  'npm install',
  'bun run build',
  'echo "npm test"',
  "git commit -m 'run npm test; vitest'",
  'ls test/',
];

function contextOf(stdout: string): { decision: unknown; updated: unknown; text: string } {
  const lines = stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1, stdout);
  const out = JSON.parse(lines[0]) as { hookSpecificOutput: { hookEventName: string; permissionDecision?: unknown; updatedInput?: unknown; additionalContext: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  return { decision: out.hookSpecificOutput.permissionDecision, updated: out.hookSpecificOutput.updatedInput, text: out.hookSpecificOutput.additionalContext };
}

describe('test-run-nudge', () => {
  for (const cmd of RAW) {
    it(`nudges swe on: ${cmd}`, () => {
      const r = testRunNudge(payload(cmd), ENV);
      assert.equal(r.code, 0);
      const ctx = contextOf(r.stdout);
      assert.equal(ctx.decision, undefined);
      assert.equal(ctx.updated, undefined);
      assert.match(ctx.text, /dist\/test-run\.js/);
      assert.ok(ctx.text.includes('node "/plugin/mcp/trajectory-server/dist/test-run.js" -- <argv...>'), ctx.text);
      assert.match(ctx.text, /TMB_SKIP_TEST_RUN_NUDGE=1/);
    });
  }

  for (const cmd of SILENT) {
    it(`stays silent on: ${cmd}`, () => {
      assert.deepEqual(testRunNudge(payload(cmd), ENV), { stdout: '', code: 0 });
    });
  }

  it('names ${CLAUDE_PLUGIN_ROOT} when the env has no plugin root', () => {
    assert.ok(contextOf(testRunNudge(payload('npm test'), {}).stdout).text.includes('node "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/test-run.js" -- <argv...>'));
  });

  it('stays silent for every caller but swe', () => {
    for (const extra of [{}, { agent_id: 'a2', agent_type: 'tmb:code-reviewer' }, { agent_id: 'a3', agent_type: 'tmb:security' }, { agent_id: 'a4', agent_type: 'bro' }]) {
      for (const cmd of RAW) assert.deepEqual(testRunNudge(payload(cmd, extra), ENV), { stdout: '', code: 0 }, `${JSON.stringify(extra)} ${cmd}`);
    }
  });

  it('stays silent on a tool other than Bash', () => {
    for (const tool of ['Edit', 'Write', 'Read', 'mcp__plugin_tmb_trajectory-server__task_brief']) {
      assert.deepEqual(testRunNudge(payload('npm test', SWE, tool), ENV), { stdout: '', code: 0 }, tool);
    }
  });

  it('stays silent under TMB_SKIP_TEST_RUN_NUDGE=1', () => {
    for (const cmd of RAW) assert.deepEqual(testRunNudge(payload(cmd), { ...ENV, TMB_SKIP_TEST_RUN_NUDGE: '1' }), { stdout: '', code: 0 }, cmd);
  });

  it('is an advisory gate of the PreToolUse Bash router group', () => {
    assert.ok(gateNames().includes(GATE_NAME));
    assert.equal(findGate(GATE_NAME), testRunNudge);
    const gate = routerGates('PreToolUse', 'Bash').find((g) => g.name === GATE_NAME);
    assert.equal(gate?.kind, 'advisory');
  });
});
