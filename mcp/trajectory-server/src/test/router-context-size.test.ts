/**
 * Claude Code caps each hook's additionalContext or plain stdout at 10,000
 * characters per string, past which it keeps a path and a 2,000-character
 * preview, so the big-context gates hold their own registration (GH 1692 R4).
 * The real persona and prescan gates run in their parity sandbox, each as its
 * part, and every answer they give stays under the cap.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { decide } from '../hooks/router/decide.js';
import { type RouterCase, type RouterCorpusGate, routerSandbox, underUid } from './router-sandboxes.js';

const CONTEXT_CAP_CHARS = 10_000;
const PARTS: readonly { gate: RouterCorpusGate; event: string; part: string; substantial: RegExp }[] = [
  { gate: 'session-start-persona', event: 'SessionStart', part: 'persona', substantial: /You are bro/ },
  { gate: 'session-start-prescan', event: 'SessionStart', part: 'prescan', substantial: /Project Inventory/ },
  { gate: 'user-prompt-persona', event: 'UserPromptSubmit', part: 'persona', substantial: /./ },
];

async function answer(c: RouterCase, event: string, part: string): Promise<string> {
  const cwd = process.cwd();
  c.reset?.();
  process.chdir(c.cwd);
  try {
    return (await underUid(c.fakeUid, () => decide(event, c.input, c.env, { part }))).stdout;
  } finally {
    process.chdir(cwd);
  }
}

describe('each big-context part stays under the 10,000 character cap', () => {
  let sandbox: ReturnType<typeof routerSandbox>;
  before(() => {
    sandbox = routerSandbox(mkdtempSync(join(tmpdir(), 'tmb-router-size-')), PARTS.map((p) => p.gate));
  });
  after(() => {
    process.chdir(tmpdir());
    sandbox.cleanup();
  });

  for (const { gate, event, part, substantial } of PARTS) {
    it(`${event} ${part}: ${gate}`, async () => {
      const cases = sandbox.cases.filter((c) => c.gate === gate);
      assert.ok(cases.length > 0);
      const outputs: string[] = [];
      for (const c of cases) {
        if (!c.input.trimStart().startsWith('{')) continue;
        outputs.push(await answer(c, event, part));
      }
      const largest = outputs.reduce((a, b) => (b.length > a.length ? b : a), '');
      assert.match(largest, substantial, 'the sandbox reached the gate output');
      assert.ok(largest.length < CONTEXT_CAP_CHARS, `${largest.length} chars`);
    });
  }
});
