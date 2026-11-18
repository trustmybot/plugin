/**
 * PreToolUse(Bash) gate (GH 3281 slice 2), born in TypeScript: an agent may
 * not skip, disable or replace TMB's pre-push hook, nor strip the agent mark
 * the hook script keys on. Denied forms:
 *   (a) `git push --no-verify` (or a unique prefix of it);
 *   (b) a `-c` / `--config-env` git option whose key is under `hook.`;
 *   (c) GIT_CONFIG_COUNT, GIT_CONFIG_KEY_*, GIT_CONFIG_VALUE_* or
 *       GIT_CONFIG_PARAMETERS set by a prefix assignment, `env` or a declaration;
 *   (d) `git config` writing a `hook.*` key or `extensions.worktreeConfig`;
 *   (e) a write, remove, move or chmod of `<git-common-dir>/tmb/` or the git
 *       config file, by a shell command rather than `git config`;
 *   (f) TMB_AGENT_SHELL stripped: `unset`, `env -u` / `env -i`, an assignment
 *       of any value but 1, `export -n`, `+x`, or a local shadowing it.
 * Assignments and environment changes are read from the tree-sitter-bash
 * parse, `bash -c` / `sh -c` / `eval` bodies included to depth 3; git
 * statements from cmdStatements; writes from writePaths. A command that does
 * not parse, or whose code the analysis cannot read, is denied only when its
 * text names one of the forms. A git statement whose subcommand, `-c` key,
 * push option or config key comes from an expansion or the words a $( ) cut
 * off is denied as it stands (fail closed), save a `git config` that a literal
 * read form makes a read and whose expansions are all double-quoted. Outside an agent session nothing is gated, and
 * every deny first asks standsDownFor, which stands down in an exempt repo,
 * for the repo its form lands in.
 */
import type { Node } from 'web-tree-sitter';
import { ALLOW, type Gate } from './gate.js';
import { cmdStatements, gitBesideExpansion, gitSubcommandOf, prefilterPasses, stmtRepoRoot, unquotedCommand, unquotedExpansions, writePaths, type Statement } from './cmd-analysis/index.js';
import { bashParser } from './cmd-analysis/parser.js';
import { ASSIGNMENT, splitWords, unwrap } from './cmd-analysis/unwrap.js';
import { dbPath } from './lib/db.js';
import { denyResult } from './lib/deny.js';
import { jqCapture, jqInput } from './lib/jq-raw.js';
import { posixBasename } from './lib/project-env.js';
import { gitCommonDir } from './lib/prepush-hook.js';
import { isExempt } from './lib/repo.js';
import { payloadCwdOf } from './lib/statement-rows.js';
import { isAgentSession } from './pre-push/judge.js';

export const GATE_NAME = 'prepush-hook-guard';

const MARK = 'TMB_AGENT_SHELL';
const GIT_CONFIG_ENV = /^GIT_CONFIG_(COUNT$|PARAMETERS$|KEY_|VALUE_)/;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const MAX_DEPTH = 3;
/** The words a command must hold, as written or unquoted, before it is parsed. */
const KEYWORDS = /no-veri|GIT_CONFIG_|TMB_AGENT_SHELL|\benv\b|\bunset\b|\bexport\b|\bdeclare\b|\btypeset\b|\blocal\b|config|\/tmb\b|\btmb\/|chmod/;
const KEYWORDS_ANY_CASE = /hook\.|worktreeconfig/i;
/** What an unreadable command must name to be denied: a form, never a bare `env` or `config`. */
const NAMES_A_FORM = /--no-veri|GIT_CONFIG_|TMB_AGENT_SHELL|\.git\/(tmb|config)|\/tmb\/pre-push/;
const NAMES_A_FORM_ANY_CASE = /hook\.|worktreeconfig/i;
/** A protected file named in text the analysis could not resolve, such as `"$(git rev-parse --git-common-dir)/tmb/pre-push"`. */
const PROTECTED_TEXT = /(\.git|git-(common-)?dir)\S*\/(tmb(\/|$)|config(\.worktree)?$)/i;
const PROTECTED_PATH = /\/\.git\/(tmb(\/|$)|config(\.worktree)?$|worktrees\/[^/]+\/config\.worktree$)/;
const OBSERVE_ONLY = "TMB's pre-push hook only observes in this release: it never blocks a push, so there is nothing to skip.";
const PARSE_REASON = 'BLOCKED: the pre-push hook guard could not read this command, and it names a way to skip the hook or strip the agent mark.';

