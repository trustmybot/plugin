/**
 * Shared fixtures for the swe-boundary l3 ports (GH 1692), the node:test form
 * of the bash swe-boundary l3 test they replace: a sandbox project at
 * <sandbox>/repo with worktrees under .claude/worktrees, a trajectory DB at
 * <sandbox>/trajectory.db (so the state dir is the sandbox), and the gate run
 * as `node dist/hooks.js swe-boundary` with its shell in a fixture dir.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeSandbox, runGate, type Sandbox } from './hook-sandbox.js';

export { DENY, has, hasNot } from './git-push-guard-l3.js';

export const GATE = 'swe-boundary';
export const SURFACE = 'skills/tmb_audit/SKILL.md';
export const IN_FENCE = 'src/index.ts';

export type Payload = Record<string, unknown>;

export interface Fixture {
  sb: Sandbox;
  db: string;
  /** CLAUDE_PROJECT_DIR of every case but the L1 walk-up ones. */
  project: string;
  wtRoot: string;
  /** Task 10, prompt_bearing 0, files []. */
  worktree: string;
  /** Task 11, prompt_bearing 1. */
  wtPrompt: string;
  /** Task 12, failed, prompt_bearing 1. */
  wtFailedPb: string;
  /** Task 13, failed, prompt_bearing 0. */
  wtFailedNonPb: string;
  nonWt: string;
  /** Runs one statement on the fixture DB. */
  sql(statement: string, ...params: (string | number | null)[]): void;
  remove(): void;
}

/** The bash suite's base fixture: issue 1 and tasks 10-13 with their worktrees. */
export function makeFixture(name: string): Fixture {
  const sb = makeSandbox(name);
  const db = join(sb.dir, 'trajectory.db');
  const project = join(sb.dir, 'repo');
  const wtRoot = join(project, '.claude/worktrees');
  const f: Fixture = {
    sb,
    db,
    project,
    wtRoot,
    worktree: join(wtRoot, 'my-feature'),
    wtPrompt: join(wtRoot, 'prompt-task'),
    wtFailedPb: join(wtRoot, 'failed-pb'),
    wtFailedNonPb: join(wtRoot, 'failed-nonpb'),
    nonWt: join(sb.dir, 'non-worktree'),
    sql(statement, ...params) {
      const d = new DatabaseSync(db);
      try {
        d.prepare(statement).run(...params);
      } finally {
        d.close();
      }
    },
    remove: () => sb.remove(),
  };
  for (const d of [f.worktree, f.wtPrompt, f.wtFailedPb, f.wtFailedNonPb, f.nonWt]) mkdirSync(d, { recursive: true });
  const d = new DatabaseSync(db);
  try {
    d.exec(`
      CREATE TABLE issues (
        id INTEGER PRIMARY KEY,
        objective TEXT NOT NULL DEFAULT 'test',
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        issue_id INTEGER NOT NULL REFERENCES issues(id),
        branch_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        spec_body TEXT NOT NULL DEFAULT '',
        prompt_bearing INTEGER NOT NULL DEFAULT 0,
        files TEXT NOT NULL DEFAULT '[]'
      );
      INSERT INTO issues VALUES (1, 'test', '', 'open', datetime('now'), datetime('now'));
      INSERT INTO tasks VALUES (10, 1, 'feat/my-feature', 'pending', '', 0, '[]');
      INSERT INTO tasks VALUES (11, 1, 'feat/prompt-task', 'pending', '', 1, '[]');
      INSERT INTO tasks VALUES (12, 1, 'fix/failed-pb', 'failed', '', 1, '[]');
      INSERT INTO tasks VALUES (13, 1, 'fix/failed-nonpb', 'failed', '', 0, '[]');
      ALTER TABLE tasks ADD COLUMN repo TEXT;
      CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT);
    `);
    d.prepare("INSERT INTO repos VALUES ('repo', ?)").run(project);
  } finally {
    d.close();
  }
  return f;
}

/** Tasks 20 (files src/, notes/, myskills/) and 21 (prompt-bearing) with their worktrees shape-plain and shape-prompt. */
export function addShapeTasks(f: Fixture): { wtPlain: string; wtPb: string } {
  const add = 'INSERT INTO tasks (id, issue_id, branch_id, status, spec_body, prompt_bearing, files) VALUES (?, 1, ?, ?, ?, ?, ?)';
  f.sql(add, 20, 'feat/shape-plain', 'running', '', 0, '["src/","notes/","myskills/"]');
  f.sql(add, 21, 'feat/shape-prompt', 'running', '', 1, '["agents/","skills/","commands/","templates/","CLAUDE.md","src/"]');
  const wtPlain = join(f.wtRoot, 'shape-plain');
  const wtPb = join(f.wtRoot, 'shape-prompt');
  mkdirSync(wtPlain, { recursive: true });
  mkdirSync(wtPb, { recursive: true });
  return { wtPlain, wtPb };
}

