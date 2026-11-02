/**
 * PreToolUse gate (GH 2089), born in TypeScript: plans, decisions, specs and
 * drafts live in the trajectory DB, so a prose file (prose-files.ts) is denied
 * in the places an agent keeps scratch work, for every agent identity.
 *
 * A denylist (decision 862): prose anywhere else is a deliverable. The zones:
 *   - .claude/<plugin>/scratch/, always, even inside a git repo, where a
 *     single-repo project keeps it gitignored;
 *   - /tmp (which holds the session scratchpad) and the effective $TMPDIR,
 *     unless the target's nearest existing ancestor is in a git worktree.
 * Paths are compared canonically (macOS /private/tmp, /var/folders).
 *
 * Bash is judged, with its line continuations joined first (the analyzer ends a
 * statement at one, GH 1978), by the targets writePaths finds, less the ones an
 * `rm` statement removes, and by `gh issue|pr create|edit|comment` reading its
 * body from a file. UNRESOLVED lines are containment-guard's; a cap line is denied
 * by the gates that already deny it. On those, and on a command that does not
 * parse, this gate allows. A cap line ends the gate before cmdStatements runs,
 * since that has no work cap of its own (GH 2229).
 *
 * TMB_ALLOW_PROSE_SCRATCH=1 in the environment lifts the whole gate.
 */
import { ALLOW, type Gate, type GateResult } from './gate.js';
import { isProseFile } from '../prose-files.js';
import { harnessTmp, runTmpdir } from './containment-guard.js';
import { cmdStatements, ghMutation, ghMutationFrom, isCapLine, payloadCwd, type Statement, writePaths } from './cmd-analysis/index.js';
import { bashParser } from './cmd-analysis/parser.js';
import { pathCanonical } from './lib/agent-context.js';
import { stripTrailingNewlines } from './lib/db.js';
import { jqAlternatives, jqCompact } from './lib/jq.js';
import { pluginName, posixBasename, posixDirname, TMB_STATE_HOST_DIR } from './lib/project-env.js';
import { repoGitRoot } from './lib/repo.js';