const denyForm = (form: string) =>
  denyResult(`BLOCKED: ${form} would skip, disable or replace TMB's pre-push hook. ${OBSERVE_ONLY}`, { allowed: 'the same command without that form' });
const denyUnreadable = (why: string) => denyResult(`${PARSE_REASON} (${why}) ${OBSERVE_ONLY}`, { allowed: 'the same command split into simpler commands with plain quoting' });
const denyUnresolved = (why: string) =>
  denyResult(`BLOCKED: the pre-push hook guard cannot tell what this git command runs: ${why}, so it could skip, disable or replace TMB's pre-push hook. ${OBSERVE_ONLY}`, {
    allowed: 'the same command with that git argument written literally',
  });

const namesForm = (text: string): boolean => NAMES_A_FORM.test(unquotedCommand(text)) || NAMES_A_FORM_ANY_CASE.test(unquotedCommand(text));

/** A word's value when it holds no expansion: quotes and backslashes dropped; null otherwise. */
function literal(node: Node): string | null {
  switch (node.type) {
    case 'word':
    case 'variable_name':
    case 'number':
      return node.text.replace(/\\(.)/g, '$1');
    case 'raw_string':
      return node.text.slice(1, -1);
    case 'string': {
      const parts = node.namedChildren;
      return parts.every((p) => p?.type === 'string_content') ? node.text.slice(1, -1) : null;
    }
    case 'command_name': {
      const word = node.namedChild(0);
      return node.namedChildCount === 1 && word !== null ? literal(word) : null;
    }
    case 'concatenation': {
      const parts = node.namedChildren.map((p) => (p === null ? null : literal(p)));
      return parts.every((p) => p !== null) ? parts.join('') : null;
    }
    default:
      return null;
  }
}

/** The form an assignment `<name>=<value>` makes, or '' for none; value null when it is not literal. */
function assignmentForm(name: string, op: string, value: string | null): string {
  if (GIT_CONFIG_ENV.test(name)) return `setting ${name}`;
  if (name === MARK && (op !== '=' || value !== '1')) return `setting ${MARK} to anything but 1`;
  return '';
}

function assignmentWordForm(word: string): string {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?=)(.*)$/s.exec(word);
  return m === null ? '' : assignmentForm(m[1], m[2] ? '[]' : m[3], m[4]);
}

/** The form `env`'s options and assignments in <w> (from index 1) make. */
function envForm(w: readonly (string | null)[]): string {
  for (let k = 1; k < w.length; k++) {
    const word = w[k];
    if (word === null) return '';
    if (word === '-' || word === '-i' || word === '--ignore-environment') return `\`env ${word}\`, which strips ${MARK}`;
    if (word === `--unset=${MARK}` || ((word === '-u' || word === '--unset') && w[k + 1] === MARK)) return `\`env ${word.startsWith('--unset=') ? word : `${word} ${MARK}`}\``;
    if (/^-[^-]/.test(word)) {
      const u = word.indexOf('u');
      const flags = u < 0 ? word.slice(1) : word.slice(1, u);
      if (flags.includes('i')) return `\`env ${word}\`, which strips ${MARK}`;
      if (u >= 0 && (word.slice(u + 1) || w[k + 1]) === MARK) return `\`env -u ${MARK}\``;
      if (u >= 0 && word.slice(u + 1) === '') k++;
      else if (/[CS]$/.test(word)) k++;
      continue;
    }
    if (word === '--unset' || word === '--chdir' || word === '--split-string') {
      k++;
      continue;
    }
    if (word.startsWith('--')) continue;
    if (ASSIGNMENT.test(word)) {
      const form = assignmentWordForm(word);
      if (form !== '') return form;
      continue;
    }
    return '';
  }
  return '';
}

/** A form named literally, text the analysis cannot read that names one, or a git word whose value is unknown where a form could sit. */
type Finding = { form: string } | { unreadable: string } | { unresolved: string } | null;

