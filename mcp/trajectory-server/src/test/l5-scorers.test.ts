import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { createScorerFixtures } from './lib/scorer-fixture.js';
import { materializedOnDisk, score, scoreAll, usageInLog, type ScoreContext } from './lib/l5-scorers.js';

const fixtures = createScorerFixtures();
after(() => fixtures.cleanup());
let fixture = fixtures.create();
let serial = 0;
const fresh = () => { fixture = fixtures.create(); };
const write = (name: string, value: unknown) => writeFileSync(join(fixture.scorerDir, name), JSON.stringify(value));
const sql = (query: string, path = fixture.dbPath) => {
  const db = new DatabaseSync(path);
  try { db.exec(query); } finally { db.close(); }
};
const issue = "INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'x', '', 'open', datetime('now'), datetime('now'));";
const task = "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, created_at, updated_at) VALUES (1, 1, 'feat/check', 'main', '', 'pending', datetime('now'), datetime('now'));";
function run(name: string) {
  let stdout = '', stderr = '';
  const context: ScoreContext = { ...fixture, flow: 'test', runId: `run-${++serial}`,
    stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } };
  return { status: score(name, context), output: () => stdout + stderr, context };
}
const prefix = 'mcp__plugin_tmb_trajectory-server__';
const tool = (name: string, parent: string | null = null) => appendFileSync(join(fixture.project, 'trajectory.jsonl'),
  JSON.stringify({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', name: prefix + name }] } }) + '\n');

describe('original scorer cases (31 assertions)', () => {
  it('no outcome-coherence.json → exit 0', () => assert.equal(run('coherence').status, 0));
  it('empty config → exit 0', () => { write('outcome-coherence.json', {}); assert.equal(run('coherence').status, 0); });
  it('issues>=1 with one row → pass', () => { sql(issue); write('outcome-coherence.json', { expected_writes: { issues: '>=1' } }); assert.equal(run('coherence').status, 0); });
  it('issues>=5 with one row → fail', () => { write('outcome-coherence.json', { expected_writes: { issues: '>=5' } }); assert.equal(run('coherence').status, 1); });
  it('tasks WHERE branch != main → pass', () => { sql(task); write('outcome-coherence.json', { expected_writes: { 'tasks WHERE branch_id != "main"': '>=1' } }); assert.equal(run('coherence').status, 0); });
  it('tasks = 1 → pass', () => { write('outcome-coherence.json', { expected_writes: { tasks: '1' } }); assert.equal(run('coherence').status, 0); });
  it('audit !=99 → pass', () => { write('outcome-coherence.json', { expected_writes: { audit: '!=99' } }); assert.equal(run('coherence').status, 0); });
  it('invalid operator → fail', () => { write('outcome-coherence.json', { expected_writes: { issues: 'wat' } }); assert.equal(run('coherence').status, 1); });
  it('no outcome-git.json → exit 0', () => { fresh(); assert.equal(run('git').status, 0); });
  it('base SHA unchanged from pre-run → pass', () => {
    write('outcome-git.json', { base_branch_unchanged: true });
    writeFileSync(join(fixture.project, '.claude/tmb/_l5_pre_run_git.json'), JSON.stringify({ head: fixture.git('rev-parse', 'HEAD'), branch: 'main' }));
    assert.equal(run('git').status, 0);
  });
  it('base advanced post-snapshot → fail', () => { appendFileSync(join(fixture.project, 'README.md'), 'more\n'); fixture.git('add', '.'); fixture.git('commit', '-qm', 'base advanced'); assert.equal(run('git').status, 1); });
  it('no pre-run snapshot → fail (loud signal)', () => { fresh(); write('outcome-git.json', { base_branch_unchanged: true }); assert.equal(run('git').status, 1); });
  it('worktree on feat/check → pass', () => {
    fresh(); sql(issue + task); fixture.git('branch', 'feat/check', 'HEAD');
    mkdirSync(join(fixture.project, '.claude/worktrees'), { recursive: true });
    fixture.git('worktree', 'add', '-q', '.claude/worktrees/check', 'feat/check');
    write('outcome-git.json', { worktrees: [{ path: '.claude/worktrees/<slug>', head_branch: '<task.branch_id>' }] });
    assert.equal(run('git').status, 0);
  });
  it("worktree on forbidden 'feat/check' → fail", () => { write('outcome-git.json', { worktrees: [{ path: '.claude/worktrees/check', head_not_branch: ['feat/check'] }] }); assert.equal(run('git').status, 1); });
  it('worktree path missing → fail', () => { write('outcome-git.json', { worktrees: [{ path: '.claude/worktrees/missing', head_branch: 'main' }] }); assert.equal(run('git').status, 1); });
  it('subagent validation_record → pass', () => { fresh(); tool('intent_start'); tool('validation_record', 'toolu_x'); write('tools-forbidden.json', [prefix + 'validation_record']); assert.equal(run('trajectory_forbidden').status, 0); });
  it('top-level validation_record → fail', () => { tool('validation_record'); assert.equal(run('trajectory_forbidden').status, 1); });
  it('any_of(issue_create|intent_start) with intent_start called → pass', () => { fresh(); tool('intent_start'); write('tools-required.json', [{ any_of: [prefix + 'issue_create', prefix + 'intent_start'] }]); assert.equal(run('trajectory_required').status, 0); });
  it('any_of(issue_create|task_create_batch) with neither called → fail', () => { write('tools-required.json', [{ any_of: [prefix + 'issue_create', prefix + 'task_create_batch'] }]); assert.equal(run('trajectory_required').status, 1); });
  it('string entry for called tool → pass', () => { write('tools-required.json', [prefix + 'intent_start']); assert.equal(run('trajectory_required').status, 0); });
  it('string entry for uncalled tool → fail', () => { write('tools-required.json', [prefix + 'task_create_batch']); assert.equal(run('trajectory_required').status, 1); });
  it('string entry satisfied by subagent call → pass', () => { tool('task_create_batch', 'toolu_y'); assert.equal(run('trajectory_required').status, 0); });
  it('no pre-step DB (L5 mode), neither tool called → fail', () => {
    fresh(); tool('intent_start');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    copyFileSync(join(root, 'tests/l5-l6/rows/06/06-swe-atomic-close/tools-required.json'), join(fixture.scorerDir, 'tools-required.json'));
    assert.equal(run('trajectory_required').status, 1);
  });
  it('failure names both tools', () => assert.match(run('trajectory_required').output(), /Agent.*bro_atomic_close/));
  it('pre-step DB with only a pending task, neither tool called → fail', () => {
    const pre = join(fixture.project, '.claude/tmb/_l6_pre_step.db');
    copyFileSync(fixture.dbPath, pre); sql(issue + task, pre); assert.equal(run('trajectory_required').status, 1);
  });
  it('pre-step DB with a closed task but no swe run, neither tool called → fail', () => { sql("UPDATE tasks SET status = 'closed' WHERE id = 1;", join(fixture.project, '.claude/tmb/_l6_pre_step.db')); assert.equal(run('trajectory_required').status, 1); });
  it('pre-step DB with a closed task and a swe run, neither tool called → pass', () => { sql("INSERT INTO agent_runs (task_id, issue_id, agent_type) VALUES (1, 1, 'swe');", join(fixture.project, '.claude/tmb/_l6_pre_step.db')); assert.equal(run('trajectory_required').status, 0); });
  it('no settings.local.json, no answer → pass', () => { fresh(); assert.equal(run('no_sandbox').status, 0); });
  it('settings without a sandbox block, answer no → pass', () => { sql(`INSERT INTO plugin_config (key, value_json) VALUES ('sandbox_enforcement', '"no"');`); writeFileSync(join(fixture.project, '.claude/settings.local.json'), '{"permissions":{"allow":["Bash"]}}'); assert.equal(run('no_sandbox').status, 0); });
  it('sandbox block present → fail', () => { writeFileSync(join(fixture.project, '.claude/settings.local.json'), '{"sandbox":{"enabled":true}}'); assert.equal(run('no_sandbox').status, 1); });
  it('sandbox_enforcement = yes → fail', () => { writeFileSync(join(fixture.project, '.claude/settings.local.json'), '{}'); sql(`UPDATE plugin_config SET value_json = '"yes"' WHERE key = 'sandbox_enforcement';`); assert.equal(run('no_sandbox').status, 1); });
});

describe('remaining scorers and score receipts', () => {
  it('outcome preserves multi-statement SQL, semicolons in strings and readfile', () => {
    fresh(); writeFileSync(join(fixture.scorerDir, 'outcome.sql'), `SELECT 1 AS pass, 'first; assertion' AS description;\nSELECT readfile('${join(fixture.project, 'README.md').replaceAll("'", "''")}') IS NOT NULL AS pass, 'readfile' AS description;`);
    const result = run('outcome'); assert.equal(result.status, 0); assert.equal(result.output(), '  ✓ outcome: 2/2 assertions passed\n');
  });
  it('outcome catches a failed later statement and records the result', () => {
    sql('CREATE TABLE eval_results (run_id TEXT, flow_name TEXT, scorer_name TEXT, pass INTEGER, value TEXT, explanation TEXT, created_at TEXT);');
    writeFileSync(join(fixture.scorerDir, 'outcome.sql'), "SELECT 1 AS pass, 'yes' AS description; SELECT 0 AS pass, 'no' AS description;");
    const result = run('outcome'); assert.equal(result.status, 1); assert.equal(result.output(), '  ✗ outcome: 1/2 assertions passed; failed: ; no\n');
    const db = new DatabaseSync(fixture.dbPath); try { assert.deepEqual({ ...db.prepare('SELECT pass, value, explanation FROM eval_results WHERE run_id = ?').get(result.context.runId) }, { pass: 0, value: '1/2', explanation: '; no' }); } finally { db.close(); }
  });
  for (const [name, statement] of [
    ['numeric column name', 'SELECT 0 AS pass, 1 AS "0";'],
    ['duplicate column names', 'SELECT 0 AS pass, 1 AS pass;'],
  ]) it(`outcome uses the first SQL column with ${name}`, () => {
    fresh(); writeFileSync(join(fixture.scorerDir, 'outcome.sql'), statement);
    const result = run('outcome'); assert.equal(result.status, 1); assert.equal(result.output(), '  ✗ outcome: 0/1 assertions passed; failed: ; 1\n');
  });
  it('outcome without rows fails', () => { writeFileSync(join(fixture.scorerDir, 'outcome.sql'), 'SELECT 1 WHERE 0;'); assert.equal(run('outcome').status, 1); });
  it('SQL errors fail without hiding the diagnostic', () => { writeFileSync(join(fixture.scorerDir, 'outcome.sql'), 'SELECT * FROM missing;'); const result = run('outcome'); assert.equal(result.status, 1); assert.match(result.output(), /missing/); });
  it('cost is observational without a budget', () => { fresh(); tool('intent_start'); const result = run('cost'); assert.equal(result.status, 0); assert.equal(result.output(), '  ⊘ cost (observational): tokens_total=0 (in=0 out=0) duration_ms=0\n'); });
  it('cost respects hard and soft budgets', () => {
    writeFileSync(join(fixture.project, 'trajectory.jsonl'), JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5 } } }) + '\n' + JSON.stringify({ type: 'result', duration_ms: 40 }));
    write('cost-budget.json', { max_tokens_total: 10, max_duration_ms: 20, fail_above_max: false }); assert.equal(run('cost').status, 0);
    write('cost-budget.json', { max_tokens_total: 10, max_duration_ms: 20, fail_above_max: true }); const result = run('cost'); assert.equal(result.status, 1); assert.equal(result.output(), '  ✗ cost: budget exceeded; tokens(15 > 10); duration_ms(40 > 20)\n');
  });
  it('files checks missing, forbidden, and short files', () => {
    fresh(); write('outcome-files.json', { files: [{ path: 'README.md', must_exist: true, min_bytes: 5 }, { path: 'absent', must_not_exist: true }] }); assert.equal(run('files').status, 0);
    for (const entry of [{ path: 'README.md', must_not_exist: true }, { path: 'absent', must_exist: true }, { path: 'README.md', must_exist: true, min_bytes: 99 }]) { write('outcome-files.json', { files: [entry] }); assert.equal(run('files').status, 1); }
  });
  it('all scorer failures retain a failure count rather than a boolean', () => { fresh(); write('outcome-coherence.json', { expected_writes: { issues: '>=99' } }); write('outcome-files.json', { files: [{ path: 'absent', must_exist: true }] }); assert.equal(scoreAll(run('cost').context), 2); });
  it('malformed configs fail closed', () => { fresh(); writeFileSync(join(fixture.scorerDir, 'outcome-coherence.json'), '{'); assert.equal(run('coherence').status, 1); });
});

