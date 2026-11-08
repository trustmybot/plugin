// L5/L6 scorers (issue #110). Each scorer takes a project dir, flow name, scorer config dir and
// run id, returns 0 on pass and 1 on fail, and writes one row to the eval_results table.
//
// Industry-standard pattern (Inspect AI / AgentEvals): a Task is graded by multiple scorers.
// Outcome is primary; trajectory subset/superset are secondary structural checks; cost is
// observability.
//
// Sources:
//   https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
//   https://docs.langchain.com/langsmith/trajectory-evals
//   https://inspect.aisi.org.uk/scorers.html
//
// Usage:
//   node --experimental-strip-types --experimental-sqlite tests/l5-l6/lib/scorers.ts \
//     score-all <project> <flow> <scorer_dir> <run_id>
// Runs every scorer in order, prints each one's lines and exits with the fail count.
//
// Config and log values keep the semantics of the jq filters this module replaced: `a // b`
// falls back on null and false, a missing or unparseable config reads as empty, and a
// run-log line that fails to parse ends the log.

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export type Sink = (line: string, failed: boolean) => void;

export interface ScoreContext {
  project: string;
  flow: string;
  scorerDir: string;
  runId: string;
  out?: Sink;
}

export type Scorer = (c: ScoreContext) => number;

type Json = unknown;
type Row = string[];

const processSink: Sink = (line, failed) => {
  (failed ? process.stderr : process.stdout).write(`${line}\n`);
};

function say(c: { out?: Sink }, line: string, failed = false): void {
  (c.out ?? processSink)(line, failed);
}

const dbPath = (project: string): string => join(project, '.claude', 'tmb', 'trajectory.db');
const runLogPath = (project: string): string => join(project, 'trajectory.jsonl');

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// ---- jq-equivalent value helpers ---------------------------------------------------------

function isObject(v: Json): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function orElse(v: Json, fallback: Json): Json {
  return v === undefined || v === null || v === false ? fallback : v;
}

function field(v: Json, key: string): Json {
  if (v === null || v === undefined) return null;
  if (!isObject(v)) throw new TypeError(`cannot index ${typeof v} with "${key}"`);
  return v[key] ?? null;
}

function rawText(v: Json): string {
  if (typeof v === 'string') return v;
  return v === undefined ? 'null' : JSON.stringify(v);
}

function values(v: Json): Json[] {
  if (Array.isArray(v)) return v;
  if (isObject(v)) return Object.values(v);
  return [];
}

function readJson(path: string): Json {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function readEvents(path: string): { events: Json[]; complete: boolean } {
  const events: Json[] = [];
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { events, complete: false };
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      return { events, complete: false };
    }
  }
  return { events, complete: true };
}

function toolUses(event: Json): Record<string, Json>[] {
  const uses: Record<string, Json>[] = [];
  let content: Json;
  try {
    content = field(field(event, 'message'), 'content');
  } catch {
    return uses;
  }
  for (const item of values(content)) {
    if (item !== null && !isObject(item)) break;
    if (isObject(item) && item.type === 'tool_use') uses.push(item);
  }
  return uses;
}

function toolsCalled(path: string, topLevelOnly: boolean): Set<string> {
  const names = new Set<string>();
  for (const event of readEvents(path).events) {
    if (!isObject(event) || event.type !== 'assistant') continue;
    if (topLevelOnly && event.parent_tool_use_id !== null && event.parent_tool_use_id !== undefined) continue;
    for (const use of toolUses(event)) names.add(rawText(use.name ?? null));
  }
  return names;
}

// ---- sqlite (mirrors the sqlite3 CLI in list mode) ---------------------------------------

function openDb(path: string): DatabaseSync {
  return new DatabaseSync(path, { enableDoubleQuotedStringLiterals: true, enableForeignKeyConstraints: false });
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) return String(v);
    if (Math.abs(v) < 1e15) return `${v}.0`;
    const [mantissa, exponent] = v.toExponential().split('e');
    return `${mantissa.includes('.') ? mantissa : `${mantissa}.0`}e${exponent}`;
  }
  if (v instanceof Uint8Array) return Buffer.from(v).toString('utf8');
  return String(v);
}

export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let content = false;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      content = true;
      i = j + 1;
      continue;
    }
    if (ch === ';') {
      if (content) statements.push(sql.slice(start, i + 1));
      start = i + 1;
      content = false;
      i++;
      continue;
    }
    if (!/\s/.test(ch)) content = true;
    i++;
  }
  if (content) statements.push(sql.slice(start));
  return statements;
}

function runStatement(db: DatabaseSync, sql: string): Row[] {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  statement.setReturnArrays(true);
  return (statement.all() as unknown as unknown[][]).map((row) => row.map(cell));
}