/** The form one command's words make: its leading assignments and wrappers, `env`, `unset`, and a shell or `eval` body. */
async function argvFinding(w: readonly (string | null)[], depth: number): Promise<Finding> {
  const words = w.map((x) => x ?? '$?');
  const head = unwrap(words, 0).k;
  for (let k = 0; k < head; k++) {
    const word = w[k];
    if (word === null) continue;
    const form = ASSIGNMENT.test(word) ? assignmentWordForm(word) : posixBasename(word) === 'env' ? envForm(w.slice(k, head)) : '';
    if (form !== '') return { form };
  }
  const argv0 = w[head];
  if (argv0 === null || argv0 === undefined) return null;
  const name = posixBasename(argv0);
  if (name === 'env') {
    const form = envForm(w.slice(head));
    return form === '' ? null : { form };
  }
  if (name === 'unset') {
    const fn = w.slice(head + 1).some((x) => x === '-f');
    return !fn && w.slice(head + 1).includes(MARK) ? { form: `\`unset ${MARK}\`` } : null;
  }
  if (SHELLS.has(name)) {
    const c = w.findIndex((x, k) => k > head && x !== null && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x));
    if (c < 0) return null;
    const body = w[c + 1];
    return body === null || body === undefined ? null : bodyFinding(body, depth);
  }
  if (name === 'eval') {
    const rest = w.slice(head + 1);
    return rest.some((x) => x === null) ? null : bodyFinding(rest.join(' '), depth);
  }
  return null;
}

async function bodyFinding(body: string, depth: number): Promise<Finding> {
  if (depth >= MAX_DEPTH) return namesForm(body) ? { unreadable: 'code nested past depth 3' } : null;
  return treeFinding(body, depth + 1);
}

function declarationFinding(node: Node): Finding {
  const keyword = node.child(0)?.text ?? '';
  const options = node.namedChildren.filter((c): c is Node => c !== null && c.type === 'word' && /^[-+]/.test(c.text)).map((c) => c.text);
  for (const child of node.namedChildren) {
    if (child === null) continue;
    if (child.type === 'variable_assignment') continue;
    const nameText = literal(child);
    if (nameText === null || /^[-+]/.test(nameText)) continue;
    if (GIT_CONFIG_ENV.test(nameText)) return { form: `\`${keyword} ${nameText}\`` };
    if (nameText !== MARK) continue;
    const unexports = options.some((o) => (keyword === 'export' && /^-[a-z]*n/.test(o)) || /^\+[a-z]*x/.test(o));
    if (unexports || keyword === 'local' || keyword === 'declare' || keyword === 'typeset') return { form: `\`${keyword} ${[...options, MARK].join(' ')}\`, which strips ${MARK}` };
  }
  return null;
}

function assignmentNodeForm(node: Node): string {
  const nameNode = node.childForFieldName('name');
  const valueNode = node.childForFieldName('value');
  const name = nameNode?.type === 'subscript' ? (nameNode.childForFieldName('name')?.text ?? '') : (nameNode?.text ?? '');
  const op = node.text.slice(nameNode?.text.length ?? 0).startsWith('+=') ? '+=' : nameNode?.type === 'subscript' ? '[]' : '=';
  return assignmentForm(name, op, valueNode === null ? '' : literal(valueNode));
}

/** The first form the parse of <command> shows, its shell and `eval` bodies read to depth 3. */
async function treeFinding(command: string, depth: number): Promise<Finding> {
  const tree = (await bashParser()).parse(command);
  if (tree === null) return namesForm(command) ? { unreadable: 'tree-sitter-bash returned no parse' } : null;
  try {
    if (tree.rootNode.hasError) return namesForm(command) ? { unreadable: 'tree-sitter-bash could not parse it' } : null;
    for (const node of tree.rootNode.descendantsOfType(['variable_assignment', 'declaration_command', 'unset_command', 'command'])) {
      if (node === null) continue;
      if (node.type === 'variable_assignment') {
        const form = assignmentNodeForm(node);
        if (form !== '') return { form };
      } else if (node.type === 'declaration_command') {
        const found = declarationFinding(node);
        if (found !== null) return found;
      } else if (node.type === 'unset_command') {
        const args = node.namedChildren.map((c) => (c === null ? null : literal(c)));
        if (!args.includes('-f') && args.includes(MARK)) return { form: `\`unset ${MARK}\`` };
      } else {
        const name = node.childForFieldName('name');
        const args = node.childrenForFieldName('argument').filter((c): c is Node => c !== null);
        const w = [name === null ? null : literal(name), ...args.map(literal)];
        const found = await argvFinding(w, depth);
        if (found !== null) return found;
      }
    }
    return null;
  } finally {
    tree.delete();
  }
}