export const GATE_NAME = 'no-prose-in-scratch';

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const BODY_FILE_WRITES = new Set(['issue create', 'issue edit', 'issue comment', 'pr create', 'pr edit', 'pr comment']);
/** The flags of those commands that take a value other than a body file: their next word is that value, whatever it looks like. */
const GH_VALUE_FLAGS = new Set([
  '--title', '-t', '--body', '-b', '--assignee', '-a', '--label', '-l', '--milestone', '-m', '--project', '-p', '--recover', '--template', '-T', '--repo', '-R',
  '--base', '-B', '--head', '-H', '--reviewer', '-r', '--add-assignee', '--remove-assignee', '--add-label', '--remove-label', '--add-project', '--remove-project',
  '--add-reviewer', '--remove-reviewer',
]);
const REDIRECT = /(^|[ \t])(\d*|&)(>>?|>\||<)[ \t]*\S+/g;
/** The characters cmdStatements shows as `_` when they are quoted or escaped. */
const FLATTENED = /[ \t\n<>|;&()`]/g;
/** Where a backslash-newline is text and no continuation. */
const LITERAL_NODES = ['raw_string', 'ansi_c_string', 'heredoc_body', 'comment'];

const BODY_FILE_REASON =
  'BLOCKED: this gh command reads its body from a file, and a body file is prose standing in for the trajectory DB. Pass the text with --body, or with --body-file - on stdin.';

function proseReason(target: string): string {
  return `BLOCKED: prose file in a scratch location: ${target}. Plans, decisions, specs and drafts live in the trajectory DB: issue_create or issue_update_description for an issue and its plan; discussion_append with kind decision, analysis or note; task_update_spec or task_create_batch for a task spec. Command output belongs in a .log file.`;
}

function capture(text: string): string {
  return stripTrailingNewlines(text.replace(/\0/g, ''));
}

function field(input: string, ...paths: string[][]): string {
  return capture(jqAlternatives(input, paths));
}

function deny(reason: string): GateResult {
  const decision = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  return { stdout: `${jqCompact(decision)}\n`, code: 0 };
}

function under(path: string, dir: string): boolean {
  return path.startsWith(`${dir.endsWith('/') ? dir.slice(0, -1) : dir}/`);
}

function inScratchFolder(canonical: string, env: NodeJS.ProcessEnv): boolean {
  return canonical.includes(`/${TMB_STATE_HOST_DIR}/${pluginName(env)}/scratch/`);
}

function tmpRoots(tmpdir: string): string[] {
  const roots = [capture(pathCanonical('/tmp'))];
  if (!/^\/./s.test(tmpdir)) return roots;
  const canonical = capture(pathCanonical(tmpdir));
  return canonical === '/' ? roots : [...roots, canonical];
}

/** Whether <path>, absolute, is a prose file in a zone. */
async function deniedProse(path: string, tmpdir: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!isProseFile(path)) return false;
  const canonical = capture(pathCanonical(path));
  if (inScratchFolder(canonical, env)) return true;
  if (!tmpRoots(tmpdir).some((root) => under(canonical, root))) return false;
  return (await repoGitRoot(posixDirname(canonical), env)) === '';
}

function effectiveTmpdir(input: string, toolName: string, env: NodeJS.ProcessEnv): string {
  const uid = process.getuid?.() ?? 0;
  return runTmpdir(input, toolName, env, uid, harnessTmp(uid));
}

function words(stmt: string): string[] {
  return (stmt.split('\n')[0] ?? '').split(/[ \t]+/).filter((w) => w !== '');
}

/** <command> with each line continuation removed, as the shell removes it. */
export async function joinContinuations(command: string): Promise<string> {
  if (!command.includes('\\\n')) return command;
  const tree = (await bashParser()).parse(command);
  if (tree === null) return command;
  const literals = tree.rootNode.descendantsOfType(LITERAL_NODES).flatMap((node) => (node === null ? [] : [[node.startIndex, node.endIndex] as const]));
  tree.delete();
  let next = 0;
  return command.replace(/\\[\s\S]/g, (pair: string, at: number) => {
    while (next < literals.length && literals[next][1] <= at) next += 1;
    const inLiteral = next < literals.length && literals[next][0] <= at;
    return pair === '\\\n' && !inLiteral ? '' : pair;
  });
}

/** A body-file value read from stdin: `-`, or nothing, with the redirect the word may run into dropped (`-<<EOF` prints as `<<EOF`). */
function isStdinValue(value: string): boolean {
  const word = value.replace(/<.*$/s, '');
  return word === '' || word === '-';
}

/** Whether a `gh` body write in <stmt> takes --body-file or -F with a value other than `-`. */
function readsBodyFile(stmt: string): boolean {
  if (!BODY_FILE_WRITES.has(ghMutation(stmt))) return false;
  const w = words(stmt);
  const gh = w.findIndex((word, k) => posixBasename(word) === 'gh' && BODY_FILE_WRITES.has(ghMutationFrom(w.slice(k))));
  if (gh < 0) return false;
  for (let k = gh + 1; k < w.length; k++) {
    const flag = w[k];
    if (flag === '--') return false;
    if (GH_VALUE_FLAGS.has(flag)) {
      k += 1;
      continue;
    }
    if (flag === '--body-file' || flag === '-F') {
      if (k + 1 < w.length && !isStdinValue(w[k + 1])) return true;
      k += 1;
      continue;
    }
    const attached = /^(?:--body-file=|-F=?)(.+)$/s.exec(flag);
    if (attached && !isStdinValue(attached[1])) return true;
  }
  return false;
}

function isRm(stmt: string): boolean {
  return posixBasename(words(stmt)[0] ?? '') === 'rm';
}

/** Where <removed>, read from a flattened statement, sits in <lines>, read from the whole command: its exact form first, so a path that holds a real `_` matches itself. */
function indexOfTarget(lines: readonly string[], removed: string): number {
  const exact = lines.indexOf(removed);
  return exact >= 0 ? exact : lines.findIndex((line) => line.replace(FLATTENED, '_') === removed);
}

/** <lines> less one occurrence per target an `rm` statement removes, so a write to a path removed earlier in the command stays. */
async function withoutRmTargets(lines: readonly string[], statements: readonly Statement[], cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const kept = [...lines];
  for (const { dir, stmt } of statements) {
    if (!isRm(stmt)) continue;
    const removed = await writePaths(stmt.replace(REDIRECT, ''), { cwd: dir.startsWith('/') ? dir : cwd, env });
    for (const target of removed) {
      const at = indexOfTarget(kept, target);
      if (at >= 0) kept.splice(at, 1);
    }
  }
  return kept;
}

async function bashRule(input: string, env: NodeJS.ProcessEnv): Promise<GateResult> {
  const command = await joinContinuations(field(input, ['tool_input', 'command']));
  if (command === '') return ALLOW;
  const tmpdir = effectiveTmpdir(input, 'Bash', env);
  const runEnv = tmpdir === (env.TMPDIR ?? '') ? env : { ...env, TMPDIR: tmpdir };
  const cwd = payloadCwd(input, env);
  const lines = capture((await writePaths(command, { cwd, env: runEnv })).join('\n')).split('\n');
  if (lines.some(isCapLine)) return ALLOW;
  const prose = lines.filter((line) => line !== '' && !line.startsWith('UNRESOLVED:') && isProseFile(line));
  if (prose.length === 0 && !/\bgh\b/.test(command)) return ALLOW;

  const listed = await cmdStatements(command, cwd, env);
  if (!listed.ok) return ALLOW;
  if (listed.statements.some(({ stmt }) => readsBodyFile(stmt))) return deny(BODY_FILE_REASON);
  for (const path of await withoutRmTargets(prose, listed.statements, cwd, runEnv)) {
    if (await deniedProse(path, tmpdir, env)) return deny(proseReason(path));
  }
  return ALLOW;
}

async function fileRule(input: string, toolName: string, env: NodeJS.ProcessEnv): Promise<GateResult> {
  const target = field(input, ['tool_input', 'file_path'], ['tool_input', 'notebook_path']);
  if (target === '') return ALLOW;
  const path = target.startsWith('/') ? target : `${payloadCwd(input, env)}/${target}`;
  return (await deniedProse(path, effectiveTmpdir(input, toolName, env), env)) ? deny(proseReason(target)) : ALLOW;
}

export const noProseInScratch: Gate = async (payload, env) => {
  if ((env.TMB_ALLOW_PROSE_SCRATCH ?? '0') === '1') return ALLOW;
  const toolName = field(payload, ['tool_name']);
  if (toolName === 'Bash') return await bashRule(payload, env);
  return FILE_TOOLS.has(toolName) ? await fileRule(payload, toolName, env) : ALLOW;
};
