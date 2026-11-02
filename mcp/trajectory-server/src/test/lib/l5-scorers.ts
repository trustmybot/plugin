/** L5/L6 scoring. Test-only; excluded from the runtime payload with dist/test. */
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { listValue, splitStatements } from '../../hooks/lib/sqlite-shell.js';

export interface ScoreContext {
  project: string;
  flow: string;
  scorerDir: string;
  runId: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}
export type Scorer = (context: ScoreContext) => number;
type Json = Record<string, any>;
const dbPath = (c: ScoreContext): string => join(c.project, '.claude/tmb/trajectory.db');
const output = (c: ScoreContext, text: string, failed = false): void => (failed ? c.stderr : c.stdout)(`${text}\n`);
const json = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const isFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };
const isDir = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };
function withDb<T>(path: string, action: (db: DatabaseSync) => T, readOnly = true): T {
  const db = new DatabaseSync(path, { readOnly, enableDoubleQuotedStringLiterals: true, enableForeignKeyConstraints: false });
  try { return action(db); } finally { db.close(); }
}
function queryRows(db: DatabaseSync, sql: string): unknown[][] {
  const statement = db.prepare(sql);
  statement.setReturnArrays(true);
  statement.setReadBigInts(true);
  return statement.all() as unknown as unknown[][];
}
function query(path: string, sql: string): string {
  return withDb(path, (db) => queryRows(db, sql).map((row) => row.map(listValue).join('|')).join('\n'));
}
function queryOrEmpty(path: string, sql: string): string {
  try { return query(path, sql); } catch { return ''; }
}
function git(project: string, ...args: string[]): string {
  const run = spawnSync('git', ['-C', project, ...args], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
  if (run.error || run.status !== 0) throw new Error(run.error?.message || run.stderr.trim() || `git exited ${run.status ?? run.signal}`);
  return run.stdout.trim();
}
function gitOrEmpty(project: string, ...args: string[]): string {
  try { return git(project, ...args); } catch { return ''; }
}
function events(path: string): Json[] {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}
function toolNames(path: string, topLevel = false): Set<string> {
  return new Set(events(path).filter((e) => e.type === 'assistant' && (!topLevel || e.parent_tool_use_id == null))
    .flatMap((e) => e.message?.content ?? []).filter((item) => item.type === 'tool_use').map((item) => item.name));
}
export function recordScore(c: ScoreContext, name: string, pass: number, value: string, explanation: string): void {
  // Scoring output remains available when an older fixture lacks eval_results.
  try {
    withDb(dbPath(c), (db) => db.prepare(`INSERT INTO eval_results
      (run_id, flow_name, scorer_name, pass, value, explanation, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`).run(c.runId, c.flow, name, pass, value || null, explanation || null), false);
  } catch { /* Match the existing optional score receipt. */ }
}

export const scoreOutcome: Scorer = (c) => {
  const path = join(c.scorerDir, 'outcome.sql');
  if (!isFile(path)) {
    output(c, `  ⊘ outcome scorer skipped: ${path} not found`);
    recordScore(c, 'outcome', 1, '', 'no-config');
    return 0;
  }
  const rows = withDb(dbPath(c), (db) => {
    db.function('readfile', (path) => { try { return readFileSync(String(path)); } catch { return null; } });
    return splitStatements(readFileSync(path, 'utf8')).flatMap(({ text }) => queryRows(db, text));
  });
  if (!rows.length) {
    output(c, '  ✗ outcome scorer: SQL returned no rows (expected ≥1 assertion)');
    recordScore(c, 'outcome', 0, 'no-rows', 'outcome.sql produced no assertion rows');
    return 1;
  }
  const passed = rows.filter(([pass]) => listValue(pass) === '1').length;
  const failed = rows.filter(([pass]) => listValue(pass) !== '1').map(([, desc]) => `; ${listValue(desc) || '(no description)'}`).join('');
  const value = `${passed}/${rows.length}`;
  if (passed === rows.length) {
    output(c, `  ✓ outcome: ${value} assertions passed`);
    recordScore(c, 'outcome', 1, value, 'all assertions passed');
    return 0;
  }
  output(c, `  ✗ outcome: ${value} assertions passed; failed: ${failed}`, true);
  recordScore(c, 'outcome', 0, value, failed);
  return 1;
};

export const scoreTrajectoryRequired: Scorer = (c) => {
  const path = join(c.scorerDir, 'tools-required.json');
  const log = join(c.project, 'trajectory.jsonl');
  if (!isFile(path)) return 0;
  if (!isFile(log)) {
    output(c, `  ✗ trajectory_required: ${log} not found (run_arm must produce stream-json)`, true);
    recordScore(c, 'trajectory_required', 0, 'no-jsonl', 'trajectory.jsonl missing');
    return 1;
  }
  const called = toolNames(log);
  let missing = '';
  for (const entry of json(path)) {
    if (typeof entry === 'object' && Array.isArray(entry.any_of)) {
      if (!entry.any_of.some((tool: string) => called.has(tool))) missing += `; any_of(${entry.any_of.join('|')})`;
      continue;
    }
    const tool = typeof entry === 'string' ? entry : entry.tool;
    if (!tool) continue;
    const pre = join(c.project, '.claude/tmb/_l6_pre_step.db');
    if (entry.skip_if_pre_state_sql && isFile(pre) && queryOrEmpty(pre, entry.skip_if_pre_state_sql).split('\n')[0]) {
      output(c, `  ⊘ trajectory_required: ${tool} waived (pre-state condition met)`);
      continue;
    }
    if (!called.has(tool)) missing += `; ${tool}`;
  }
  output(c, missing ? `  ✗ trajectory_required: missing tools: ${missing}` : '  ✓ trajectory_required: all required tools called', !!missing);
  recordScore(c, 'trajectory_required', missing ? 0 : 1, missing ? 'missing' : '', missing || 'all required tools present');
  return missing ? 1 : 0;
};

export const scoreTrajectoryForbidden: Scorer = (c) => {
  const path = join(c.scorerDir, 'tools-forbidden.json');
  const log = join(c.project, 'trajectory.jsonl');
  if (!isFile(path)) return 0;
  if (!isFile(log)) {
    output(c, `  ✗ trajectory_forbidden: ${log} not found`, true);
    recordScore(c, 'trajectory_forbidden', 0, 'no-jsonl', 'trajectory.jsonl missing');
    return 1;
  }
  const called = toolNames(log, true);
  const violation = json(path).filter((tool: string) => called.has(tool)).map((tool: string) => `; ${tool}`).join('');
  output(c, violation ? `  ✗ trajectory_forbidden: forbidden tools called: ${violation}` : '  ✓ trajectory_forbidden: no forbidden tools called', !!violation);
  recordScore(c, 'trajectory_forbidden', violation ? 0 : 1, violation ? 'violation' : '', violation || 'no forbidden tools present');
  return violation ? 1 : 0;
};

export const scoreCost: Scorer = (c) => {
  const path = join(c.scorerDir, 'cost-budget.json');
  const log = join(c.project, 'trajectory.jsonl');
  const data = isFile(log) ? events(log) : [];
  const input = data.filter((e) => e.type === 'assistant').reduce((sum, e) => sum + (e.message?.usage?.input_tokens ?? 0), 0);
  const out = data.filter((e) => e.type === 'assistant').reduce((sum, e) => sum + (e.message?.usage?.output_tokens ?? 0), 0);
  const tokens = input + out;
  const duration = Math.max(0, ...data.filter((e) => e.type === 'result').map((e) => e.duration_ms ?? 0));
  const explanation = `tokens_total=${tokens} (in=${input} out=${out}) duration_ms=${duration}`;
  if (!isFile(path)) {
    output(c, `  ⊘ cost (observational): ${explanation}`);
    recordScore(c, 'cost', 1, String(tokens), explanation);
    return 0;
  }
  const budget = json(path);
  let violation = '';
  if (budget.max_tokens_total && tokens > budget.max_tokens_total) violation += `; tokens(${tokens} > ${budget.max_tokens_total})`;
  if (budget.max_duration_ms && duration > budget.max_duration_ms) violation += `; duration_ms(${duration} > ${budget.max_duration_ms})`;
  if (!violation) {
    output(c, `  ✓ cost: within budget — ${explanation}`);
    recordScore(c, 'cost', 1, String(tokens), explanation);
    return 0;
  }
  const hard = budget.fail_above_max === true;
  output(c, hard ? `  ✗ cost: budget exceeded${violation}` : `  ⚠ cost: soft-warn budget exceeded${violation}`, hard);
  recordScore(c, 'cost', hard ? 0 : 1, String(tokens), `${explanation} ${violation}${hard ? '' : ' (soft)'}`);
  return hard ? 1 : 0;
};

export const scoreFiles: Scorer = (c) => {
  const path = join(c.scorerDir, 'outcome-files.json');
  if (!isFile(path)) return 0;
  let entries: Json[];
  try { entries = json(path).files; if (!Array.isArray(entries)) throw new Error('files must be an array'); }
  catch { output(c, `  ✗ files: invalid JSON in ${path}`, true); return 1; }
  let fail = 0;
  for (const entry of entries) {
    const full = join(c.project, entry.path);
    if (entry.must_exist === true) {
      if (!isFile(full)) { output(c, `  ✗ files: ${entry.path} does not exist`, true); fail = 1; continue; }
      if (entry.min_bytes > 0 && statSync(full).size < entry.min_bytes) {
        output(c, `  ✗ files: ${entry.path} is ${statSync(full).size} bytes, expected >=${entry.min_bytes}`, true); fail = 1; continue;
      }
      output(c, `  ✓ files: ${entry.path} exists${entry.min_bytes > 0 ? ` (>=${entry.min_bytes} bytes)` : ''}`);
    }
    if (entry.must_not_exist === true) {
      const exists = isFile(full);
      output(c, exists ? `  ✗ files: ${entry.path} exists but should not` : `  ✓ files: ${entry.path} does not exist`, exists);
      if (exists) fail = 1;
    }
  }
  return fail;
};

export const scoreCoherence: Scorer = (c) => {
  const path = join(c.scorerDir, 'outcome-coherence.json');
  if (!isFile(path)) return 0;
  let fail = 0, checked = 0;
  for (const [key, raw] of Object.entries(json(path).expected_writes ?? {})) {
    if (!key) continue;
    checked++;
    const value = String(raw);
    const parsed = /^(>=|<=|!=|=)?([0-9]+)$/.exec(value);
    if (!parsed) { output(c, `  ✗ coherence: invalid operator in '${value}' for ${key}`, true); fail = 1; continue; }
    const count = queryOrEmpty(dbPath(c), `SELECT COUNT(*) FROM ${key};`);
    if (!count) { output(c, `  ✗ coherence: query failed for ${key}`, true); fail = 1; continue; }
    const [n, target] = [Number(count), Number(parsed[2])];
    const pass = parsed[1] === '>=' ? n >= target : parsed[1] === '<=' ? n <= target : parsed[1] === '!=' ? n !== target : n === target;
    output(c, `  ${pass ? '✓' : '✗'} coherence: ${key} = ${count} (expected ${value})`, !pass);
    if (!pass) fail = 1;
  }
  if (checked) recordScore(c, 'coherence', 1 - fail, '', fail ? `${fail} of ${checked} check(s) failed` : `${checked} check(s) passed`);
  return fail;
};

export const scoreGit: Scorer = (c) => {
  const path = join(c.scorerDir, 'outcome-git.json');
  if (!isFile(path)) return 0;
  const cfg = json(path);
  const branch = queryOrEmpty(dbPath(c), 'SELECT branch_id FROM tasks ORDER BY id DESC LIMIT 1;');
  const slug = branch.split('/').at(-1) ?? '';
  const target = queryOrEmpty(dbPath(c), "SELECT json_extract(value_json, '$') FROM plugin_config WHERE key='pr_target';") || 'main';
  let fail = 0, checked = 0;
  if (cfg.base_branch_unchanged === true) {
    checked++;
    const prePath = join(c.project, '.claude/tmb/_l5_pre_run_git.json');
    if (!isFile(prePath)) { output(c, `  ✗ git: pre-run snapshot missing at ${prePath} (did l5_run_claude run?)`, true); fail = 1; }
    else {
      const pre = json(prePath).head ?? '';
      const post = gitOrEmpty(c.project, 'rev-parse', target);
      if (!pre || !post) { output(c, `  ✗ git: base branch '${target}' SHA not resolvable (pre=${pre} post=${post})`, true); fail = 1; }
      else if (pre === post) output(c, `  ✓ git: base branch '${target}' unchanged since pre-run snapshot`);
      else {
        const delta = gitOrEmpty(c.project, 'rev-list', '--count', `${pre}..${post}`) || '?';
        output(c, `  ✗ git: base branch '${target}' advanced ${delta} commit(s) during the run. Did bro commit to base?`, true); fail = 1;
      }
    }
  }
  // jq's existing `// null` treats false as null, so this legacy field is a
  // no-op. Changing its policy belongs in a separate scorer behaviour issue.
  for (const worktree of cfg.worktrees ?? []) {
    checked++;
    const path = String(worktree.path ?? '').replaceAll('<slug>', slug);
    const expected = String(worktree.head_branch ?? '').replaceAll('<task.branch_id>', branch);
    const full = join(c.project, path);
    if (!isDir(full)) { output(c, `  ✗ git: worktree path missing: ${path}`, true); fail = 1; continue; }
    const actual = gitOrEmpty(full, 'rev-parse', '--abbrev-ref', 'HEAD');
    if (!actual) { output(c, `  ✗ git: could not resolve HEAD branch in ${path}`, true); fail = 1; continue; }
    if (expected) {
      output(c, actual === expected ? `  ✓ git: ${path} HEAD on '${actual}'` : `  ✗ git: ${path} HEAD on '${actual}' (expected '${expected}')`, actual !== expected);
      if (actual !== expected) fail = 1;
    }
    for (const forbidden of worktree.head_not_branch ?? []) {
      if (actual === forbidden) { output(c, `  ✗ git: ${path} HEAD on forbidden branch '${forbidden}'`, true); fail = 1; }
    }
  }
  if (checked) recordScore(c, 'git', 1 - fail, '', fail ? `${fail} of ${checked} check(s) failed` : `${checked} check(s) passed`);
  return fail;
};

export function usageInLog(path: string, name: string): boolean {
  if (!path || !name || !isFile(path)) return false;
  const raw = readFileSync(path, 'utf8');
  const bare = name.replace(/^[^:]*:/, '');
  const data = raw.split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line) as Json]; } catch { return []; } });
  const skills = data.filter((e) => e.type === 'assistant').flatMap((e) => e.message?.content ?? [])
    .filter((e) => e.type === 'tool_use' && e.name === 'Skill').map((e) => e.input?.skill ?? '');
  if (skills.some((skill) => skill.replace(/^[^:]*:/, '') === bare)) return true;
  const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`Launching skill:[^"\\n]*(?:^|:|\\b)${escaped}\\b`, 'm').test(raw)) return true;
  if (new RegExp(`Skill prompt: showing "[^"\\n]*${escaped}"`).test(raw)) return true;
  if (name !== bare) {
    const plugin = name.split(':')[0];
    if (data.some((e) => e.type === 'system' && e.subtype === 'init' && (e.plugins ?? []).some((p: string) => p === plugin || p.replace(/@.*/, '') === plugin))) return true;
  }
  return false;
}
export function materializedOnDisk(project: string, agent: string, skill: string): boolean {
  if (!project || !agent || !skill) return false;
  const bare = skill.replace(/^[^:]*:/, '');
  const path = join(project, '.claude', agent === 'bro' ? 'CLAUDE.md' : `agents/${agent}.md`);
  if (!isFile(path)) return false;
  const text = readFileSync(path, 'utf8');
  if (agent === 'bro') return text.includes(bare);
  const skills = /^skills:\s*\[(.*)\][ \t]*$/m.exec(text);
  return skills ? skills[1].split(',').map((entry) => entry.trim()).includes(bare) : false;
}
export const scoreUsage: Scorer = (c) => {
  const path = join(c.scorerDir, 'outcome-usage.json');
  const log = join(c.project, 'trajectory.jsonl');
  if (!isFile(path)) return 0;
  if (!isFile(log)) {
    output(c, `  ✗ usage: ${log} not found (runner must produce stream-json)`, true);
    recordScore(c, 'usage', 0, 'no-log', 'trajectory.jsonl missing'); return 1;
  }
  let missing = '', checked = 0;
  for (const name of json(path).skills_used ?? []) {
    if (!name) continue;
    checked++;
    const pass = usageInLog(log, name);
    output(c, pass ? `  ✓ usage: '${name}' invoked (run log)` : `  ✗ usage: '${name}' not found in run log`, !pass);
    if (!pass) missing += `; ${name}`;
  }
  if (checked) recordScore(c, 'usage', missing ? 0 : 1, missing ? 'missing' : String(checked), missing || 'all skills used');
  return missing ? 1 : 0;
};
export const scoreMaterialized: Scorer = (c) => {
  const path = join(c.scorerDir, 'outcome-materialized.json');
  if (!isFile(path)) return 0;
  let missing = '', checked = 0;
  for (const { agent, skill } of json(path).materialized ?? []) {
    if (!agent || !skill) continue;
    checked++;
    const pass = materializedOnDisk(c.project, agent, skill);
    output(c, pass ? `  ✓ materialized: '${skill}' into '${agent}' (on disk)` : `  ✗ materialized: '${skill}' not materialized into '${agent}'`, !pass);
    if (!pass) missing += `; ${skill}→${agent}`;
  }
  if (checked) recordScore(c, 'materialized', missing ? 0 : 1, missing ? 'missing' : String(checked), missing || 'all agents materialized');
  return missing ? 1 : 0;
};
export const scoreNoSandbox: Scorer = (c) => {
  const path = join(c.project, '.claude/settings.local.json');
  const findings: string[] = [];
  if (isFile(path) && Object.hasOwn(json(path), 'sandbox')) findings.push('sandbox block in .claude/settings.local.json');
  if (isFile(dbPath(c)) && queryOrEmpty(dbPath(c), "SELECT value_json FROM plugin_config WHERE key = 'sandbox_enforcement';") === '"yes"') findings.push('sandbox_enforcement = yes');
  if (!findings.length) { output(c, '  ✓ no_sandbox: no sandbox block'); return 0; }
  const found = findings.join('; ');
  output(c, `  ✗ no_sandbox: ${found} (TEST MODE pins the sandbox answer to no)`, true);
  recordScore(c, 'no_sandbox', 0, 'present', found);
  return 1;
};

export const scorers: Readonly<Record<string, Scorer>> = {
  outcome: scoreOutcome, trajectory_required: scoreTrajectoryRequired, trajectory_forbidden: scoreTrajectoryForbidden,
  cost: scoreCost, files: scoreFiles, coherence: scoreCoherence, git: scoreGit, usage: scoreUsage,
  materialized: scoreMaterialized, no_sandbox: scoreNoSandbox,
};
export function score(name: string, c: ScoreContext): number {
  const scorer = scorers[name];
  if (!scorer) throw new Error(`unknown scorer: ${name}`);
  try { return scorer(c); }
  catch (error) { output(c, `  ✗ ${name}: ${error instanceof Error ? error.message : error}`, true); return 1; }
}
export function scoreAll(c: ScoreContext): number {
  return Object.keys(scorers).reduce((failures, name) => failures + score(name, c), 0);
}