/** The key a `-c` / `--config-env` value sets. */
const configKey = (value: string): string => value.split('=')[0].toLowerCase();
const isHookKey = (key: string): boolean => key === 'hook' || key.startsWith('hook.');

/**
 * Whether a git argument word's value is unknown until bash runs it: it holds
 * an expansion, or starts with a glob or brace pattern bash may turn into an
 * option such as `--no-verify`. A statement's words have their quotes
 * dropped, so a quoted expansion counts as well: its value may be an option.
 */
const isUnknownWord = (word: string): boolean => /[$`]/.test(word) || /^[*?[{]/.test(word);
/** Stands for the words after an unquoted $( ) or backtick that cut a statement. */
const CUT_WORDS = '$(…)';

const CONFIG_WRITE_ACTIONS = new Set(['set', 'unset', 'rename-section', 'remove-section', 'edit']);
const CONFIG_READ_ACTIONS = new Set(['get', 'list']);
const CONFIG_WRITE_OPTIONS = new Set(['--add', '--replace-all', '--unset', '--unset-all', '--rename-section', '--remove-section', '-e', '--edit']);
const CONFIG_READ_OPTIONS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '-l', '--list']);
const CONFIG_VALUE_OPTIONS = new Set(['-f', '--file', '--blob', '-t', '--type', '--default', '--comment', '--value', '--url']);

/** What the literal words of one `git config …` (<sub>, from `config` on) ask for: its action, the words after it, and whether a write or read form is named. */
function configMode(sub: readonly string[]): { action: string; positional: string[]; write: boolean; read: boolean } {
  const positional: string[] = [];
  let write = false;
  let read = false;
  for (let k = 1; k < sub.length; k++) {
    const word = sub[k];
    if (CONFIG_VALUE_OPTIONS.has(word)) {
      k++;
      continue;
    }
    if (CONFIG_WRITE_OPTIONS.has(word)) write = true;
    else if (CONFIG_READ_OPTIONS.has(word)) read = true;
    else if (!word.startsWith('-')) positional.push(word);
  }
  const action = positional.length > 0 && (CONFIG_WRITE_ACTIONS.has(positional[0]) || CONFIG_READ_ACTIONS.has(positional[0])) ? (positional.shift() as string) : '';
  if (CONFIG_WRITE_ACTIONS.has(action)) write = true;
  else if (action !== '') read = true;
  return { action, positional, write, read };
}

/**
 * Whether one `git config …` (<sub>) is a read whatever its expanded words
 * hold (decision #420): a literal read action or option names it, no literal
 * write form does, the action slot right after `config` is literal, and every
 * expanded word is double-quoted (<loose>[k] false), so none can split into an
 * option or a second action.
 */
function isQuotedRead(sub: readonly string[], loose: readonly boolean[] | null): boolean {
  if (loose === null || isUnknownWord(sub[1] ?? '')) return false;
  const mode = configMode(sub);
  return mode.read && !mode.write && sub.every((word, k) => !isUnknownWord(word) || loose[k] === false);
}

/**
 * The finding one `git config …` (<sub>, from `config` on) makes; <loose>
 * tells, per word, whether bash may split it (null when unknown). A quoted
 * read passes. Otherwise an unknown word before the key, or an unknown key,
 * could itself be a hook key or an action, so it is unresolved; an unknown
 * word after a literal key is a value.
 */
function configFinding(sub: readonly string[], loose: readonly boolean[] | null): Finding {
  if (isQuotedRead(sub, loose)) return null;
  const shown = `\`git ${sub.join(' ')}\``;
  const unknownAt = sub.findIndex(isUnknownWord);
  if (unknownAt > 0) {
    const key = sub.slice(1, unknownAt).find((word, k, before) => !word.startsWith('-') && !CONFIG_VALUE_OPTIONS.has(before[k - 1] ?? '') && !CONFIG_WRITE_ACTIONS.has(word) && !CONFIG_READ_ACTIONS.has(word));
    if (key === undefined) return { unresolved: `${shown} takes its key, an action or an option before the key from ${sub[unknownAt]}` };
  }
  const form = configForm(sub, shown);
  return form === '' ? null : { form };
}

