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
 * `rm` statement removes and the ones a redirect of command output writes (GH 2405:
 * a statement authoring text, with a heredoc or here-string, `echo` or `printf` in it
 * or any command piped into it (GH 2470), or `cat` with no file operand at its
 * pipeline's head, keeps its redirects judged), and by `gh issue|pr create|edit|comment`
 * reading its body from a file. UNRESOLVED lines are containment-guard's; a cap line is denied
 * by the gates that already deny it. On those this gate allows. A command tree-sitter
 * cannot parse fails closed (GH 2469): each word naming a prose file in a zone is
 * denied, unless `bash -n` finds a syntax error, so the command never runs. A cap line
 * ends the gate before cmdStatements runs, since that has no work cap of its own (GH 2229).
 *
 * TMB_ALLOW_PROSE_SCRATCH=1 in the environment lifts the whole gate.
 */
import { spawnSync } from 'node:child_process';
import { ALLOW } from './gate.js';
import { isProseFile } from '../prose-files.js';
import { harnessTmp, runTmpdir } from './containment-guard.js';
import { cmdStatements, ghMutation, ghMutationFrom, isCapLine, payloadCwd, writePaths } from './cmd-analysis/index.js';
import { bashParser } from './cmd-analysis/parser.js';
import { pathCanonical } from './lib/agent-context.js';
import { stripTrailingNewlines } from './lib/db.js';
import { denyResult } from './lib/deny.js';
import { jqAlternatives } from './lib/jq.js';
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
const CAPTURE_OPERATORS = new Set(['>', '>>', '>|', '&>', '&>>']);
const INLINE_BODIES = ['heredoc_redirect', 'herestring_redirect'];
const AUTHORS = new Set(['echo', 'printf', 'cat']);
/** Commands that run another one named in their words. */
const WRAPPERS = new Set(['command', 'builtin', 'env', 'exec', 'nohup', 'sudo', 'time', 'nice', 'timeout', 'stdbuf', 'xargs', 'eval', 'bash', 'sh', 'zsh', 'dash', 'ksh']);
const BODY_FILE_REASON = 'BLOCKED: this gh command reads its body from a file, and a body file is prose standing in for the trajectory DB.';
const BODY_FILE_FIX = { allowed: 'the same gh command with the text passed by --body, or by --body-file - on stdin' };
function proseReason(target) {
    return `BLOCKED: prose file in a scratch location: ${target}. bro records prose in the trajectory DB (issue_create, issue_update_description, discussion_append, task_update_spec). swe or code-reviewer: put the text in your final report instead.`;
}
const PROSE_FIX = { allowed: 'bro: one of those trajectory DB calls; swe or code-reviewer: the final report; for command output, the same write to a .log file' };
function capture(text) {
    return stripTrailingNewlines(text.replace(/\0/g, ''));
}
function field(input, ...paths) {
    return capture(jqAlternatives(input, paths));
}
function denyProse(target) {
    return denyResult(proseReason(target), PROSE_FIX);
}
function under(path, dir) {
    return path.startsWith(`${dir.endsWith('/') ? dir.slice(0, -1) : dir}/`);
}
function inScratchFolder(canonical, env) {
    return canonical.includes(`/${TMB_STATE_HOST_DIR}/${pluginName(env)}/scratch/`);
}
function tmpRoots(tmpdir) {
    const roots = [capture(pathCanonical('/tmp'))];
    if (!/^\/./s.test(tmpdir))
        return roots;
    const canonical = capture(pathCanonical(tmpdir));
    return canonical === '/' ? roots : [...roots, canonical];
}
/** Whether <path>, absolute, is a prose file in a zone. */
async function deniedProse(path, tmpdir, env) {
    if (!isProseFile(path))
        return false;
    const canonical = capture(pathCanonical(path));
    if (inScratchFolder(canonical, env))
        return true;
    if (!tmpRoots(tmpdir).some((root) => under(canonical, root)))
        return false;
    return (await repoGitRoot(posixDirname(canonical), env)) === '';
}
function effectiveTmpdir(input, toolName, env) {
    const uid = process.getuid?.() ?? 0;
    return runTmpdir(input, toolName, env, uid, harnessTmp(uid));
}
function words(stmt) {
    return (stmt.split('\n')[0] ?? '').split(/[ \t]+/).filter((w) => w !== '');
}
/** <command> with each line continuation removed, as the shell removes it. */
export async function joinContinuations(command) {
    if (!command.includes('\\\n'))
        return command;
    const tree = (await bashParser()).parse(command);
    if (tree === null)
        return command;
    const literals = tree.rootNode.descendantsOfType(LITERAL_NODES).flatMap((node) => (node === null ? [] : [[node.startIndex, node.endIndex]]));
    tree.delete();
    let next = 0;
    return command.replace(/\\[\s\S]/g, (pair, at) => {
        while (next < literals.length && literals[next][1] <= at)
            next += 1;
        const inLiteral = next < literals.length && literals[next][0] <= at;
        return pair === '\\\n' && !inLiteral ? '' : pair;
    });
}
/** A body-file value read from stdin: `-`, or nothing, with the redirect the word may run into dropped (`-<<EOF` prints as `<<EOF`). */
function isStdinValue(value) {
    const word = value.replace(/<.*$/s, '');
    return word === '' || word === '-';
}
/** Whether a `gh` body write in <stmt> takes --body-file or -F with a value other than `-`. */
function readsBodyFile(stmt) {
    if (!BODY_FILE_WRITES.has(ghMutation(stmt)))
        return false;
    const w = words(stmt);
    const gh = w.findIndex((word, k) => posixBasename(word) === 'gh' && BODY_FILE_WRITES.has(ghMutationFrom(w.slice(k))));
    if (gh < 0)
        return false;
    for (let k = gh + 1; k < w.length; k++) {
        const flag = w[k];
        if (flag === '--')
            return false;
        if (GH_VALUE_FLAGS.has(flag)) {
            k += 1;
            continue;
        }
        if (flag === '--body-file' || flag === '-F') {
            if (k + 1 < w.length && !isStdinValue(w[k + 1]))
                return true;
            k += 1;
            continue;
        }
        const attached = /^(?:--body-file=|-F=?)(.+)$/s.exec(flag);
        if (attached && !isStdinValue(attached[1]))
            return true;
    }
    return false;
}
function isRm(stmt) {
    return posixBasename(words(stmt)[0] ?? '') === 'rm';
}
/** Where <removed>, read from a flattened statement, sits in <lines>, read from the whole command: its exact form first, so a path that holds a real `_` matches itself. */
function indexOfTarget(lines, removed) {
    const exact = lines.indexOf(removed);
    return exact >= 0 ? exact : lines.findIndex((line) => line.replace(FLATTENED, '_') === removed);
}
/** <lines> less one occurrence per target an `rm` statement removes, so a write to a path removed earlier in the command stays. */
async function withoutRmTargets(lines, statements, cwd, env) {
    const kept = [...lines];
    for (const { dir, stmt } of statements) {
        if (!isRm(stmt))
            continue;
        const removed = await writePaths(stmt.replace(REDIRECT, ''), { cwd: dir.startsWith('/') ? dir : cwd, env });
        for (const target of removed) {
            const at = indexOfTarget(kept, target);
            if (at >= 0)
                kept.splice(at, 1);
        }
    }
    return kept;
}
function present(nodes) {
    return nodes.filter((node) => node !== null);
}
function hasInlineBody(node) {
    return present(node.descendantsOfType(INLINE_BODIES)).length > 0;
}
/** Whether <command>, a `command` node, writes text of its own: a heredoc or here-string, `echo`, `printf`, `cat` with no file operand, or a wrapper or name that may run one. */
function authors(command) {
    if (hasInlineBody(command))
        return true;
    const name = command.childForFieldName('name');
    if (name === null || name.namedChildCount !== 1 || name.namedChildren[0]?.type !== 'word')
        return true;
    const program = posixBasename(name.text);
    const operands = present(command.childrenForFieldName('argument')).map((arg) => arg.text);
    if (WRAPPERS.has(program))
        return operands.some((word) => /\b(?:echo|printf|cat)\b/.test(word));
    if (program !== 'cat')
        return AUTHORS.has(program);
    return operands.every((word) => word.startsWith('-'));
}
/** Whether <node> is a `command` that writes no text of its own. */
function capturesOnly(node) {
    return node !== null && node !== undefined && node.type === 'command' && !authors(node);
}
/** <member> of a pipeline, or the command under a redirect of its own (`find . 2>/dev/null`, GH 2468) when that redirect holds no inline body. */
function memberCommand(member) {
    if (member?.type !== 'redirected_statement' || hasInlineBody(member))
        return member;
    return member.childForFieldName('body');
}
/** The commands <member> pipes, in order: tree-sitter hangs the `2>/dev/null` of `a | b 2>/dev/null | c` on `a | b`, a pipeline inside the pipeline (GH 2470). */
function pipedCommands(member) {
    const command = memberCommand(member);
    return command?.type === 'pipeline' ? present(command.namedChildren).flatMap(pipedCommands) : [command];
}
/** The commands the pipelines around <owner> pipe into it, or null when an inline body hangs on one of the statements between. */
function pipedInto(owner) {
    const before = [];
    for (let child = owner, up = owner.parent; up !== null; child = up, up = up.parent) {
        if (up.type === 'pipeline') {
            const members = present(up.namedChildren);
            before.unshift(...members.slice(0, members.findIndex((member) => member.id === child.id)).flatMap(pipedCommands));
        }
        else if (up.type !== 'redirected_statement' || up.childForFieldName('body')?.id !== child.id)
            break;
        else if (hasInlineBody(up))
            return null;
    }
    return before;
}
/** Whether <command> is a `cat` with no inline body, which past a pipeline's head relays its stdin. */
function relays(command) {
    const name = command.childForFieldName('name');
    return !hasInlineBody(command) && name?.namedChildCount === 1 && name.namedChildren[0]?.type === 'word' && posixBasename(name.text) === 'cat';
}
/**
 * Whether the statement <redirect> belongs to writes command output only. tree-sitter hangs a
 * redirect on the whole `a && b` or `a | b` before it, where the shell gives it to `b`: the
 * statement is the last command of that list, and every command piped into it counts too.
 */
function ownerCapturesOnly(redirect) {
    const owner = redirect.parent;
    if (owner === null)
        return false;
    let members = [owner];
    if (owner.type !== 'command') {
        if (owner.type !== 'redirected_statement' || hasInlineBody(owner))
            return false;
        let body = owner.childForFieldName('body');
        while (body?.type === 'list')
            body = body.namedChildren.at(-1) ?? null;
        if (body === null || body === undefined)
            return false;
        members = pipedCommands(body);
    }
    const before = pipedInto(owner);
    if (before === null)
        return false;
    return [...before, ...members].every((member, k) => capturesOnly(member) || (k > 0 && member?.type === 'command' && relays(member)));
}
/** The span of <redirect>, through its first destination, when it captures command output into a plain name; null otherwise. */
function captureSpan(redirect) {
    const operator = redirect.children.find((child) => child !== null && !child.isNamed);
    if (operator === undefined || operator === null || !CAPTURE_OPERATORS.has(operator.type))
        return null;
    const destination = redirect.childForFieldName('destination');
    if (destination === null || present(destination.descendantsOfType(['command_substitution', 'process_substitution'])).length > 0)
        return null;
    for (let up = redirect.parent; up !== null; up = up.parent)
        if (INLINE_BODIES.includes(up.type))
            return null;
    return ownerCapturesOnly(redirect) ? [redirect.startIndex, destination.endIndex] : null;
}
/** <command> with each redirect of command output blanked, so writePaths finds only the targets a statement authors or a command writes itself; unchanged when it does not parse cleanly (GH 2469). */
async function withoutOutputCapture(command) {
    const tree = (await bashParser()).parse(command);
    if (tree === null)
        return command;
    if (tree.rootNode.hasError) {
        tree.delete();
        return command;
    }
    const spans = present(tree.rootNode.descendantsOfType('file_redirect')).flatMap((redirect) => {
        const span = captureSpan(redirect);
        return span === null ? [] : [span];
    });
    tree.delete();
    let blanked = command;
    for (const [start, end] of spans)
        blanked = blanked.slice(0, start) + ' '.repeat(end - start) + blanked.slice(end);
    return blanked;
}
function proseTargets(lines) {
    return lines.filter((line) => line !== '' && !line.startsWith('UNRESOLVED:') && isProseFile(line));
}
function isUnparsed(line) {
    return line.startsWith('UNRESOLVED:$(parse)');
}
/** Each word of <command> naming a prose file, read as text where tree-sitter could not parse it: quotes and a `--flag=` prefix dropped, $TMPDIR and $HOME expanded, a relative one under <cwd>. */
function lexicalProse(command, cwd, tmpdir, env) {
    const home = env.HOME ?? '';
    return command.split(/[\s;&|()<>`]+/).flatMap((token) => {
        let word = token.replace(/['"]/g, '').replace(/^[^=/]*=/, '');
        if (tmpdir !== '')
            word = word.replace(/^\$(?:TMPDIR|\{TMPDIR\})(?=\/|$)/, tmpdir);
        if (home !== '')
            word = word.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
        if (word.includes('$') || !isProseFile(word))
            return [];
        return [word.startsWith('/') ? word : `${cwd}/${word}`];
    });
}
/** Whether bash reads <command> with no syntax error, so it runs; an unknown answer counts as yes. */
function bashReads(command, env) {
    const run = spawnSync('bash', ['-n'], { input: command, env, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 });
    return run.status !== 2;
}
/** The first prose file in a zone that <command>, which tree-sitter could not parse but bash runs, names; '' when none (GH 2469: a parse error fails closed). */
async function unparsedProse(command, cwd, tmpdir, env) {
    for (const path of lexicalProse(command, cwd, tmpdir, env)) {
        if (await deniedProse(path, tmpdir, env))
            return bashReads(command, env) ? path : '';
    }
    return '';
}
async function bashRule(input, env) {
    const command = await joinContinuations(field(input, ['tool_input', 'command']));
    if (command === '')
        return ALLOW;
    const tmpdir = effectiveTmpdir(input, 'Bash', env);
    const runEnv = tmpdir === (env.TMPDIR ?? '') ? env : { ...env, TMPDIR: tmpdir };
    const cwd = payloadCwd(input, env);
    const lines = capture((await writePaths(command, { cwd, env: runEnv })).join('\n')).split('\n');
    if (lines.some(isCapLine))
        return ALLOW;
    if (lines.some(isUnparsed)) {
        const unparsed = await unparsedProse(command, cwd, tmpdir, env);
        if (unparsed !== '')
            return denyProse(unparsed);
    }
    const prose = proseTargets(lines);
    if (prose.length === 0 && !/\bgh\b/.test(command))
        return ALLOW;
    const listed = await cmdStatements(command, cwd, env);
    if (!listed.ok)
        return ALLOW;
    if (listed.statements.some(({ stmt }) => readsBodyFile(stmt)))
        return denyResult(BODY_FILE_REASON, BODY_FILE_FIX);
    if (prose.length === 0)
        return ALLOW;
    const blanked = capture((await writePaths(await withoutOutputCapture(command), { cwd, env: runEnv })).join('\n')).split('\n');
    const authored = blanked.some((line) => isCapLine(line) || isUnparsed(line)) ? prose : proseTargets(blanked);
    for (const path of await withoutRmTargets(authored, listed.statements, cwd, runEnv)) {
        if (await deniedProse(path, tmpdir, env))
            return denyProse(path);
    }
    return ALLOW;
}
async function fileRule(input, toolName, env) {
    const target = field(input, ['tool_input', 'file_path'], ['tool_input', 'notebook_path']);
    if (target === '')
        return ALLOW;
    const path = target.startsWith('/') ? target : `${payloadCwd(input, env)}/${target}`;
    return (await deniedProse(path, effectiveTmpdir(input, toolName, env), env)) ? denyProse(target) : ALLOW;
}
export const noProseInScratch = async (payload, env) => {
    if ((env.TMB_ALLOW_PROSE_SCRATCH ?? '0') === '1')
        return ALLOW;
    const toolName = field(payload, ['tool_name']);
    if (toolName === 'Bash')
        return await bashRule(payload, env);
    return FILE_TOOLS.has(toolName) ? await fileRule(payload, toolName, env) : ALLOW;
};
//# sourceMappingURL=no-prose-in-scratch.js.map