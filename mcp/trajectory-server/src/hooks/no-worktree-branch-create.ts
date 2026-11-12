/**
 * PreToolUse gate (GH 1692): `git worktree add` may neither create a branch (-b/-B/--create-branch,
 * bypass TMB_ALLOW_WORKTREE_BRANCH_CREATE=1) nor detach (--detach, bypass
 * TMB_ALLOW_WORKTREE_DETACH=1) once a trajectory DB resolves, nor may a git
 * statement whose subcommand is not literal text (gitSubcommandOf, GH 2641);
 * a DB read error denies.
 *
 * A command tree-sitter-bash cannot parse is a violation denied with
 * git-guards' PARSE_REASON once the DB resolves. The payload is read with no
 * jq on PATH, and the DB through node:sqlite with no sqlite3 CLI on PATH.
 */
import { ALLOW, type Gate } from './gate.js';
import { PARSE_FIX, PARSE_REASON } from './git-guards.js';
import { ambiguousSubcommandReason, cmdStatements, gitBesideExpansion, gitSubcommandOf, prefilterPasses, type Statement } from './cmd-analysis/index.js';
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

const DETACH_FIX: DenyFix = { allowed: 'git worktree add <path> <branch>' };
const UNKNOWN_FIX: DenyFix = { allowed: 'git -C <path> worktree add <path> <branch>, the subcommand written literally' };

type Violation = readonly [string, DenyFix];

function violationOf(statements: readonly Statement[], env: NodeJS.ProcessEnv): Violation | null {
  for (const row of statementRows(statements)) {
    const sub = gitSubcommandOf(row);
    if (sub === undefined) return [ambiguousSubcommandReason(row.src ?? row.stmt, 'adds a worktree'), UNKNOWN_FIX];
    if (!sub.startsWith('worktree add ')) continue;
    const padded = ` ${sub} `;
    if (CREATES_BRANCH.some((flag) => padded.includes(flag)) && (env.TMB_ALLOW_WORKTREE_BRANCH_CREATE ?? '0') !== '1') return [BRANCH_CREATE_REASON, WORKTREE_ADD_FIX];
    if (padded.includes(' --detach ') && (env.TMB_ALLOW_WORKTREE_DETACH ?? '0') !== '1') return [DETACH_REASON, DETACH_FIX];
  }
  return null;
}

export const noWorktreeBranchCreate: Gate = async (payload, env) => {
  const input = jqInput(payload);
  if (jqCapture(input, ['tool_name']) !== 'Bash') return ALLOW;
  const command = jqCapture(input, ['tool_input', 'command']);
  if (!prefilterPasses(command, (text) => text.includes('worktree')) && !gitBesideExpansion(command)) return ALLOW;

  const listed = await cmdStatements(command, '/', env);
  const violation = listed.ok ? violationOf(listed.statements, env) : ([PARSE_REASON, PARSE_FIX] as const);
  if (violation === null) return ALLOW;

  dbPath(env, (line) => process.stderr.write(`${line}\n`));
  const state = dbState(env);
  if (state === 'unresolved') return ALLOW;
  if (state === 'error') return { stdout: `${denyDbUnavailable(GATE_NAME, env)}\n`, code: 0 };
  return denyResult(...violation);
};
