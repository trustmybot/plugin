/**
 * PreToolUse gate (GH 1692): `git worktree add` may neither create a branch (-b/-B/--create-branch,
 * bypass TMB_ALLOW_WORKTREE_BRANCH_CREATE=1) nor detach (--detach, bypass
 * TMB_ALLOW_WORKTREE_DETACH=1) once a trajectory DB resolves; a DB read error
 * denies.
 *
 * Decisions and deny text are the .sh's, with three exceptions: a command
 * tree-sitter-bash cannot parse is a violation denied with git-guards'
 * PARSE_REASON once the DB resolves, the
 * payload is read with no jq on PATH (the .sh reads an empty tool_name and
 * allows), and the DB is read through node:sqlite with no sqlite3 CLI on PATH
 * (the .sh allows).
 */
import { ALLOW, type Gate } from './gate.js';
import { PARSE_FIX, PARSE_REASON } from './git-guards.js';
import { cmdStatements, gitSubcommand, type Statement } from './cmd-analysis/index.js';
import { dbPath, dbState, denyDbUnavailable } from './lib/db.js';
import { type DenyFix, denyResult } from './lib/deny.js';
import { jqCapture, jqInput } from './lib/jq-raw.js';
import { statementRows } from './lib/statement-rows.js';

export const GATE_NAME = 'no-worktree-branch-create';

const CREATES_BRANCH = [' -b ', ' -B ', ' --create-branch '];

const BRANCH_CREATE_REASON =
  'BLOCKED: `git worktree add` cannot create a branch (-b/-B/--create-branch). Branch authority belongs to bro: bro creates the branch first, then SWE attaches the worktree to it (no -b/-B). Without this rule, SWE may invent a different branch name than the spec (`tasks.branch_id`), breaking the push-gate lookup. Bypass: TMB_ALLOW_WORKTREE_BRANCH_CREATE=1.';
const DETACH_REASON =
  "BLOCKED: `git worktree add --detach` strands SWE's commits on a detached HEAD instead of advancing the branch ref. Pushes then upload an empty branch and MRs open with no diff (#2869). A plain worktree add on the named branch lets commits advance it naturally. Bypass: TMB_ALLOW_WORKTREE_DETACH=1.";
const WORKTREE_ADD_FIX: DenyFix = {
  allowed:
    'bro: git branch <task.branch_id> HEAD, then git worktree add <path> <task.branch_id>; swe: git worktree add <path> <task.branch_id> on the branch bro created, or report the missing branch to bro',
};

const REASONS: Readonly<Record<Violation, readonly [string, DenyFix]>> = {
  'branch-create': [BRANCH_CREATE_REASON, WORKTREE_ADD_FIX],
  detach: [DETACH_REASON, { allowed: 'git worktree add <path> <branch>' }],
  parse: [PARSE_REASON, PARSE_FIX],
};

type Violation = 'branch-create' | 'detach' | 'parse';

function violationOf(statements: readonly Statement[], env: NodeJS.ProcessEnv): Violation | null {
  for (const { stmt } of statementRows(statements)) {
    const sub = gitSubcommand(stmt);
    if (!sub.startsWith('worktree add ')) continue;
    const padded = ` ${sub} `;
    if (CREATES_BRANCH.some((flag) => padded.includes(flag)) && (env.TMB_ALLOW_WORKTREE_BRANCH_CREATE ?? '0') !== '1') return 'branch-create';
    if (padded.includes(' --detach ') && (env.TMB_ALLOW_WORKTREE_DETACH ?? '0') !== '1') return 'detach';
  }
  return null;
}

export const noWorktreeBranchCreate: Gate = async (payload, env) => {
  const input = jqInput(payload);
  if (jqCapture(input, ['tool_name']) !== 'Bash') return ALLOW;
  const command = jqCapture(input, ['tool_input', 'command']);
  if (!command.includes('worktree')) return ALLOW;

  const listed = await cmdStatements(command, '/', env);
  const violation = listed.ok ? violationOf(listed.statements, env) : 'parse';
  if (violation === null) return ALLOW;

  dbPath(env, (line) => process.stderr.write(`${line}\n`));
  const state = dbState(env);
  if (state === 'unresolved') return ALLOW;
  if (state === 'error') return { stdout: `${denyDbUnavailable(GATE_NAME, env)}\n`, code: 0 };
  return denyResult(...REASONS[violation]);
};
