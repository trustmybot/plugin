/**
 * Verification carry-forward (GH 1950): which commands of a gate run on a
 * rework commit may be recorded as passed from an earlier passing run of the
 * same task instead of run again. swe-verification-gate.sh calls the CLI entry
 *
 *   node dist/hooks/lib/verification-carry.js <db> <task_id> <worktree> <head> <gate_cmds_json>
 *
 * which prints one CarryPlan JSON line. It is an allowlist: a command is
 * carried only when every condition below is proven, and anything else carries
 * nothing.
 *   (a) a source run R exists: the task's newest finished run with exit 0, not
 *       timed out, on a commit P other than HEAD;
 *   (b) P is an ancestor of HEAD and P..HEAD holds no merge commit;
 *   (c) the worktree is clean;
 *   (d) .config/tmb/verification-inputs.json is not among the paths P..HEAD changed,
 *       and its HEAD version is a valid version-1 map;
 *   (e) the command is not a `[probe …]` command and R holds a row with the
 *       identical command text and exit 0;
 *   (f) exactly one map entry's `match` equals the command, and none of its
 *       `inputs` globs (path.matchesGlob) matches a path P..HEAD changed.
 */
import { realpathSync } from 'node:fs';
import { basename, matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_READ_ERROR, gateRead, sqlInt, sqlQuote } from './db.js';
import { gitRun } from './git.js';

export const VERIFICATION_INPUTS_PATH = '.config/tmb/verification-inputs.json';
export const VERIFICATION_INPUTS_VERSION = 1;

export type CarryRefusal =
  | 'bad_input'
  | 'head_mismatch'
  | 'db_unreadable'
  | 'no_source_run'
  | 'not_ancestor'
  | 'merge_in_range'
  | 'dirty_worktree'
  | 'diff_failed'
  | 'map_changed'
  | 'map_missing'
  | 'map_invalid'
  | 'map_unknown_version'
  | 'error';

export type CommandRefusal = 'probe' | 'not_passed_in_source' | 'undeclared' | 'ambiguous_declaration' | 'inputs_changed';

export interface CommandDecision {
  ordinal: number;
  command: string;
  carried: boolean;
  reason: CommandRefusal | null;
}

export interface CarryPlan {
  source_run: number | null;
  source_sha: string | null;
  carry: number[];
  refused: CarryRefusal | null;
  commands: CommandDecision[];
}

export interface CarryRequest {
  db: string;
  taskId: string;
  worktree: string;
  head: string;
  commandsJson: string;
}

interface InputsEntry {
  match: string;
  inputs: string[];
}

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const PROBE_PREFIX = '[probe ';

function refuse(reason: CarryRefusal, source: { id: number; sha: string } | null = null): CarryPlan {
  return { source_run: source?.id ?? null, source_sha: source?.sha ?? null, carry: [], refused: reason, commands: [] };
}

function parseCommands(json: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) && parsed.every((c) => typeof c === 'string' && c !== '') ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

function parseInputsMap(text: string): InputsEntry[] | 'map_invalid' | 'map_unknown_version' {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'map_invalid';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'map_invalid';
  const map = parsed as { version?: unknown; commands?: unknown };
  if (map.version !== VERIFICATION_INPUTS_VERSION) return 'map_unknown_version';
  if (!Array.isArray(map.commands)) return 'map_invalid';
  const entries: InputsEntry[] = [];
  for (const entry of map.commands as unknown[]) {
    if (entry === null || typeof entry !== 'object') return 'map_invalid';
    const { match, inputs } = entry as { match?: unknown; inputs?: unknown };
    if (typeof match !== 'string' || match === '') return 'map_invalid';
    if (!Array.isArray(inputs) || inputs.length === 0 || !inputs.every((g) => typeof g === 'string' && g !== '')) return 'map_invalid';
    entries.push({ match, inputs: inputs as string[] });
  }
  return entries;
}

function sourceRun(db: string, taskId: string, head: string, env: NodeJS.ProcessEnv): { id: number; sha: string } | null | 'error' {
  const out = gateRead(
    db,
    `SELECT json_object('id', id, 'sha', lower(commit_sha)) FROM verification_runs
      WHERE task_id = ${taskId} AND finished_at IS NOT NULL AND exit_code = 0 AND timed_out = 0
        AND lower(commit_sha) <> '${sqlQuote(head)}'
      ORDER BY finished_at DESC, id DESC LIMIT 1;`,
    env,
  );
  if (out === GATE_READ_ERROR) return 'error';
  if (out === '') return null;
  const row = JSON.parse(out) as { id: unknown; sha: unknown };
  if (typeof row.id !== 'number' || typeof row.sha !== 'string' || !SHA_RE.test(row.sha)) return null;
  return { id: row.id, sha: row.sha };
}