/** The spawn transcript of a swe given task_id=<task>. */
export function makeTranscript(f: Fixture, task: number | string): string {
  const tf = join(f.sb.dir, `transcript_${task}.jsonl`);
  writeFileSync(tf, `${JSON.stringify({ message: { content: [{ type: 'text', text: `task_id=${task} worktree: /some/path` }] } })}\n`);
  return tf;
}

export const bashInput = (agent: string, command: string): Payload => ({ tool_name: 'Bash', agent_type: agent, tool_input: { command } });
export const editInput = (agent: string, path: string): Payload => ({ tool_name: 'Edit', agent_type: agent, tool_input: { file_path: path } });
export const writeInput = (agent: string, path: string): Payload => ({ tool_name: 'Write', agent_type: agent, tool_input: { file_path: path } });

export function editWithTranscript(f: Fixture, agent: string, path: string, task: number): Payload {
  return { tool_name: 'Edit', agent_type: agent, agent_transcript_path: makeTranscript(f, task), tool_input: { file_path: path } };
}

export function bashWithTranscript(f: Fixture, agent: string, command: string, task: number): Payload {
  return { tool_name: 'Bash', agent_type: agent, agent_transcript_path: makeTranscript(f, task), tool_input: { command } };
}

/** The task whose branch slug is the first dir of <cwd> under the worktree root, or undefined. */
function taskOfCwd(f: Fixture, cwd: string): number | undefined {
  if (!`${cwd}/`.startsWith(`${f.wtRoot}/`)) return undefined;
  const slug = cwd.slice(f.wtRoot.length + 1).split('/')[0];
  const d = new DatabaseSync(f.db);
  try {
    const row = d.prepare("SELECT id FROM tasks WHERE substr(branch_id, instr(branch_id, '/') + 1) = ? LIMIT 1").get(slug) as { id: number } | undefined;
    return row?.id;
  } finally {
    d.close();
  }
}

/**
 * Claude Code spawns every swe with task_id=<N> in its prompt, so a swe
 * payload naming no transcript (and not marked _no_identity) gets the spawn
 * transcript of the task whose worktree <cwd> lies in.
 */
export function spawned(f: Fixture, cwd: string, input: Payload): Payload {
  if (input.agent_type !== 'swe' || 'agent_transcript_path' in input || 'agent_id' in input || '_no_identity' in input) return input;
  const task = taskOfCwd(f, cwd);
  return task === undefined ? input : { ...input, agent_transcript_path: makeTranscript(f, task) };
}

/** The env a shell in <cwd> hands the gate: the sandbox's, the fixture project and DB, PWD set. */
export function fixtureEnv(f: Fixture, cwd: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...f.sb.env, CLAUDE_PROJECT_DIR: f.project, TRAJECTORY_DB_PATH: f.db, PWD: cwd, ...extra };
}

/** <gate>'s stdout and stderr (a `2>&1`) for <input>, its shell in <cwd>, after `spawned`. */
export function runIn(f: Fixture, cwd: string, input: Payload, extra: NodeJS.ProcessEnv = {}, gate = GATE): string {
  const r = runGate(gate, { cwd, input: `${JSON.stringify(spawned(f, cwd, input))}\n`, env: fixtureEnv(f, cwd, extra) });
  return r.stdout + r.stderr;
}

/** A swe in the my-feature worktree (task 10). */
export const runSwe = (f: Fixture, input: Payload, extra: NodeJS.ProcessEnv = {}) => runIn(f, f.worktree, input, extra);

/** bro, its shell outside every worktree. */
export const runBro = (f: Fixture, input: Payload) => runIn(f, f.sb.dir, input);

/** A swe Bash <command> from <cwd>. */
export const swe = (f: Fixture, cwd: string, command: string) => runIn(f, cwd, bashInput('swe', command));

/** swe-boundary then containment-guard on one swe Bash PreToolUse, as Claude Code runs both. */
export function runEvent(f: Fixture, cwd: string, command: string): string {
  const input = bashInput('swe', command);
  return runIn(f, cwd, input) + runIn(f, cwd, input, {}, 'containment-guard');
}

/** `<interp> <<'EOF'`, <program>, `EOF`, each on its own line. */
export const heredocProg = (interp: string, prog: string) => `${interp} <<'EOF'\n${prog}\nEOF`;