describe('original usage helper cases (6 assertions)', () => {
  const log = join(fixtures.root, 'skill-invoked.jsonl');
  const noSkill = join(fixtures.root, 'no-skill.jsonl');
  writeFileSync(log, [
    { type: 'system', subtype: 'init', plugins: ['tmb@trustmybot'] },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'tmb:tmb_planning' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'Launching skill: tmb:tmb_planning' }] } },
  ].map((event) => JSON.stringify(event)).join('\n'));
  writeFileSync(noSkill, JSON.stringify({ type: 'system', subtype: 'init', plugins: ['tmb@trustmybot'] }));
  it('tmb:tmb_planning in skill log', () => assert.equal(usageInLog(log, 'tmb:tmb_planning'), true));
  it('tmb_planning (bare) in skill log', () => assert.equal(usageInLog(log, 'tmb_planning'), true));
  it('tmb_planning absent from no-skill log', () => assert.equal(usageInLog(noSkill, 'tmb_planning'), false));
  it('tmb_review absent from skill log', () => assert.equal(usageInLog(log, 'tmb_review'), false));
  it('tmb@trustmybot plugin loaded', () => assert.equal(usageInLog(log, 'tmb@trustmybot:tmb_planning'), true));
  it('nonexistent log → fail', () => assert.equal(usageInLog(join(fixtures.root, 'absent'), 'tmb_planning'), false));
});