/** The form one `git config …` (<sub>, from `config` on) makes, its words read as literal. */
function configForm(sub: readonly string[], shown: string): string {
  const { action, positional, write, read } = configMode(sub);
  if (action === 'edit' || sub.includes('-e') || sub.includes('--edit')) return `${shown}, which edits a git config file`;
  // `git config <key> <value>` sets; one positional alone reads.
  if (!write && (read || positional.length < 2)) return '';
  const touched = positional.find((p) => isHookKey(p.toLowerCase()) || p.toLowerCase() === 'extensions.worktreeconfig');
  return touched === undefined ? '' : `${shown}, which writes ${touched}`;
}

/** The paths a `chmod` statement changes, relative ones under its dir; one holding an expansion as written. */
function chmodTargets(s: Statement): string[] {
  const words = splitWords(s.stmt);
  if (words.length === 0 || posixBasename(words[0]) !== 'chmod') return [];
  // Options are chmod's flag letters or long options; a mode may itself start with - (`-x`) or +.
  const operands = words.slice(1).filter((w) => !/^-[RfvcHLPhE]+$/.test(w) && !w.startsWith('--'));
  // The first operand is the mode unless --reference names it.
  const files = words.some((w) => w.startsWith('--reference')) ? operands : operands.slice(1);
  return files.map((w) => (w.includes('$') || w.startsWith('/') || s.dir === '-' ? w : `${s.dir}/${w}`));
}

/**
 * The finding one listed statement makes as a git command. Its literal words
 * are judged as written; a word whose value is unknown until bash runs it, or
 * the words an unquoted $( ) or backtick cut off, is unresolved wherever it
 * could be a form: any subcommand, a `-c` / `--config-env` key, a push option.
 */
function gitForm(s: Statement): Finding {
  if (s.opaque === true) return namesForm(s.src ?? s.stmt) ? { unreadable: 'it runs code the analysis cannot read' } : null;
  const sub = gitSubcommandOf(s);
  if (sub === undefined) return { unresolved: `\`${s.src ?? s.stmt}\` takes git's subcommand, or an option before it, from text the guard cannot read literally` };
  if (sub === '') return null;
  const words = splitWords(s.stmt);
  const subWords = splitWords(sub);
  const gitAt = words.findIndex((w) => /^(.*\/)?git$/.test(w));
  const globals = gitAt < 0 ? [] : words.slice(gitAt + 1, words.length - subWords.length);
  for (let k = 0; k < globals.length; k++) {
    const word = globals[k];
    const value = word === '-c' || word === '--config-env' ? globals[k + 1] ?? '' : word.startsWith('--config-env=') ? word.slice('--config-env='.length) : '';
    if (value === '') continue;
    const shown = `\`git ${word.startsWith('--config-env=') ? word : `${word} ${value}`}\``;
    if (isHookKey(configKey(value))) return { form: shown };
    if (isUnknownWord(configKey(value))) return { unresolved: `${shown} takes its config key from ${value}` };
  }
  // A `glued` cut joins the substitution to the last word, which is then unknown too.
  const args = s.cut === undefined ? subWords : s.cut === 'glued' ? [...subWords.slice(0, -1), `${subWords.at(-1) ?? ''}${CUT_WORDS}`] : [...subWords, CUT_WORDS];
  if (args[0] === 'push') {
    const end = args.indexOf('--');
    const options = args.slice(1, end < 0 ? undefined : end);
    const noVerify = options.find((w) => w.length >= '--no-veri'.length && '--no-verify'.startsWith(w));
    if (noVerify !== undefined) return { form: `\`git push ${noVerify}\`` };
    const unknown = options.find(isUnknownWord);
    if (unknown !== undefined) return { unresolved: `\`git ${args.join(' ')}\` takes an argument from ${unknown}, which may be --no-verify` };
  }
  if (args[0] === 'config') {
    // A cut statement's words do not line up with its source, so its split is unknown.
    const loose = s.cut === undefined ? unquotedExpansions(s) : null;
    return configFinding(args, loose === null ? null : loose.slice(loose.length - args.length));
  }
  return null;
}

