/**
 * swe and code-reviewer carry the world-model read tools on their tools: line
 * (GH 1990), for the impact walk on a reshaped symbol.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const WM_TOOLS = ['world_model_symbol', 'world_model_search', 'world_model_get'].map((t) => `mcp__plugin_tmb_trajectory-server__${t}`);

function tools(agent: string): string[] {
  const text = readFileSync(join(PLUGIN_ROOT, 'agents', `${agent}.md`), 'utf8');
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const line = front.split('\n').find((l) => l.startsWith('tools:')) ?? '';
  return line.slice('tools:'.length).split(',').map((t) => t.trim()).filter((t) => t !== '');
}

describe('GH 1990: the world-model tools on the agents', () => {
  for (const agent of ['swe', 'code-reviewer']) {
    it(`GH 1990: ${agent}'s tools line carries world_model_symbol, world_model_search and world_model_get`, () => {
      const listed = tools(agent);
      assert.ok(listed.length > 3, `${agent} has a tools line`);
      for (const t of WM_TOOLS) assert.ok(listed.includes(t), `${agent} lists ${t}`);
    });
  }

  it('GH 1990: swe.md and tmb_review carry the impact-walk rule', () => {
    for (const file of ['agents/swe.md', 'skills/tmb_review/SKILL.md']) {
      assert.match(readFileSync(join(PLUGIN_ROOT, file), 'utf8'), /world_model_symbol\([^)]*impact: 2\)/, file);
    }
  });

  it('GH 2417: swe.md and tmb_review search the world model with a Grep fallback and report wm_feedback', () => {
    const swe = readFileSync(join(PLUGIN_ROOT, 'agents/swe.md'), 'utf8');
    assert.match(swe, /`world_model_search` before Grep/);
    assert.match(swe, /wm_feedback/);
    assert.match(swe, /After `task_brief`, run `world_model_symbol\(agent='swe'/);

    const review = readFileSync(join(PLUGIN_ROOT, 'skills/tmb_review/SKILL.md'), 'utf8');
    assert.match(review, /`world_model_search`, and fall back to Grep when the world model misses/);
    assert.match(review, /wm_feedback/);
  });

  it('GH 2896: code-reviewer.md and tmb_review claim no edge for the world model over Grep or git', () => {
    for (const file of ['agents/code-reviewer.md', 'skills/tmb_review/SKILL.md']) {
      assert.doesNotMatch(readFileSync(join(PLUGIN_ROOT, file), 'utf8'), /\b(faster|better|cheaper) than\b/i, file);
    }
  });

  it("GH 2417: tmb_review's allowed-tools admits the three world-model tools", () => {
    const text = readFileSync(join(PLUGIN_ROOT, 'skills/tmb_review/SKILL.md'), 'utf8');
    const line = (/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '').split('\n').find((l) => l.startsWith('allowed-tools:')) ?? '';
    const allowed = line.slice('allowed-tools:'.length).split(',').map((t) => t.trim());
    for (const t of WM_TOOLS) assert.ok(allowed.includes(t), `tmb_review allows ${t}`);
  });
});
