/**
 * PreToolUse gate (GH 1692), the port of scripts/hooks/stay-on-base-guard.sh:
 * a `git checkout <branch>` / `git switch <branch>` in a main checkout is
 * denied while <branch> belongs to an open task, pointing at the task's
 * worktree instead. A statement already inside .claude/worktrees/, one whose
 * dir is unknown, and one that creates a branch (-b/-B/-c/-C/--create) or
 * restores files (`--`) pass.
 *
 * Decisions and deny text are the .sh's, with three exceptions: a command
 * tree-sitter-bash cannot parse is denied with git-guards' PARSE_REASON when
 * the DB resolves, the
 * payload is read with no jq on PATH (the .sh reads an empty tool_name and
 * allows), and the DB is read through node:sqlite with no sqlite3 CLI on PATH
 * (the .sh allows).
 */
import { statSync } from 'node:fs';
import { ALLOW, type Gate } from './gate.js';
import { PARSE_REASON } from './git-guards.js';
import { cmdStatements, denyAmbiguousGitTarget, gitSubcommand } from './cmd-analysis/index.js';
import { taskLocation } from './lib/agent-context.js';
import { branchSlug, dbPath, denyDbUnavailable, GATE_READ_ERROR, gateRead, haveSqlite, sqlQuote } from './lib/db.js';
import { jqCapture, jqInput } from './lib/jq-raw.js';
import { repoGitRoot } from './lib/repo.js';
import { denyResult, payloadCwdOf, readTabFields, statementRows } from './lib/statement-rows.js';

export const GATE_NAME = 'stay-on-base-guard';

const BRANCH_WORD = /^[a-zA-Z0-9_./:@^~-]+$/;
const CREATES_OR_RESTORES = [' -b ', ' -B ', ' -c ', ' -C ', ' --create ', ' -- '];

interface Switch {
  dir: string;
  target: string;
  stmt: string;
}

/** The last word of `${sub#* }`'s first line that is no option, "" when none. */
function switchTarget(sub: string): string {
  const rest = sub.slice(sub.indexOf(' ') + 1);
  let target = '';
  for (const w of (rest.split('\n')[0] ?? '').split(/[ \t]+/)) if (w !== '' && !w.startsWith('-')) target = w;
  return target;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export const stayOnBaseGuard: Gate = async (payload, env) => {
  const input = jqInput(payload);
  if (jqCapture(input, ['tool_name']) !== 'Bash') return ALLOW;
  const command = jqCapture(input, ['tool_input', 'command']);
  if (!command.includes('checkout') && !command.includes('switch')) return ALLOW;

  const listed = await cmdStatements(command, payloadCwdOf(input, env), env);
  if (!listed.ok) return haveSqlite(env) && isFile(dbPath(env) ?? '') ? denyResult(PARSE_REASON) : ALLOW;
  let lines = '';
  for (const { dir, stmt } of statementRows(listed.statements)) {
    const sub = gitSubcommand(stmt);
    if (!sub.startsWith('checkout ') && !sub.startsWith('switch ')) continue;
    if (CREATES_OR_RESTORES.some((flag) => ` ${sub} `.includes(flag))) continue;
    const target = switchTarget(sub);
    if (target === '' || !BRANCH_WORD.test(target)) continue;
    lines += `${dir}\t${target}\t${stmt}\n`;
  }
  if (lines === '') return ALLOW;

  if (!haveSqlite(env)) return ALLOW;
  const db = dbPath(env) ?? '';
  if (!isFile(db)) return ALLOW;

  const switches: Switch[] = lines.split('\n').map((line) => {
    const [dir, target, stmt] = readTabFields(line, 3);
    return { dir, target, stmt };
  });
  for (const { dir, target, stmt } of switches) {
    if (target === '') continue;
    if (dir === '-' || dir.includes('/.claude/worktrees/')) continue;
    const openTask = gateRead(
      db,
      `
    SELECT id FROM tasks
     WHERE branch_id = '${sqlQuote(target)}'
       AND status IN ('pending','running','needs_validation')
     LIMIT 1;
  `,
      env,
    );
    if (openTask === GATE_READ_ERROR) return { stdout: `${denyDbUnavailable(GATE_NAME, env)}\n`, code: 0 };
    if (openTask === '' || !openTask.split('\n').some((l) => /^[0-9]+$/.test(l))) continue;
    if (dir === '?') return { stdout: denyAmbiguousGitTarget(stmt), code: 0 };

    const loc = taskLocation(db, openTask, env);
    const wt = loc.code === 0 ? loc.worktree : `${await repoGitRoot(dir, env) || dir}/.claude/worktrees/${branchSlug(target)}`;
    return denyResult(
      `the main checkout stays on the base; SWE work lives in worktrees — use the worktree at ${wt}. Branch '${target}' belongs to open task #${openTask}. Switch to the worktree instead: cd ${wt}`,
    );
  }
  return ALLOW;
};