describe('original materialization helper cases (7 assertions)', () => {
  const materialized = join(fixtures.root, 'materialized');
  const missing = join(fixtures.root, 'no-skill');
  mkdirSync(join(materialized, '.claude/agents'), { recursive: true });
  mkdirSync(join(missing, '.claude/agents'), { recursive: true });
  writeFileSync(join(materialized, '.claude/agents/swe.md'), '---\nname: swe\nskills: [tmb_swe-checklist, feature-dev]\n---\n');
  writeFileSync(join(materialized, '.claude/CLAUDE.md'), 'Installed skill: code-review — load it when its capability is needed.\n');
  writeFileSync(join(missing, '.claude/agents/swe.md'), '---\nname: swe\nskills: [tmb_swe-checklist]\n---\n');
  it('swe.md lists feature-dev', () => assert.equal(materializedOnDisk(materialized, 'swe', 'feature-dev'), true));
  it('swe.md feature-dev via prefixed query', () => assert.equal(materializedOnDisk(materialized, 'swe', 'tmb:feature-dev'), true));
  it('bro CLAUDE.md references code-review', () => assert.equal(materializedOnDisk(materialized, 'bro', 'code-review'), true));
  it('swe.md missing feature-dev → fail', () => assert.equal(materializedOnDisk(missing, 'swe', 'feature-dev'), false));
  it('code-reviewer.md never materialized → fail', () => assert.equal(materializedOnDisk(missing, 'code-reviewer', 'code-review'), false));
  it('bro CLAUDE.md missing skill → fail', () => assert.equal(materializedOnDisk(missing, 'bro', 'feature-dev'), false));
  it('feature (substring) must not match feature-dev', () => assert.equal(materializedOnDisk(materialized, 'swe', 'feature'), false));
});


