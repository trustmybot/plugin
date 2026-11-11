import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { skillTools } from '../tools/skills.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function register(tools: ReturnType<typeof skillTools>, name: string, filePath: string): Promise<RawResult> {
  return (await tools.handlers['skill_register']({
    agent: 'bro',
    name,
    description: 'A test skill',
    file_path: filePath,
    trust_tier: 'agent',
  })) as RawResult;
}

describe('skill_register duplicate name (GH 2927)', () => {
  it('registers a new name', async () => {
    const db = tempDB();
    const result = await register(skillTools(db), 'fresh-skill', '.claude/skills/fresh-skill/SKILL.md');
    assert.ok(!result.isError, result.content[0].text);
    const row = JSON.parse(result.content[0].text) as { name: string };
    assert.equal(row.name, 'fresh-skill');
    db.close();
  });

  it('refuses a second registration of the same name, naming the existing skill, and writes no row', async () => {
    const db = tempDB();
    const tools = skillTools(db);
    const existingPath = '.claude/skills/dup-skill/SKILL.md';
    const first = await register(tools, 'dup-skill', existingPath);
    assert.ok(!first.isError, first.content[0].text);

    const second = await register(tools, 'dup-skill', '.claude/skills/other/SKILL.md');
    assert.ok(second.isError, 'second registration must fail');
    const { error } = JSON.parse(second.content[0].text) as { error: string };
    assert.match(error, /"dup-skill"/);
    assert.ok(error.includes(existingPath), `error must name the existing file_path: ${error}`);
    assert.doesNotMatch(error, /UNIQUE constraint/);

    const rows = db.all<{ file_path: string }>(`SELECT file_path FROM cheatcodes WHERE name = ?`, ['dup-skill']);
    assert.deepEqual(rows.map((row) => row.file_path), [existingPath]);
    db.close();
  });
});