/** <path> with its `.` and `..` segments folded, as an absolute path. */
function normalized(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

/** Whether <path> is the hook's dir, a file in it, or a git config file: by its `.git/` shape, else under <commonDir>. */
function isProtectedPath(path: string, commonDir: string): boolean {
  if (!path.startsWith('/')) return PROTECTED_TEXT.test(path);
  const p = normalized(path);
  if (PROTECTED_PATH.test(p)) return true;
  return commonDir !== '' && (p === `${commonDir}/tmb` || p.startsWith(`${commonDir}/tmb/`) || p === `${commonDir}/config` || p === `${commonDir}/config.worktree`);
}

/** A finding and the dir whose repo it lands in: a statement's dir, a written path, or '?' for the payload cwd. */
type Located = { readonly finding: NonNullable<Finding>; readonly dir: string };

const dirOf = (path: string): string => (path.startsWith('/') ? path.slice(0, path.lastIndexOf('/')) || '/' : '?');

/** The first form the command makes, with where it lands; null when it makes none. */
async function locate(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<Located | null> {
  const tree = await treeFinding(command, 0);
  if (tree !== null) return { finding: tree, dir: '?' };

  const listed = await cmdStatements(command, cwd, env);
  if (!listed.ok) return namesForm(command) ? { finding: { unreadable: 'tree-sitter-bash could not parse it' }, dir: '?' } : null;
  const changed: { path: string; how: string }[] = [];
  for (const s of listed.statements) {
    const found = gitForm(s);
    if (found !== null) return { finding: found, dir: s.dir };
    changed.push(...chmodTargets(s).map((path) => ({ path, how: '`chmod` of' })));
  }
  for (const line of await writePaths(command, { cwd, root: cwd, env })) {
    changed.push({ path: line.startsWith('UNRESOLVED:') ? line.split(':').slice(2).join(':') : line, how: 'a write to' });
  }
  const located = (hit: { path: string; how: string }): Located => ({ finding: { form: `${hit.how} ${hit.path}` }, dir: dirOf(normalized(hit.path)) });
  const byShape = changed.find(({ path }) => isProtectedPath(path, ''));
  if (byShape !== undefined) return located(byShape);
  // Only a path that could sit in a common dir not named .git (a bare repo) pays for the git call naming it.
  const candidates = changed.filter(({ path }) => /\/(tmb(\/|$)|config(\.worktree)?$)/.test(path));
  if (candidates.length === 0) return null;
  const commonDir = await gitCommonDir(cwd, env);
  const hit = candidates.find(({ path }) => isProtectedPath(path, commonDir));
  return hit === undefined ? null : located(hit);
}

/** Whether the guard stands down for the repo whose main checkout is <root>: only a stored exempt mode does (GH 3279). */
export function standsDownFor(root: string, env: NodeJS.ProcessEnv): boolean {
  return isExempt(dbPath(env) ?? '', root, env);
}

export type StandsDown = (root: string, env: NodeJS.ProcessEnv) => boolean | Promise<boolean>;

/** The gate, every deny routed through <standsDown> for the repo the form lands in. */
export function prepushHookGuardWith(standsDown: StandsDown): Gate {
  return async (payload, env) => {
    if (!isAgentSession(env)) return ALLOW;
    const input = jqInput(payload);
    const command = jqCapture(input, ['tool_input', 'command'], true);
    // A git word beside an expansion may hide a form no keyword shows (`git -c "$KV" push`), so it is parsed too.
    if (command === '' || (!prefilterPasses(command, (text) => KEYWORDS.test(text) || KEYWORDS_ANY_CASE.test(text)) && !gitBesideExpansion(command))) return ALLOW;
    const cwd = payloadCwdOf(input, env);
    const hit = await locate(command, cwd, env);
    if (hit === null) return ALLOW;
    if (await standsDown(await stmtRepoRoot(hit.dir, cwd, env), env)) return ALLOW;
    const finding = hit.finding;
    return 'form' in finding ? denyForm(finding.form) : 'unresolved' in finding ? denyUnresolved(finding.unresolved) : denyUnreadable(finding.unreadable);
  };
}

export const prepushHookGuard: Gate = prepushHookGuardWith(standsDownFor);