describe('frozen Bash scorer outputs (9cc886e8)', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const corpus = JSON.parse(readFileSync(join(root, 'tests/l5-l6/fixtures/scorers-parity.json'), 'utf8'));
  for (const entry of corpus.cases) it(entry.name, () => {
    fresh();
    for (const [name, value] of Object.entries(entry.config ?? {})) writeFileSync(join(fixture.scorerDir, name), typeof value === 'string' ? value : JSON.stringify(value));
    for (const [name, value] of Object.entries(entry.files ?? {})) {
      const path = join(fixture.project, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, String(value));
    }
    if (entry.events) writeFileSync(join(fixture.project, 'trajectory.jsonl'), entry.events.map((event: unknown) => JSON.stringify(event)).join('\n'));
    if (entry.sql) sql(entry.sql);
    let stdout = '', stderr = '';
    const status = score(entry.scorer, { ...fixture, flow: 'parity', runId: 'parity', stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } });
    const normalize = (text: string) => text.replaceAll(fixture.project, '<project>').replaceAll(fixture.scorerDir, '<scorer-dir>');
    assert.deepEqual({ status, stdout: normalize(stdout), stderr: normalize(stderr) }, entry.expected);
  });
});

describe('Node scorer entry point', () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'lib/l5-scorers-cli.js');
  it('rejects an unknown scorer or missing arguments', () => {
    fresh();
    for (const args of [[], ['unknown', fixture.project, 'test', fixture.scorerDir, 'cli']]) {
      const child = spawnSync(process.execPath, ['--experimental-sqlite', cli, ...args], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(child.error, undefined); assert.equal(child.status, 2); assert.notEqual(child.stderr, '');
    }
  });
  it('returns the complete failure count and output to legacy runners', () => {
    fresh(); write('outcome-coherence.json', { expected_writes: { issues: '>=99' } }); write('outcome-files.json', { files: [{ path: 'absent', must_exist: true }] });
    const child = spawnSync(process.execPath, ['--experimental-sqlite', cli, 'all', fixture.project, 'test', fixture.scorerDir, 'cli'], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(child.error, undefined); assert.equal(child.status, 2); assert.match(child.stderr, /files: absent does not exist/); assert.match(child.stderr, /coherence: issues/); assert.match(child.stdout, /no_sandbox/);
  });
});