// `sqlite3 db < file 2>&1`: every statement runs; an error prints a line and the script goes on.
function runScript(path: string, sql: string): Row[] {
  let db: DatabaseSync;
  try {
    db = openDb(path);
  } catch (error) {
    return [[`Error: ${(error as Error).message}`]];
  }
  try {
    const rows: Row[] = [];
    for (const statement of splitStatements(sql)) {
      try {
        rows.push(...runStatement(db, statement));
      } catch (error) {
        rows.push([`Parse error: ${(error as Error).message}`]);
      }
    }
    return rows;
  } finally {
    db.close();
  }
}

// `sqlite3 db "<sql>" 2>/dev/null`: statements run until the first error; output is what printed.
function queryLines(path: string, sql: string): string[] {
  let db: DatabaseSync;
  try {
    db = openDb(path);
  } catch {
    return [];
  }
  const lines: string[] = [];
  try {
    for (const statement of splitStatements(sql)) {
      lines.push(...runStatement(db, statement).map((row) => row.join('|')));
    }
  } catch {
    return lines;
  } finally {
    db.close();
  }
  return lines;
}

const queryText = (path: string, sql: string): string => queryLines(path, sql).join('\n');

export function recordScore(
  db: string,
  runId: string,
  flow: string,
  scorer: string,
  pass: 0 | 1,
  value: string,
  explanation: string,
): void {
  try {
    const conn = openDb(db);
    try {
      conn
        .prepare(
          `INSERT INTO eval_results (run_id, flow_name, scorer_name, pass, value, explanation, created_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
        )
        .run(runId, flow, scorer, pass, value === '' ? null : value, explanation === '' ? null : explanation);
    } finally {
      conn.close();
    }
  } catch {
    // The score row is a receipt; a DB without eval_results still scores.
  }
}

function git(dir: string, ...args: string[]): string | null {
  const run = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (run.error || run.status !== 0) return null;
  return run.stdout.replace(/\n+$/, '');
}

// ---- run-log usage detection (issue #119) ------------------------------------------------
//
// Detection signals, in priority order:
//   1. stream-json tool_use {"type":"tool_use","name":"Skill","input":{"skill":"<plugin>:<name>"}}.
//      CC delivers skill names plugin-prefixed (e.g. "tmb:tmb_planning"); a bare name also matches.
//   2. tool_result text "Launching skill: <plugin>:<name>".
//   3. system/init event plugins[] array: plugin presence (coarse; proves the plugin loaded,
//      not that a specific skill fired). Only for a plugin-prefixed name.
//   4. --debug line: Skill prompt: showing "<plugin>:<skill>".
//
// Signals 1 and 3 answer as `jq -e` did: the last matching event decides.
//
// KNOWN LIMITATION: subagent (swe) attribution. swe runs in its own CC session whose
// stream-json is not merged into bro's run log, so a skill swe loads leaves no tool_use here.
// Row 05 (swe dispatch) depends on swe-side skill usage and is intentionally not pointed at
// this helper. Do not attempt swe-via-Task attribution here.

const stripPrefix = (s: string): string => s.replace(/^[^:]*:/, '');

function lastAnswer(path: string, answers: (event: Json) => boolean[]): boolean {
  const { events, complete } = readEvents(path);
  if (!complete) return false;
  let last: boolean | undefined;
  try {
    for (const event of events) {
      for (const answer of answers(event)) last = answer;
    }
  } catch {
    return false;
  }
  return last === true;
}

function grepLines(text: string, pattern: string): boolean {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return false;
  }
  return text.split('\n').some((line) => re.test(line));
}

export function usageInLog(runLog: string, name: string): boolean {
  if (!runLog || !isFile(runLog) || !name) return false;
  const bare = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;

  const skillAnswers = (event: Json): boolean[] => {
    if (!isObject(event) || event.type !== 'assistant') return [];
    return toolUses(event)
      .filter((use) => use.name === 'Skill')
      .map((use) => {
        const skill = orElse(field(use.input ?? null, 'skill'), '');
        if (typeof skill !== 'string') throw new TypeError('skill is not a string');
        return skill === bare || stripPrefix(skill) === bare;
      });
  };
  if (lastAnswer(runLog, skillAnswers)) return true;

  const text = readFileSync(runLog, 'utf8');
  if (grepLines(text, `Launching skill:[^"]*(^|:|\\b)${bare}\\b`)) return true;
  if (grepLines(text, `Skill prompt: showing "[^"]*${bare}"`)) return true;

  if (name !== bare) {
    const plugin = name.slice(0, name.indexOf(':'));
    const pluginAnswers = (event: Json): boolean[] => {
      if (!isObject(event) || event.type !== 'system' || event.subtype !== 'init') return [];
      const plugins = orElse(event.plugins ?? null, []);
      if (!Array.isArray(plugins)) throw new TypeError('plugins is not an array');
      return [
        plugins.some((p) => {
          if (p === plugin) return true;
          if (typeof p !== 'string') throw new TypeError('plugin is not a string');
          return p.replace(/@.*/, '') === plugin;
        }),
      ];
    };
    if (lastAnswer(runLog, pluginAnswers)) return true;
  }
  return false;
}

// ---- on-disk consuming-agent materialization (issue #95) ---------------------------------
//
// When bro installs a cheatcode for a specific agent, cheatcode_install (#115) materializes that
// agent's prompt surface into the user project's .claude/:
//   - a non-bro target: the global agent md copied to <project>/.claude/agents/<agent>.md with
//     the skill added to its skills: [...] frontmatter
//   - target=bro: <project>/.claude/CLAUDE.md written or edited to reference the skill
// L6 row 44 once asserted only the DB attachment rows, so a materialization that never touched
// disk still passed. This reads the filesystem so the row proves the copy and header edit.
// <skill> matches bare or plugin-prefixed; the bare form is compared, and a substring of a longer
// skill name does not match an agent md entry.

export function materializedOnDisk(project: string, agent: string, skill: string): boolean {
  if (!project || !agent || !skill) return false;
  const bare = skill.includes(':') ? skill.slice(skill.indexOf(':') + 1) : skill;

  if (agent === 'bro') {
    const claudeMd = join(project, '.claude', 'CLAUDE.md');
    if (!isFile(claudeMd)) return false;
    return readFileSync(claudeMd, 'utf8').split('\n').some((line) => line.includes(bare));
  }

  const agentMd = join(project, '.claude', 'agents', `${agent}.md`);
  if (!isFile(agentMd)) return false;
  const skillsLine = readFileSync(agentMd, 'utf8')
    .split('\n')
    .find((line) => /^skills:\s*\[.*\]\s*$/.test(line));
  if (!skillsLine) return false;
  const inner = skillsLine.slice(skillsLine.indexOf('[') + 1, skillsLine.lastIndexOf(']'));
  return inner.split(',').some((entry) => entry.trim() === bare);
}

// ---- scorers -----------------------------------------------------------------------------

// Runs scorer_dir/outcome.sql against the project DB. Each row returned is pass(0|1)|description;
// all rows must pass for the scorer to pass.
export const scoreOutcome: Scorer = (c) => {
  const db = dbPath(c.project);
  const sqlPath = join(c.scorerDir, 'outcome.sql');
  if (!isFile(sqlPath)) {
    say(c, `  ⊘ outcome scorer skipped: ${sqlPath} not found`);
    recordScore(db, c.runId, c.flow, 'outcome', 1, '', 'no-config');
    return 0;
  }

  const results = runScript(db, readFileSync(sqlPath, 'utf8'))
    .map((row) => row.join('|'))
    .join('\n')
    .replace(/\n+$/, '');
  if (results === '') {
    say(c, '  ✗ outcome scorer: SQL returned no rows (expected ≥1 assertion)');
    recordScore(db, c.runId, c.flow, 'outcome', 0, 'no-rows', 'outcome.sql produced no assertion rows');
    return 1;
  }

  let total = 0;
  let passed = 0;
  let failedDescs = '';
  for (const line of results.split('\n')) {
    total++;
    const bar = line.indexOf('|');
    const pass = bar === -1 ? line : line.slice(0, bar);
    const desc = bar === -1 ? '' : line.slice(bar + 1);
    if (pass === '1') passed++;
    else failedDescs += `; ${desc || '(no description)'}`;
  }
  if (passed === total) {
    say(c, `  ✓ outcome: ${passed}/${total} assertions passed`);
    recordScore(db, c.runId, c.flow, 'outcome', 1, `${passed}/${total}`, 'all assertions passed');
    return 0;
  }
  say(c, `  ✗ outcome: ${passed}/${total} assertions passed; failed: ${failedDescs}`, true);
  recordScore(db, c.runId, c.flow, 'outcome', 0, `${passed}/${total}`, failedDescs);
  return 1;
};

// Reads scorer_dir/tools-required.json (a JSON array). Each entry is either:
//   - a plain string (tool name always required), or
//   - an object {"tool":"name","skip_if_pre_state_sql":"SELECT 1 FROM ..."} where the SQL runs
//     against $project/.claude/tmb/_l6_pre_step.db when that file exists; a returned row waives
//     the requirement (the tool is only needed when the pre-state lacks the resource). In L5 mode
//     (no pre-step DB) the condition is ignored and the tool stays required, or
//   - an object {"any_of":["toolA","toolB"]} satisfied when at least one listed tool was called
//     (missing is reported as any_of(toolA|toolB)).
// Asserts every non-waived tool was called at least once (superset semantics per LangSmith).
// Order-agnostic; subagent calls count.
export const scoreTrajectoryRequired: Scorer = (c) => {
  const db = dbPath(c.project);
  const preStepDb = join(c.project, '.claude', 'tmb', '_l6_pre_step.db');
  const jsonl = runLogPath(c.project);
  const reqPath = join(c.scorerDir, 'tools-required.json');

  if (!isFile(reqPath)) return 0;
  if (!isFile(jsonl)) {
    say(c, `  ✗ trajectory_required: ${jsonl} not found (run_arm must produce stream-json)`, true);
    recordScore(db, c.runId, c.flow, 'trajectory_required', 0, 'no-jsonl', 'trajectory.jsonl missing');
    return 1;
  }

  const called = toolsCalled(jsonl, false);
  const required = readJson(reqPath);
  const entries = Array.isArray(required) ? required : [];
  let missing = '';

  for (const entry of entries) {
    if (isObject(entry) && 'any_of' in entry) {
      const alts = values(entry.any_of).map(rawText);
      if (!alts.some((alt) => alt !== '' && called.has(alt))) missing += `; any_of(${alts.join('|')})`;
      continue;
    }

    let tool: string;
    let skipSql = '';
    if (typeof entry === 'string') {
      tool = entry;
    } else if (isObject(entry) || entry === null) {
      tool = rawText(field(entry, 'tool'));
      const skip = orElse(field(entry, 'skip_if_pre_state_sql'), '');
      skipSql = skip === '' ? '' : rawText(skip);
    } else {
      tool = '';
    }
    if (tool === '') continue;

    if (skipSql !== '' && isFile(preStepDb)) {
      const hit = queryLines(preStepDb, skipSql)[0] ?? '';
      if (hit !== '') {
        say(c, `  ⊘ trajectory_required: ${tool} waived (pre-state condition met)`);
        continue;
      }
    }

    if (!called.has(tool)) missing += `; ${tool}`;
  }

  if (missing === '') {
    say(c, '  ✓ trajectory_required: all required tools called');
    recordScore(db, c.runId, c.flow, 'trajectory_required', 1, '', 'all required tools present');
    return 0;
  }
  say(c, `  ✗ trajectory_required: missing tools: ${missing}`, true);
  recordScore(db, c.runId, c.flow, 'trajectory_required', 0, 'missing', missing);
  return 1;
};

// Reads scorer_dir/tools-forbidden.json. Asserts none of the listed tools were called by bro
// (top-level only; a subagent call is not attributed to bro).
export const scoreTrajectoryForbidden: Scorer = (c) => {
  const db = dbPath(c.project);
  const jsonl = runLogPath(c.project);
  const forbPath = join(c.scorerDir, 'tools-forbidden.json');

  if (!isFile(forbPath)) return 0;
  if (!isFile(jsonl)) {
    say(c, `  ✗ trajectory_forbidden: ${jsonl} not found`, true);
    recordScore(db, c.runId, c.flow, 'trajectory_forbidden', 0, 'no-jsonl', 'trajectory.jsonl missing');
    return 1;
  }

  const called = toolsCalled(jsonl, true);
  let violation = '';
  for (const tool of values(readJson(forbPath)).map(rawText)) {
    if (tool !== '' && called.has(tool)) violation += `; ${tool}`;
  }

  if (violation === '') {
    say(c, '  ✓ trajectory_forbidden: no forbidden tools called');
    recordScore(db, c.runId, c.flow, 'trajectory_forbidden', 1, '', 'no forbidden tools present');
    return 0;
  }
  say(c, `  ✗ trajectory_forbidden: forbidden tools called: ${violation}`, true);
  recordScore(db, c.runId, c.flow, 'trajectory_forbidden', 0, 'violation', violation);
  return 1;
};

function usageTotals(path: string): { input: number; output: number; duration: number } {
  const zero = { input: 0, output: 0, duration: 0 };
  if (!isFile(path)) return zero;
  const { events, complete } = readEvents(path);
  if (!complete) return zero;
  const sum = (key: string): number =>
    events
      .filter((e) => field(e, 'type') === 'assistant')
      .reduce<number>((acc, e) => acc + Number(orElse(field(field(field(e, 'message'), 'usage'), key), 0)), 0);
  try {
    const durations = events
      .filter((e) => field(e, 'type') === 'result')
      .map((e) => Number(orElse(field(e, 'duration_ms'), 0)));
    return {
      input: sum('input_tokens'),
      output: sum('output_tokens'),
      duration: durations.length ? Math.max(...durations) : 0,
    };
  } catch {
    return zero;
  }
}

// Reads scorer_dir/cost-budget.json with {max_tokens_total, max_duration_ms, fail_above_max}.
// Reports tokens and duration from trajectory.jsonl; fails only when a cap is exceeded and
// fail_above_max is true.
export const scoreCost: Scorer = (c) => {
  const db = dbPath(c.project);
  const budgetPath = join(c.scorerDir, 'cost-budget.json');
  const { input, output, duration } = usageTotals(runLogPath(c.project));
  const totalTokens = input + output;
  const explanation = `tokens_total=${totalTokens} (in=${input} out=${output}) duration_ms=${duration}`;

  if (!isFile(budgetPath)) {
    say(c, `  ⊘ cost (observational): ${explanation}`);
    recordScore(db, c.runId, c.flow, 'cost', 1, String(totalTokens), explanation);
    return 0;
  }

  const budget = readJson(budgetPath);
  const setting = (key: string, fallback: Json): string => {
    try {
      return rawText(orElse(field(budget ?? null, key), fallback));
    } catch {
      return '';
    }
  };
  const maxTokens = setting('max_tokens_total', 0);
  const maxLatency = setting('max_duration_ms', 0);
  const failAbove = setting('fail_above_max', false);
  const exceeds = (actual: number, cap: string): boolean =>
    cap !== '0' && /^\s*-?\d+\s*$/.test(cap) && actual > Number(cap);

  let violation = '';
  if (exceeds(totalTokens, maxTokens)) violation += `; tokens(${totalTokens} > ${maxTokens})`;
  if (exceeds(duration, maxLatency)) violation += `; duration_ms(${duration} > ${maxLatency})`;

  if (violation === '') {
    say(c, `  ✓ cost: within budget — ${explanation}`);
    recordScore(db, c.runId, c.flow, 'cost', 1, String(totalTokens), explanation);
    return 0;
  }
  if (failAbove === 'true') {
    say(c, `  ✗ cost: budget exceeded${violation}`, true);
    recordScore(db, c.runId, c.flow, 'cost', 0, String(totalTokens), `${explanation} ${violation}`);
    return 1;
  }
  say(c, `  ⚠ cost: soft-warn budget exceeded${violation}`);
  recordScore(db, c.runId, c.flow, 'cost', 1, String(totalTokens), `${explanation} ${violation} (soft)`);
  return 0;
};

// Reads <flow_dir>/outcome-files.json. Asserts file existence, absence and minimum byte size for
// each entry under <workspace_dir>. Records no eval_results row.
export function scoreFiles(c: { scorerDir: string; project: string; out?: Sink }): number {
  const budgetFile = join(c.scorerDir, 'outcome-files.json');
  if (!isFile(budgetFile)) return 0;

  const ctx = c;
  const cfg = readJson(budgetFile);
  let files: Json;
  try {
    files = field(cfg ?? null, 'files');
  } catch {
    files = null;
  }
  if (cfg === undefined || !(Array.isArray(files) || isObject(files))) {
    say(ctx, `  ✗ files: invalid JSON in ${budgetFile}`, true);
    return 1;
  }

  let fail = 0;
  for (const entry of values(files)) {
    let path: string;
    let mustExist: string;
    let mustNotExist: string;
    let minBytes: string;
    try {
      path = rawText(field(entry, 'path'));
      mustExist = rawText(orElse(field(entry, 'must_exist'), false));
      mustNotExist = rawText(orElse(field(entry, 'must_not_exist'), false));
      minBytes = rawText(orElse(field(entry, 'min_bytes'), 0));
    } catch {
      continue;
    }
    const min = /^\s*-?\d+\s*$/.test(minBytes) ? Number(minBytes) : 0;
    const fullPath = join(c.project, path);

    if (mustExist === 'true') {
      if (!isFile(fullPath)) {
        say(ctx, `  ✗ files: ${path} does not exist`, true);
        fail = 1;
        continue;
      }
      if (min > 0) {
        const actual = statSync(fullPath).size;
        if (actual < min) {
          say(ctx, `  ✗ files: ${path} is ${actual} bytes, expected >=${minBytes}`, true);
          fail = 1;
          continue;
        }
        say(ctx, `  ✓ files: ${path} exists (>=${minBytes} bytes)`);
      } else {
        say(ctx, `  ✓ files: ${path} exists`);
      }
    }

    if (mustNotExist === 'true') {
      if (isFile(fullPath)) {
        say(ctx, `  ✗ files: ${path} exists but should not`, true);
        fail = 1;
      } else {
        say(ctx, `  ✓ files: ${path} does not exist`);
      }
    }
  }
  return fail;
}

const OPERATORS = ['>=', '<=', '!=', '='] as const;

// Reads scorer_dir/outcome-coherence.json and asserts row counts per table satisfy the
// comparison. Catches empty-table doctrine violations (e.g. a planning flow that wrote no
// discussions row) without each flow spelling out the SQL in outcome.sql.
//
// Schema: {"expected_writes": {"<table>": "<op><N>", "<table> WHERE <where-clause>": "<op><N>"}}
// Operators: ">=N", "<=N", "=N", "!=N", or bare "N" (meaning "=N").
export const scoreCoherence: Scorer = (c) => {
  const cfgPath = join(c.scorerDir, 'outcome-coherence.json');
  const db = dbPath(c.project);
  if (!isFile(cfgPath)) return 0;

  let expected: Json;
  try {
    expected = orElse(field(readJson(cfgPath) ?? null, 'expected_writes'), {});
  } catch {
    expected = {};
  }
  const entries = isObject(expected) ? Object.entries(expected) : [];

  let fail = 0;
  let checked = 0;
  for (const [key, rawOp] of entries) {
    if (key === '') continue;
    checked++;
    const opValue = rawText(rawOp);

    const at = key.indexOf(' WHERE ');
    const table = at === -1 ? key : key.slice(0, at);
    const whereClause = at === -1 ? '' : ` WHERE ${key.slice(at + ' WHERE '.length)}`;

    let op = OPERATORS.find((candidate) => opValue.startsWith(candidate));
    let num: string;
    if (op) {
      num = opValue.slice(op.length);
    } else if (/^[0-9]+$/.test(opValue)) {
      op = '=';
      num = opValue;
    } else {
      say(c, `  ✗ coherence: invalid operator in '${opValue}' for ${key}`, true);
      fail = 1;
      continue;
    }

    const count = queryText(db, `SELECT COUNT(*) FROM ${table}${whereClause};`);
    if (count === '') {
      say(c, `  ✗ coherence: query failed for ${table}${whereClause}`, true);
      fail = 1;
      continue;
    }

    const n = Number(count);
    const target = Number(num);
    let pass = false;
    if (/^\s*-?\d+\s*$/.test(num)) {
      if (op === '>=') pass = n >= target;
      else if (op === '<=') pass = n <= target;
      else if (op === '=') pass = n === target;
      else pass = n !== target;
    }

    if (pass) {
      say(c, `  ✓ coherence: ${table}${whereClause} = ${count} (expected ${opValue})`);
    } else {
      say(c, `  ✗ coherence: ${table}${whereClause} = ${count} (expected ${opValue})`, true);
      fail = 1;
    }
  }

  if (checked === 0) return 0;
  recordScore(
    db,
    c.runId,
    c.flow,
    'coherence',
    fail === 0 ? 1 : 0,
    '',
    fail === 0 ? `${checked} check(s) passed` : `${fail} of ${checked} check(s) failed`,
  );
  return fail;
};

// Reads scorer_dir/outcome-git.json and asserts git-state invariants the flow must hold
// post-run: catches "bro committed to dev directly", "worktree on detached HEAD" and
// "uncommitted slop in worktree", failures that look like a passing flow to the trajectory and
// DB scorers.
//
// Schema:
//   {
//     "base_branch_unchanged":   true,     // base = pr_target config; tip must match the pre-run snapshot
//     "uncommitted_in_worktree": false,    // the most-recent task's worktree
//     "worktrees": [
//       {
//         "path":            ".claude/worktrees/<slug>",  // <slug> = most-recent tasks.branch_id slug
//         "head_branch":     "<task.branch_id>",          // literal branch name or placeholder
//         "head_not_branch": ["dev", "main"]              // HEAD is not on any of these
//       }
//     ]
//   }
export const scoreGit: Scorer = (c) => {
  const cfgPath = join(c.scorerDir, 'outcome-git.json');
  const db = dbPath(c.project);
  if (!isFile(cfgPath)) return 0;

  const cfg = readJson(cfgPath) ?? null;
  const setting = (v: () => Json): Json => {
    try {
      return v();
    } catch {
      return undefined;
    }
  };

  let fail = 0;
  let checked = 0;

  const taskBranch = queryText(db, 'SELECT branch_id FROM tasks ORDER BY id DESC LIMIT 1;');
  const taskSlug = taskBranch.slice(taskBranch.lastIndexOf('/') + 1);
  const prTarget =
    queryText(db, "SELECT json_extract(value_json, '$') FROM plugin_config WHERE key='pr_target';") || 'main';

  // base_branch_unchanged: the base tip must match the snapshot l5_run_claude took just before
  // bro fired, so setup commits a flow's run.sh made beforehand do not count.
  if (rawText(setting(() => orElse(field(cfg, 'base_branch_unchanged'), false))) === 'true') {
    checked++;
    const preRun = join(c.project, '.claude', 'tmb', '_l5_pre_run_git.json');
    if (!isFile(preRun)) {
      say(c, `  ✗ git: pre-run snapshot missing at ${preRun} (did l5_run_claude run?)`, true);
      fail = 1;
    } else {
      const head = setting(() => orElse(field(readJson(preRun) ?? null, 'head'), ''));
      const preHead = head === undefined ? '' : rawText(head);
      const postHead = git(c.project, 'rev-parse', prTarget) ?? '';
      if (preHead === '' || postHead === '') {
        say(c, `  ✗ git: base branch '${prTarget}' SHA not resolvable (pre=${preHead} post=${postHead})`, true);
        fail = 1;
      } else if (preHead === postHead) {
        say(c, `  ✓ git: base branch '${prTarget}' unchanged since pre-run snapshot`);
      } else {
        const delta = git(c.project, 'rev-list', '--count', `${preHead}..${postHead}`) ?? '?';
        say(c, `  ✗ git: base branch '${prTarget}' advanced ${delta} commit(s) during the run. Did bro commit to base?`, true);
        fail = 1;
      }
    }
  }

  // uncommitted_in_worktree: the most-recent task's worktree must be clean. The setting reads as
  // `.uncommitted_in_worktree // null`, the jq filter this replaced, under which false is null.
  const uncommitted = rawText(setting(() => orElse(field(cfg, 'uncommitted_in_worktree'), null)));
  const taskWorktree = join(c.project, '.claude', 'worktrees', taskSlug);
  if (uncommitted === 'false' && taskSlug !== '' && isDir(taskWorktree)) {
    checked++;
    const dirty = git(taskWorktree, 'status', '--porcelain') ?? '';
    if (dirty === '') {
      say(c, `  ✓ git: worktree '${taskSlug}' is clean (no uncommitted changes)`);
    } else {
      say(c, `  ✗ git: worktree '${taskSlug}' has uncommitted changes:`, true);
      for (const line of dirty.split('\n').slice(0, 5)) say(c, line, true);
      fail = 1;
    }
  }

  const worktrees = setting(() => orElse(field(cfg, 'worktrees'), []));
  for (const wt of Array.isArray(worktrees) ? worktrees : []) {
    checked++;
    const text = (key: string): string => {
      const v = setting(() => orElse(field(wt, key), ''));
      return v === undefined ? '' : rawText(v);
    };
    const wtPath = text('path').replaceAll('<slug>', taskSlug);
    const wtHeadShould = text('head_branch').replaceAll('<task.branch_id>', taskBranch);

    const fullPath = join(c.project, wtPath);
    if (!isDir(fullPath)) {
      say(c, `  ✗ git: worktree path missing: ${wtPath}`, true);
      fail = 1;
      continue;
    }

    const actual = git(fullPath, 'rev-parse', '--abbrev-ref', 'HEAD') ?? '';
    if (actual === '') {
      say(c, `  ✗ git: could not resolve HEAD branch in ${wtPath}`, true);
      fail = 1;
      continue;
    }

    if (wtHeadShould !== '') {
      if (actual === wtHeadShould) {
        say(c, `  ✓ git: ${wtPath} HEAD on '${actual}'`);
      } else {
        say(c, `  ✗ git: ${wtPath} HEAD on '${actual}' (expected '${wtHeadShould}')`, true);
        fail = 1;
      }
    }

    const notBranches = setting(() => orElse(field(wt, 'head_not_branch'), []));
    for (const forbidden of Array.isArray(notBranches) ? notBranches.map(rawText) : []) {
      if (actual === forbidden) {
        say(c, `  ✗ git: ${wtPath} HEAD on forbidden branch '${forbidden}'`, true);
        fail = 1;
      }
    }
  }

  if (checked === 0) return 0;
  recordScore(
    db,
    c.runId,
    c.flow,
    'git',
    fail === 0 ? 1 : 0,
    '',
    fail === 0 ? `${checked} check(s) passed` : `${fail} of ${checked} check(s) failed`,
  );
  return fail;
};

// Reads scorer_dir/outcome-usage.json: {"skills_used": ["tmb_planning", "tmb:tmb_review"]}, the
// skill or plugin names bro must have invoked this row, each checked against the run log by
// usageInLog. Only bro-side skills can be asserted (see usageInLog's known limitation).
export const scoreUsage: Scorer = (c) => {
  const cfgPath = join(c.scorerDir, 'outcome-usage.json');
  const db = dbPath(c.project);
  const runLog = runLogPath(c.project);
  if (!isFile(cfgPath)) return 0;

  if (!isFile(runLog)) {
    say(c, `  ✗ usage: ${runLog} not found (runner must produce stream-json)`, true);
    recordScore(db, c.runId, c.flow, 'usage', 0, 'no-log', 'trajectory.jsonl missing');
    return 1;
  }

  let names: Json;
  try {
    names = orElse(field(readJson(cfgPath) ?? null, 'skills_used'), []);
  } catch {
    names = [];
  }

  let checked = 0;
  let missing = '';
  for (const name of values(names).map(rawText)) {
    if (name === '') continue;
    checked++;
    if (usageInLog(runLog, name)) {
      say(c, `  ✓ usage: '${name}' invoked (run log)`);
    } else {
      say(c, `  ✗ usage: '${name}' not found in run log`, true);
      missing += `; ${name}`;
    }
  }

  if (checked === 0) return 0;
  if (missing === '') {
    recordScore(db, c.runId, c.flow, 'usage', 1, String(checked), 'all skills used');
    return 0;
  }
  recordScore(db, c.runId, c.flow, 'usage', 0, 'missing', missing);
  return 1;
};

// Reads scorer_dir/outcome-materialized.json: {"materialized": [{"agent": "swe", "skill":
// "feature-dev"}]}, the (agent, skill) pairs a targeted cheatcode install must have materialized
// on disk this row, each checked by materializedOnDisk.
export const scoreMaterialized: Scorer = (c) => {
  const cfgPath = join(c.scorerDir, 'outcome-materialized.json');
  const db = dbPath(c.project);
  if (!isFile(cfgPath)) return 0;

  let pairs: Json;
  try {
    pairs = orElse(field(readJson(cfgPath) ?? null, 'materialized'), []);
  } catch {
    pairs = [];
  }

  let checked = 0;
  let missing = '';
  for (const pair of values(pairs)) {
    let agent: string;
    let skill: string;
    try {
      agent = rawText(orElse(field(pair, 'agent'), ''));
      skill = rawText(orElse(field(pair, 'skill'), ''));
    } catch {
      continue;
    }
    if (agent === '' || skill === '') continue;
    checked++;
    if (materializedOnDisk(c.project, agent, skill)) {
      say(c, `  ✓ materialized: '${skill}' into '${agent}' (on disk)`);
    } else {
      say(c, `  ✗ materialized: '${skill}' not materialized into '${agent}'`, true);
      missing += `; ${skill}→${agent}`;
    }
  }

  if (checked === 0) return 0;
  if (missing === '') {
    recordScore(db, c.runId, c.flow, 'materialized', 1, String(checked), 'all agents materialized');
    return 0;
  }
  recordScore(db, c.runId, c.flow, 'materialized', 0, 'missing', missing);
  return 1;
};

// TEST MODE pins /onboard's sandbox answer to no (GH 1549): a sandbox block in the project's
// .claude/settings.local.json, or a stored sandbox_enforcement of yes, means the default leaked
// into a scratch project. Always on; records a row only on failure.
export const scoreNoSandbox: Scorer = (c) => {
  const db = dbPath(c.project);
  const settings = join(c.project, '.claude', 'settings.local.json');
  let found = '';

  if (isFile(settings)) {
    const parsed = readJson(settings);
    if (isObject(parsed) && Object.hasOwn(parsed, 'sandbox')) found = 'sandbox block in .claude/settings.local.json';
  }
  if (isFile(db) && queryText(db, "SELECT value_json FROM plugin_config WHERE key = 'sandbox_enforcement';") === '"yes"') {
    found = found ? `${found}; sandbox_enforcement = yes` : 'sandbox_enforcement = yes';
  }

  if (found === '') {
    say(c, '  ✓ no_sandbox: no sandbox block');
    return 0;
  }
  say(c, `  ✗ no_sandbox: ${found} (TEST MODE pins the sandbox answer to no)`, true);
  recordScore(db, c.runId, c.flow, 'no_sandbox', 0, 'present', found);
  return 1;
};

// The order l5_score_flow and l6c_score_step run them in:
//   1. outcome              primary; SQL assertions on final DB state
//   2. trajectory_required  required tools were called (any order)
//   3. trajectory_forbidden forbidden tools were not called
//   4. cost                 observational unless cost-budget says fail_above_max
//   5. files                filesystem assertions (opt-in via outcome-files.json)
//   6. coherence            table-shape invariants (opt-in via outcome-coherence.json)
//   7. git                  git-state invariants (opt-in via outcome-git.json)
//   8. usage                skill/plugin usage from the run log (opt-in via outcome-usage.json)
//   9. materialized         on-disk consuming-agent materialization (opt-in via outcome-materialized.json)
//  10. no_sandbox           always on
export const SCORERS: ReadonlyArray<readonly [string, Scorer]> = [
  ['outcome', scoreOutcome],
  ['trajectory_required', scoreTrajectoryRequired],
  ['trajectory_forbidden', scoreTrajectoryForbidden],
  ['cost', scoreCost],
  ['files', scoreFiles],
  ['coherence', scoreCoherence],
  ['git', scoreGit],
  ['usage', scoreUsage],
  ['materialized', scoreMaterialized],
  ['no_sandbox', scoreNoSandbox],
];

export function scoreAll(c: ScoreContext): number {
  let fails = 0;
  for (const [name, scorer] of SCORERS) {
    try {
      fails += scorer(c) === 0 ? 0 : 1;
    } catch (error) {
      say(c, `  ✗ ${name}: ${(error as Error).message}`, true);
      fails++;
    }
  }
  return fails;
}

function main(argv: string[]): number {
  const [command, project, flow, scorerDir, runId] = argv;
  if (command !== 'score-all' || !project || !flow || !scorerDir || runId === undefined) {
    process.stderr.write('usage: scorers.ts score-all <project> <flow> <scorer_dir> <run_id>\n');
    return 2;
  }
  return scoreAll({ project, flow, scorerDir, runId });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