function passedInSource(db: string, runId: number, env: NodeJS.ProcessEnv): Set<string> | 'error' {
  const out = gateRead(
    db,
    `SELECT COALESCE(json_group_array(command), '[]') FROM verification_run_commands WHERE run_id = ${runId} AND exit_code = 0;`,
    env,
  );
  if (out === GATE_READ_ERROR) return 'error';
  const commands = parseCommands(out === '' ? '[]' : out);
  return commands === null ? 'error' : new Set(commands);
}

async function changedPaths(worktree: string, from: string, to: string, env: NodeJS.ProcessEnv): Promise<string[] | null> {
  const r = await gitRun(worktree, ['diff', '--name-only', '--no-renames', '-z', from, to, '--'], env);
  if (r.code !== 0) return null;
  return r.stdout.split('\0').filter((p) => p !== '');
}

/** The carry plan for one gate run: which ordinals (1-based, GATE_CMDS_JSON order) to record as carried from which run. */
export async function planCarry(req: CarryRequest, env: NodeJS.ProcessEnv = process.env): Promise<CarryPlan> {
  const taskId = sqlInt(req.taskId);
  const head = req.head.toLowerCase();
  const commands = parseCommands(req.commandsJson);
  if (req.db === '' || taskId === '' || req.worktree === '' || !SHA_RE.test(head) || commands === null) return refuse('bad_input');

  const actualHead = await gitRun(req.worktree, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], env);
  if (actualHead.code !== 0 || actualHead.stdout.trim().toLowerCase() !== head) return refuse('head_mismatch');

  const source = sourceRun(req.db, taskId, head, env);
  if (source === 'error') return refuse('db_unreadable');
  if (source === null) return refuse('no_source_run');

  if ((await gitRun(req.worktree, ['merge-base', '--is-ancestor', source.sha, head], env)).code !== 0) return refuse('not_ancestor', source);
  const merges = await gitRun(req.worktree, ['rev-list', '--merges', `${source.sha}..${head}`], env);
  if (merges.code !== 0 || merges.stdout.trim() !== '') return refuse('merge_in_range', source);

  const status = await gitRun(req.worktree, ['status', '--porcelain'], env);
  if (status.code !== 0 || status.stdout.trim() !== '') return refuse('dirty_worktree', source);

  const changed = await changedPaths(req.worktree, source.sha, head, env);
  if (changed === null) return refuse('diff_failed', source);
  if (changed.includes(VERIFICATION_INPUTS_PATH)) return refuse('map_changed', source);

  const mapText = await gitRun(req.worktree, ['show', `${head}:${VERIFICATION_INPUTS_PATH}`], env);
  if (mapText.code !== 0) return refuse('map_missing', source);
  const entries = parseInputsMap(mapText.stdout);
  if (typeof entries === 'string') return refuse(entries, source);

  const passed = passedInSource(req.db, source.id, env);
  if (passed === 'error') return refuse('db_unreadable', source);

  const decisions = commands.map((command, i): CommandDecision => {
    const decide = (reason: CommandRefusal | null): CommandDecision => ({ ordinal: i + 1, command, carried: reason === null, reason });
    if (command.startsWith(PROBE_PREFIX)) return decide('probe');
    if (!passed.has(command)) return decide('not_passed_in_source');
    const declared = entries.filter((e) => e.match === command);
    if (declared.length === 0) return decide('undeclared');
    if (declared.length > 1) return decide('ambiguous_declaration');
    const touched = declared[0].inputs.some((glob) => changed.some((path) => matchesGlob(path, glob)));
    return decide(touched ? 'inputs_changed' : null);
  });

  return {
    source_run: source.id,
    source_sha: source.sha,
    carry: decisions.filter((d) => d.carried).map((d) => d.ordinal),
    refused: null,
    commands: decisions,
  };
}

/** planCarry, with any thrown error read as a refusal: the gate then runs every command. */
export async function planCarrySafe(req: CarryRequest, env: NodeJS.ProcessEnv = process.env): Promise<CarryPlan> {
  try {
    return await planCarry(req, env);
  } catch {
    return refuse('error');
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  const self = fileURLToPath(import.meta.url);
  if (entry === undefined || basename(self) !== 'verification-carry.js') return false;
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const [db = '', taskId = '', worktree = '', head = '', commandsJson = ''] = process.argv.slice(2);
  process.stdout.write(`${JSON.stringify(await planCarrySafe({ db, taskId, worktree, head, commandsJson }))}\n`);
}
