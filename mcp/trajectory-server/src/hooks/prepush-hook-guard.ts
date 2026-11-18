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
 * text names one of the forms.
 *
 * Expansions are admitted only where the guard can tell they cannot hide a
 * form; anything else fails closed, by class (GH 3281):
 *   - an unquoted expansion in the value of -C, -c, --git-dir, --work-tree or
 *     --config-env, on any git command (global_option_expansion), its allowed
 *     form the command with each one double-quoted;
 *   - a push with any expansion but a double-quoted -C, --git-dir or
 *     --work-tree value (push_expansion);
 *   - a `git config` with an expansion that is neither a read (literal read
 *     form, literal options before it, double-quoted single words after it)
 *     nor a write whose options before the key are literal and allowlisted,
 *     whose key is literal and no hook key, and whose expansions after the key
 *     are double-quoted single words (config_expansion);
 *   - any other git word whose value the guard cannot tell (unresolved), or
 *     code it cannot read (unreadable).
 * Each fail-closed deny writes one guard_fail_closed prepush_observed row
 * (pre-push/observe.ts observeGuardDeny); a failed write leaves the deny as is.
 *
 * Only the Human sets the hook's switch, PREPUSH_SWITCH: an agent Bash command
 * naming it is denied unless it is only an argument to grep, rg, git grep,
 * cat, printenv or echo with no redirection, and an agent Edit, Write or
 * MultiEdit putting it into CLAUDE_ENV_FILE, a `.claude` settings*.json or a
 * shell profile is denied. The switch reaches every repo, so these denies do
 * not stand down for an exempt one.
 *
 * Outside an agent session nothing is gated, and every other deny first asks
 * standsDownFor, which stands down in an exempt repo, for the repo its form
 * lands in.
 */
import type { Node } from 'web-tree-sitter';
import { ALLOW, type Gate } from './gate.js';
import { cmdStatements, gitBesideExpansion, gitSubcommandOf, prefilterPasses, stmtRepoRoot, unquotedCommand, unquotedExpansions, writePaths, type Statement } from './cmd-analysis/index.js';
import { bashParser } from './cmd-analysis/parser.js';
import { GIT_VALUE_OPTION } from './cmd-analysis/statements.js';
import { ASSIGNMENT, splitWords, unwrap } from './cmd-analysis/unwrap.js';
import { dbPath } from './lib/db.js';
import { denyResult } from './lib/deny.js';
import { isDir } from './lib/git.js';
import { jqCapture, jqGet, jqInput, type JqInput } from './lib/jq-raw.js';
import { posixBasename } from './lib/project-env.js';
import { gitCommonDir, PREPUSH_SWITCH } from './lib/prepush-hook.js';
import { isExempt } from './lib/repo.js';
import { payloadCwdOf } from './lib/statement-rows.js';
import { isAgentSession } from './pre-push/judge.js';
import { observeGuardDeny, type DenyClass } from './pre-push/observe.js';

export const GATE_NAME = 'prepush-hook-guard';

const MARK = 'TMB_AGENT_SHELL';
const GIT_CONFIG_ENV = /^GIT_CONFIG_(COUNT$|PARAMETERS$|KEY_|VALUE_)/;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const MAX_DEPTH = 3;
/** The words a command must hold, as written or unquoted, before it is parsed. */
const KEYWORDS = /no-veri|GIT_CONFIG_|TMB_AGENT_SHELL|TMB_DISABLE_PREPUSH_INSTALL|\benv\b|\bunset\b|\bexport\b|\bdeclare\b|\btypeset\b|\blocal\b|config|\/tmb\b|\btmb\/|chmod/;
const KEYWORDS_ANY_CASE = /hook\.|worktreeconfig/i;
/** What an unreadable command must name to be denied: a form, never a bare `env` or `config`. */
const NAMES_A_FORM = /--no-veri|GIT_CONFIG_|TMB_AGENT_SHELL|\.git\/(tmb|config)|\/tmb\/pre-push/;
const NAMES_A_FORM_ANY_CASE = /hook\.|worktreeconfig/i;
/** A protected file named in text the analysis could not resolve, such as `"$(git rev-parse --git-common-dir)/tmb/pre-push"`. */
const PROTECTED_TEXT = /(\.git|git-(common-)?dir)\S*\/(tmb(\/|$)|config(\.worktree)?$)/i;
const PROTECTED_PATH = /\/\.git\/(tmb(\/|$)|config(\.worktree)?$|worktrees\/[^/]+\/config\.worktree$)/;
const OBSERVE_ONLY = "TMB's pre-push hook only observes in this release: it never blocks a push, so there is nothing to skip.";
const PARSE_REASON = 'BLOCKED: the pre-push hook guard could not read this command, and it names a way to skip the hook or strip the agent mark.';

/** A form named literally, or a command naming the switch. */
type FormFinding = { readonly form: string } | { readonly switchNamed: string };
/** A deny because the guard cannot read the command literally: its class, why, and for global_option_expansion the corrected command. */
type FailClosed = { readonly failClosed: DenyClass; readonly why: string; readonly fix?: string };
type Finding = FormFinding | FailClosed | null;

const unreadable = (why: string): FailClosed => ({ failClosed: 'unreadable', why });
const unresolved = (why: string): FailClosed => ({ failClosed: 'unresolved', why });

const denyForm = (form: string) =>
  denyResult(`BLOCKED: ${form} would skip, disable or replace TMB's pre-push hook. ${OBSERVE_ONLY}`, { allowed: 'the same command without that form' });

const denySwitch = (what: string) =>
  denyResult(
    `BLOCKED: ${what} names ${PREPUSH_SWITCH}, the switch that takes TMB's pre-push hook out of every repo, and only the Human sets it. An agent command may name it only as an argument to grep, rg, git grep, cat, printenv or echo, with no redirection.`,
    { allowed: `a read-only grep, rg, git grep, cat, printenv or echo naming it, with no redirection (\`grep -rn ${PREPUSH_SWITCH} src\`); to set the switch, ask the Human` },
  );

const PUSH_ALLOWED = 'the same push with every argument written literally; only a double-quoted -C, --git-dir or --work-tree value may come from an expansion';
const CONFIG_ALLOWED =
  'the same git config with its options and key written literally and each expansion after the key double-quoted (`git config user.name "$NAME"`), or a literal read form (`git config --get "$KEY"`)';

/** The reason and allowed form of a fail-closed deny, by its class. */
function failClosedDeny(f: FailClosed): { reason: string; allowed: string } {
  switch (f.failClosed) {
    case 'unreadable':
      return { reason: `${PARSE_REASON} (${f.why}) ${OBSERVE_ONLY}`, allowed: 'the same command split into simpler commands with plain quoting' };
    case 'global_option_expansion':
      return {
        reason: `BLOCKED: ${f.why}, which bash splits into words that can hand git an option such as --no-verify or a hook key, so the guard cannot tell what this git command runs. ${OBSERVE_ONLY}`,
        allowed: f.fix ?? 'the same command with that value double-quoted',
      };
    case 'push_expansion':
      return { reason: `BLOCKED: ${f.why}: its value may be --no-verify or a hook key the guard cannot see, so it cannot tell what this push runs. ${OBSERVE_ONLY}`, allowed: PUSH_ALLOWED };
    case 'config_expansion':
      return { reason: `BLOCKED: the pre-push hook guard cannot tell what this git config writes: ${f.why}, so it could set a hook key. ${OBSERVE_ONLY}`, allowed: CONFIG_ALLOWED };
    case 'unresolved':
      return {
        reason: `BLOCKED: the pre-push hook guard cannot tell what this git command runs: ${f.why}, so it could skip, disable or replace TMB's pre-push hook. ${OBSERVE_ONLY}`,
        allowed: 'the same command with that git argument written literally',
      };
  }
}

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
  if (depth >= MAX_DEPTH) return namesForm(body) ? unreadable('code nested past depth 3') : null;
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
  if (tree === null) return namesForm(command) ? unreadable('tree-sitter-bash returned no parse') : null;
  try {
    if (tree.rootNode.hasError) return namesForm(command) ? unreadable('tree-sitter-bash could not parse it') : null;
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
/** git config's flags, fully spelled (git 2.56 `git config <action> -h`); every value option above also has a `--no-` flag. */
const CONFIG_FLAGS = new Set([
  ...['--global', '--system', '--local', '--worktree', '--all', '--regexp', '--fixed-value', '--append', '--includes'],
  ...['-z', '--null', '--name-only', '--show-origin', '--show-scope', '--show-names'],
  ...['--bool', '--int', '--bool-or-int', '--bool-or-str', '--path', '--expiry-date'],
  ...['global', 'system', 'local', 'worktree', 'all', 'regexp', 'fixed-value', 'append', 'includes', 'null', 'name-only', 'show-origin', 'show-scope', 'show-names'].map((f) => `--no-${f}`),
  ...['file', 'blob', 'type', 'default', 'comment', 'value', 'url'].map((f) => `--no-${f}`),
]);

/** The literal words that make a `git config` with expanded words a read (decision #423); the actions only right after `config`. */
const READ_FORM_OPTIONS = new Set(['--get', '--get-all', '--get-regexp', '-l', '--list']);
/** The flags a literal read may carry before its read form. */
const PRE_READ_FLAGS = new Set([
  ...['--global', '--system', '--local', '--worktree', '--fixed-value', '--includes', '--no-includes'],
  ...['-z', '--null', '--name-only', '--show-origin', '--show-scope', '--show-names'],
  ...['--bool', '--int', '--bool-or-int', '--bool-or-str', '--path', '--expiry-date', '--no-type'],
]);
/** The value options a literal read may carry before its read form, their argument attached (`--type=bool`, `-f.git/config`) or the next word. */
const PRE_READ_VALUE_OPTIONS = new Set(['-f', '--file', '--blob', '-t', '--type', '--default']);
/** The words a literal read may carry before its read form. */
const LITERAL_READ_PREFIX: ReadPrefix = {
  flags: PRE_READ_FLAGS,
  valueOptions: PRE_READ_VALUE_OPTIONS,
  attached: PRE_READ_VALUE_OPTIONS,
  what: 'a fully spelled option a read may carry',
};
/**
 * The narrower words a read with expanded words may carry before its read
 * form (decision #438): a scope flag, a literal `--type=<t>`, or `-f`/`--file`
 * with a literal or double-quoted path, so no expansion there can be an
 * option that swallows the read form (`O=--comment; … "$O" --get k v`).
 */
const EXPANDED_READ_PREFIX: ReadPrefix = {
  flags: new Set(['--global', '--local', '--system', '--worktree']),
  valueOptions: new Set(['-f', '--file']),
  attached: new Set(['-f', '--file', '--type']),
  what: 'a scope flag, a literal --type=<t> or -f/--file, the only options a read with an expansion may carry',
};
/** An expansion that may stand for several words even double-quoted: `"$@"`, `"${a[@]}"`, `"$*"` and their `${…}` kin. */
const MANY_WORDS = /\$[@*]|\$\{[^}]*[@*]/;

/** Whether <word> is one of <options> with its value attached: `--file=<f>`, or `-f<f>` for a short one. */
const hasAttachedValue = (word: string, options: ReadonlySet<string>): boolean =>
  [...options].some((o) => (o.startsWith('--') ? word.startsWith(`${o}=`) : word.length > o.length && word.startsWith(o)));
const isOptionWord = (word: string): boolean => word.length > 1 && word.startsWith('-');

/** The words a read may carry before its read form: <flags>, <valueOptions> with their argument in the next word, <attached> with it attached; <what> names that read in a deny. */
type ReadPrefix = { readonly flags: ReadonlySet<string>; readonly valueOptions: ReadonlySet<string>; readonly attached: ReadonlySet<string>; readonly what: string };

type ConfigMode = { action: string; positional: string[]; write: boolean; read: boolean; unspelled: string | undefined };

/**
 * What the literal words of one `git config …` (<sub>, from `config` on) ask
 * for: its action, the words after the options, whether a write or read form
 * is named, and the first option word git config does not spell that way
 * (`--com`, `--unset-a`: git takes any unique prefix). As git does, an action
 * is only the word right after `config`, and options end at `--` or at the
 * first other word, so `git config <key> --get` sets <key> to `--get`.
 */
function configMode(sub: readonly string[]): ConfigMode {
  const positional: string[] = [];
  let write = false;
  let read = false;
  let unspelled: string | undefined;
  const action = CONFIG_WRITE_ACTIONS.has(sub[1] ?? '') || CONFIG_READ_ACTIONS.has(sub[1] ?? '') ? sub[1] : '';
  for (let k = action === '' ? 1 : 2; k < sub.length; k++) {
    const word = sub[k];
    if (word === '--' || !isOptionWord(word)) {
      positional.push(...sub.slice(word === '--' ? k + 1 : k));
      break;
    }
    if (CONFIG_VALUE_OPTIONS.has(word)) k++;
    else if (CONFIG_WRITE_OPTIONS.has(word)) write = true;
    else if (CONFIG_READ_OPTIONS.has(word)) read = true;
    else if (!CONFIG_FLAGS.has(word) && !hasAttachedValue(word, CONFIG_VALUE_OPTIONS) && !isUnknownWord(word)) unspelled ??= word;
  }
  if (CONFIG_WRITE_ACTIONS.has(action)) write = true;
  else if (action !== '') read = true;
  return { action, positional, write, read, unspelled };
}

/** Whether an expanded <word> stays one word when bash runs it: double-quoted (<loose> false) and not `"$@"`-like. */
const isOneQuotedWord = (word: string, loose: boolean | undefined): boolean => loose === false && !MANY_WORDS.test(word);

const isReadForm = (word: string, k: number, forms: ReadonlySet<string>): boolean => forms.has(word) || (k === 1 && CONFIG_READ_ACTIONS.has(word));

/**
 * Where the first of <forms> (or a read action right after `config`) sits in
 * <sub>, or why a word before it may not stand there: each must be a literal
 * word <prefix> allows, so none can take the read form as its value
 * (`--comment --get <key> <value>` sets <key>). A value option's separate-word
 * argument may also be one double-quoted expansion (<loose>[k] false, decision
 * #425): git takes that word as the argument whatever it holds.
 */
function readFormAt(sub: readonly string[], forms: ReadonlySet<string>, loose: readonly boolean[] | null, prefix: ReadPrefix): number | string {
  for (let k = 1; k < sub.length; k++) {
    const word = sub[k];
    if (isUnknownWord(word)) return `${word} before a literal read form`;
    if (isReadForm(word, k, forms)) return k;
    if (prefix.valueOptions.has(word)) {
      const value = sub[k + 1];
      if (value === undefined) return `the value of ${word} from nothing`;
      if (isUnknownWord(value) && !isOneQuotedWord(value, loose?.[k + 1])) return `the value of ${word} from ${value}`;
      k++;
    } else if (!prefix.flags.has(word) && !hasAttachedValue(word, prefix.attached)) {
      return `${word}, which is not ${prefix.what} before its read form`;
    }
  }
  return 'no literal read form';
}

/**
 * Why one `git config …` (<sub>, from `config` on) with expanded words is not
 * a read whatever they hold, or null when it is (decisions #423, #425, #438): a
 * literal read form is present, readFormAt admits the words before it by
 * EXPANDED_READ_PREFIX, and every
 * expanded word after it is double-quoted (<loose>[k] false) and stands for
 * one word.
 */
function expandedReadBlocker(sub: readonly string[], loose: readonly boolean[] | null, mode: ConfigMode): string | null {
  const expanded = sub.find(isUnknownWord) ?? 'an expansion';
  if (!sub.some((word, k) => k > 0 && isReadForm(word, k, READ_FORM_OPTIONS))) return `${expanded} with no literal read form`;
  const readAt = readFormAt(sub, READ_FORM_OPTIONS, loose, EXPANDED_READ_PREFIX);
  if (typeof readAt === 'string') return readAt;
  if (loose === null) return `${expanded} in words the guard cannot line up with the command as written`;
  for (let k = readAt + 1; k < sub.length; k++) {
    const word = sub[k];
    if (!isUnknownWord(word)) continue;
    if (loose[k] !== false) return `${word} unquoted, which bash may split into options`;
    if (MANY_WORDS.test(word)) return `${word}, which may stand for several words`;
  }
  return mode.write ? `${expanded} beside a literal write form` : null;
}

/** The flags a write with expanded words may carry before its key: none takes a value or names a section. */
const PRE_KEY_WRITE_FLAGS = new Set([
  ...['--global', '--system', '--local', '--worktree', '--add', '--replace-all', '--unset', '--unset-all', '--fixed-value'],
  ...['--bool', '--int', '--bool-or-int', '--bool-or-str', '--path', '--expiry-date'],
]);
/** The value options a write with expanded words may carry before its key, their argument literal: attached (`--type=bool`) or the next word. */
const PRE_KEY_WRITE_VALUE_OPTIONS = new Set(['-t', '--type']);
/** A config key as git spells one: a section, a dot, a name. */
const CONFIG_KEY = /^[A-Za-z0-9-]+(\..*)?\.[A-Za-z][A-Za-z0-9-]*$/;

/**
 * Why one `git config …` (<sub>, from `config` on) with expanded words is not
 * a write whatever they hold, or null when it is: legacy mode, which ends its
 * options at the key, so every word before the key is a literal option
 * PRE_KEY_WRITE_* allows (no action word: subcommand mode may take options
 * after the key); the key literal and neither a hook key nor
 * extensions.worktreeConfig; every expanded word after it double-quoted
 * (<loose>[k] false) and one word.
 */
function expandedWriteBlocker(sub: readonly string[], loose: readonly boolean[] | null): string | null {
  let k = 1;
  for (; k < sub.length; k++) {
    const word = sub[k];
    if (isUnknownWord(word)) return `${word} before the key`;
    if (!isOptionWord(word)) break;
    if (PRE_KEY_WRITE_VALUE_OPTIONS.has(word)) {
      const value = sub[k + 1];
      if (value === undefined || isUnknownWord(value)) return `the value of ${word} from ${value ?? 'nothing'}`;
      k++;
    } else if (!PRE_KEY_WRITE_FLAGS.has(word) && !hasAttachedValue(word, PRE_KEY_WRITE_VALUE_OPTIONS)) {
      return `${word}, which is not an option a config write with an expansion may carry before its key`;
    }
  }
  const key = sub[k];
  if (key === undefined) return 'an expansion and no key';
  if (CONFIG_WRITE_ACTIONS.has(key) || CONFIG_READ_ACTIONS.has(key) || !CONFIG_KEY.test(key)) return `${key} where a literal key belongs`;
  if (isHookKey(key.toLowerCase()) || key.toLowerCase() === 'extensions.worktreeconfig') return `the key ${key}`;
  if (loose === null) return 'an expansion in words the guard cannot line up with the command as written';
  for (let j = k + 1; j < sub.length; j++) {
    const word = sub[j];
    if (!isUnknownWord(word)) continue;
    if (loose[j] !== false) return `${word} unquoted, which bash may split into options`;
    if (MANY_WORDS.test(word)) return `${word}, which may stand for several words`;
  }
  return null;
}

/**
 * The finding one `git config …` (<sub>, from `config` on) makes; <loose>
 * tells, per word, whether bash may split it (null when unknown). A form its
 * words name as written is denied as that form. Past that, an option git
 * would read as an abbreviation is unresolved; with an expanded word it
 * passes only as a read expandedReadBlocker admits or a write
 * expandedWriteBlocker admits, else it is config_expansion; a literal read
 * passes only when readFormAt admits the words before its read form.
 */
function configFinding(sub: readonly string[], loose: readonly boolean[] | null): Finding {
  const shown = `\`git ${sub.join(' ')}\``;
  const mode = configMode(sub);
  const form = configForm(sub, shown, mode);
  if (form !== '') return { form };
  if (mode.unspelled !== undefined) return unresolved(`${shown} takes ${mode.unspelled}, which is not a git config option spelled out in full, so git may read it as another`);
  if (sub.some(isUnknownWord)) {
    const readBlocker = expandedReadBlocker(sub, loose, mode);
    if (readBlocker === null) return null;
    const writeBlocker = expandedWriteBlocker(sub, loose);
    if (writeBlocker === null) return null;
    // A command naming a read form is told why it is no read; any other, why it is no write.
    const namesRead = sub.some((word, k) => k > 0 && isReadForm(word, k, READ_FORM_OPTIONS));
    return { failClosed: 'config_expansion', why: `${shown} takes ${namesRead ? readBlocker : writeBlocker}` };
  }
  if (!mode.read) return null;
  const readAt = readFormAt(sub, CONFIG_READ_OPTIONS, loose, LITERAL_READ_PREFIX);
  return typeof readAt === 'string' ? unresolved(`${shown} takes ${readAt}`) : null;
}

/** The form one `git config …` (<sub>, from `config` on) makes, its words read as literal. */
function configForm(sub: readonly string[], shown: string, mode: ConfigMode): string {
  const { action, positional, write, read } = mode;
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

/** The git global options whose value an unquoted expansion may not fill on any git command (SC3 a). */
const SPLIT_CHECKED_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--config-env']);
const SPLIT_CHECKED_JOINED = /^(--git-dir|--work-tree|--config-env)=/;
/** The git global options a push may take from one double-quoted expansion (SC3 b). */
const PLACE_OPTIONS = new Set(['-C', '--git-dir', '--work-tree']);
const PLACE_JOINED = /^(--git-dir|--work-tree)=/;
const EXPANSION_NODES = new Set(['simple_expansion', 'expansion', 'command_substitution', 'arithmetic_expansion', 'process_substitution']);
const QUOTED_NODES = new Set(['string', 'raw_string', 'ansi_c_string', 'translated_string']);

/** The expansions in <node> no quotes hold, outermost only. */
function unquotedExpansionNodes(node: Node): Node[] {
  if (EXPANSION_NODES.has(node.type)) return [node];
  if (QUOTED_NODES.has(node.type)) return [];
  return node.namedChildren.flatMap((c) => (c === null ? [] : unquotedExpansionNodes(c)));
}

/** One value of a SPLIT_CHECKED option in a git command's parse: the option, the value's node (the whole word when joined), its unquoted expansions. */
type GlobalValue = { readonly option: string; readonly node: Node; readonly unquoted: readonly Node[] };

/** The SPLIT_CHECKED option values before the subcommand of the git <command> node, or null when it runs no git its words show. */
function gitGlobalValues(command: Node): GlobalValue[] | null {
  const name = command.childForFieldName('name');
  const words = [name, ...command.childrenForFieldName('argument')].filter((c): c is Node => c !== null);
  const gitAt = words.findIndex((w) => {
    const text = literal(w);
    return text !== null && posixBasename(text) === 'git';
  });
  if (gitAt < 0 || words.slice(0, gitAt).some((w) => literal(w) === null)) return null;
  const values: GlobalValue[] = [];
  for (let k = gitAt + 1; k < words.length; k++) {
    const word = words[k];
    const text = literal(word);
    if (text !== null && GIT_VALUE_OPTION.has(text)) {
      const value = words[k + 1];
      if (value !== undefined && SPLIT_CHECKED_OPTIONS.has(text)) values.push({ option: text, node: value, unquoted: unquotedExpansionNodes(value) });
      k++;
      continue;
    }
    const joined = SPLIT_CHECKED_JOINED.exec(word.text);
    if (joined !== null) values.push({ option: joined[1], node: word, unquoted: unquotedExpansionNodes(word) });
    else if (text === null || !text.startsWith('-')) break;
  }
  return values;
}

/** <text> with each unquoted expansion in a SPLIT_CHECKED git option's value double-quoted; <text> itself when it holds none or does not parse. */
async function quoteGlobalValues(text: string): Promise<string> {
  const tree = (await bashParser()).parse(text);
  if (tree === null) return text;
  try {
    if (tree.rootNode.hasError) return text;
    const spans = tree.rootNode
      .descendantsOfType('command')
      .flatMap((c) => (c === null ? [] : (gitGlobalValues(c) ?? []).flatMap((v) => v.unquoted)))
      .sort((a, b) => b.startIndex - a.startIndex);
    let fixed = text;
    for (const node of spans) fixed = `${fixed.slice(0, node.startIndex)}"${fixed.slice(node.startIndex, node.endIndex)}"${fixed.slice(node.endIndex)}`;
    return fixed;
  } finally {
    tree.delete();
  }
}

/**
 * The finding the SPLIT_CHECKED option values of git statement <src> make: a
 * literal `-c` / `--config-env` hook key is that form; an unquoted expansion
 * in any of them fails closed as global_option_expansion, its fix <command>
 * (else <src>) with each such expansion double-quoted. Null when <src> does
 * not parse, so the statement's other checks judge it.
 */
async function globalValueFinding(src: string, command: string): Promise<Finding> {
  const tree = (await bashParser()).parse(src);
  if (tree === null) return null;
  let split: GlobalValue[];
  try {
    if (tree.rootNode.hasError) return null;
    const values = tree.rootNode
      .descendantsOfType('command')
      .map((c) => (c === null ? null : gitGlobalValues(c)))
      .find((v) => v !== null) ?? [];
    for (const value of values) {
      const key = unquotedCommand(value.node.text).replace(SPLIT_CHECKED_JOINED, '').split('=')[0];
      if ((value.option === '-c' || value.option === '--config-env') && !/[$`]/.test(key) && isHookKey(key.toLowerCase())) {
        return { form: `\`git ${SPLIT_CHECKED_JOINED.test(value.node.text) ? value.node.text : `${value.option} ${value.node.text}`}\`` };
      }
    }
    split = values.filter((v) => v.unquoted.length > 0);
  } finally {
    tree.delete();
  }
  if (split.length === 0) return null;
  const fixedCommand = await quoteGlobalValues(command);
  return {
    failClosed: 'global_option_expansion',
    why: `\`${src}\` gives ${[...new Set(split.map((v) => v.option))].join(', ')} an unquoted expansion`,
    fix: fixedCommand !== command ? fixedCommand : await quoteGlobalValues(src),
  };
}

/** The first word of a push statement (<words> its own, <globals> those between git and `push`, <args> from `push` on) that comes from an expansion, save a PLACE_OPTIONS value, which reaches here only double-quoted. */
function pushExpansion(wrappers: string | undefined, globals: readonly string[], args: readonly string[]): string | undefined {
  if (wrappers !== undefined && /[$`]/.test(wrappers)) return wrappers;
  for (let k = 0; k < globals.length; k++) {
    const word = globals[k];
    if (PLACE_OPTIONS.has(word)) {
      k++;
      continue;
    }
    if (PLACE_JOINED.test(word)) continue;
    if (isUnknownWord(word)) return word;
  }
  return args.slice(1).find(isUnknownWord);
}

/**
 * The finding one listed statement makes as a git command (<command> the
 * whole Bash command). Its literal words are judged as written; past that it
 * fails closed by class (see the header): an unquoted expansion in a
 * SPLIT_CHECKED option value, a push with an expansion, a `git config` with
 * one configFinding does not admit, any other git word whose value the guard
 * cannot tell where a form could sit.
 */
async function gitForm(s: Statement, command: string): Promise<Finding> {
  if (s.opaque === true) return namesForm(s.src ?? s.stmt) ? unreadable('it runs code the analysis cannot read') : null;
  const sub = gitSubcommandOf(s);
  if (sub === '') return null;
  if (s.src !== undefined) {
    const global = await globalValueFinding(s.src, command);
    if (global !== null) return global;
  }
  if (sub === undefined) return unresolved(`\`${s.src ?? s.stmt}\` takes git's subcommand, or an option before it, from text the guard cannot read literally`);
  const words = splitWords(s.stmt);
  const subWords = splitWords(sub);
  const gitAt = words.findIndex((w) => /^(.*\/)?git$/.test(w));
  const globals = gitAt < 0 ? [] : words.slice(gitAt + 1, words.length - subWords.length);
  // A `glued` cut joins the substitution to the last word, which is then unknown too.
  const args = s.cut === undefined ? subWords : s.cut === 'glued' ? [...subWords.slice(0, -1), `${subWords.at(-1) ?? ''}${CUT_WORDS}`] : [...subWords, CUT_WORDS];
  const push = args[0] === 'push';
  for (let k = 0; k < globals.length; k++) {
    const word = globals[k];
    const value = word === '-c' || word === '--config-env' ? globals[k + 1] ?? '' : word.startsWith('--config-env=') ? word.slice('--config-env='.length) : '';
    if (value === '') continue;
    const shown = `\`git ${word.startsWith('--config-env=') ? word : `${word} ${value}`}\``;
    if (isHookKey(configKey(value))) return { form: shown };
    if (isUnknownWord(configKey(value)) && !push) return unresolved(`${shown} takes its config key from ${value}`);
  }
  if (push) {
    const end = args.indexOf('--');
    const options = args.slice(1, end < 0 ? undefined : end);
    const noVerify = options.find((w) => w.length >= '--no-veri'.length && '--no-verify'.startsWith(w));
    if (noVerify !== undefined) return { form: `\`git push ${noVerify}\`` };
    const expanded = pushExpansion(s.wrappers, globals, args);
    if (expanded !== undefined) return { failClosed: 'push_expansion', why: `\`git ${[...globals, ...args].join(' ')}\` takes ${expanded}, which bash expands when it runs` };
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

/** A finding, the dir whose repo it lands in (a statement's dir, a written path, or '?' for the payload cwd) and the statement that made it. */
type Located = { readonly finding: NonNullable<Finding>; readonly dir: string; readonly statement: string };

const dirOf = (path: string): string => (path.startsWith('/') ? path.slice(0, path.lastIndexOf('/')) || '/' : '?');

/** The commands that may take the switch's name as an argument, and what else a pipeline stage beside them may run. */
const SWITCH_READERS = new Set(['grep', 'rg', 'cat', 'printenv', 'echo']);
const SWITCH_PIPE_STAGES = new Set([...SWITCH_READERS, 'head', 'tail', 'wc']);
/** Nodes that write, run other code or set a variable: none may sit in a command naming the switch. */
const SWITCH_UNSAFE_NODES = ['file_redirect', 'heredoc_redirect', 'herestring_redirect', 'command_substitution', 'process_substitution', 'variable_assignment'];
const SWITCH_SHOWN_MAX = 120;

const namesSwitch = (text: string): boolean => text.includes(PREPUSH_SWITCH) || unquotedCommand(text).includes(PREPUSH_SWITCH);

/**
 * Whether <node> is a plain read-only command from <allowed>: a literal name,
 * no redirect, substitution or assignment, and none of the options that make
 * rg or git grep run another program (`rg --pre`, `git grep -O`).
 */
function isReadOnlyCommand(node: Node, allowed: ReadonlySet<string>): boolean {
  if (node.type !== 'command' || node.descendantsOfType(SWITCH_UNSAFE_NODES).length > 0) return false;
  const name = node.childForFieldName('name');
  const argv0 = name === null ? null : literal(name);
  if (argv0 === null) return false;
  const args = node.childrenForFieldName('argument').map((a) => a?.text ?? '');
  const base = posixBasename(argv0);
  if (base === 'git') return allowed.has('grep') && args[0] === 'grep' && !args.some((a) => /^(-[A-Za-z]*O|--o)/.test(a));
  if (base === 'rg' && args.some((a) => a.startsWith('--pre'))) return false;
  return allowed.has(base);
}

/** Whether top-level statement <node> names the switch only as an argument to a SWITCH_READERS command, a pipeline of read-only stages, or a list of such. */
function readsSwitchOnly(node: Node): boolean {
  switch (node.type) {
    case 'command':
      return isReadOnlyCommand(node, SWITCH_READERS);
    case 'pipeline':
      return node.namedChildren.every((stage) => stage !== null && isReadOnlyCommand(stage, SWITCH_PIPE_STAGES));
    case 'list':
      return node.namedChildren.every((c) => c === null || c.type === 'comment' || !namesSwitch(c.text) || readsSwitchOnly(c));
    default:
      return false;
  }
}

/** The switch finding of a Bash <command> that names PREPUSH_SWITCH anywhere but as an argument readsSwitchOnly admits; a command that does not parse counts. */
async function switchFinding(command: string): Promise<Finding> {
  if (!namesSwitch(command)) return null;
  const shown = (text: string): string => `\`${text.length > SWITCH_SHOWN_MAX ? `${text.slice(0, SWITCH_SHOWN_MAX - 1)}…` : text}\``;
  const tree = (await bashParser()).parse(command);
  if (tree === null) return { switchNamed: `${shown(command)}, which the guard could not parse,` };
  try {
    if (tree.rootNode.hasError) return { switchNamed: `${shown(command)}, which the guard could not parse,` };
    const named = tree.rootNode.namedChildren.find((c) => c !== null && c.type !== 'comment' && namesSwitch(c.text) && !readsSwitchOnly(c));
    return named === undefined || named === null ? null : { switchNamed: shown(named.text) };
  } finally {
    tree.delete();
  }
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const SHELL_PROFILES = new Set(['.zshrc', '.zshenv', '.zprofile', '.zlogin', '.bashrc', '.bash_profile', '.bash_login', '.profile']);

/** Whether <path> is a file an agent could set the switch through: the session's CLAUDE_ENV_FILE, a settings*.json under a `.claude` dir, or a shell profile. */
function isSwitchTarget(path: string, env: NodeJS.ProcessEnv): boolean {
  const envFile = env.CLAUDE_ENV_FILE ?? '';
  if (envFile !== '' && normalized(envFile) === path) return true;
  const base = posixBasename(path);
  return SHELL_PROFILES.has(base) || (/^settings.*\.json$/.test(base) && path.split('/').includes('.claude'));
}

/** The text an Edit, Write or MultiEdit puts into its file: `content`, `new_string`, or each edit's `new_string`. */
function newText(input: JqInput): string {
  const tool = input.values[0];
  const edits = jqGet(tool, 'tool_input', 'edits');
  return [
    jqGet(tool, 'tool_input', 'content'),
    jqGet(tool, 'tool_input', 'new_string'),
    ...(Array.isArray(edits) ? edits.map((e) => (e !== null && typeof e === 'object' ? (e as Record<string, unknown>).new_string : null)) : []),
  ]
    .filter((t): t is string => typeof t === 'string')
    .join('\n');
}

/** The switch finding of an Edit, Write or MultiEdit (<tool>) whose new text names PREPUSH_SWITCH in a file isSwitchTarget names. */
function editSwitchFinding(tool: string, input: JqInput, cwd: string, env: NodeJS.ProcessEnv): Finding {
  const filePath = jqCapture(input, ['tool_input', 'file_path'], true);
  if (filePath === '') return null;
  const path = normalized(filePath.startsWith('/') ? filePath : `${cwd}/${filePath}`);
  if (!isSwitchTarget(path, env) || !newText(input).includes(PREPUSH_SWITCH)) return null;
  return { switchNamed: `a ${tool} of ${path} whose new text` };
}

/** The first form the command makes, with where it lands; null when it makes none. */
async function locate(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<Located | null> {
  const named = await switchFinding(command);
  if (named !== null) return { finding: named, dir: '?', statement: command };
  const tree = await treeFinding(command, 0);
  if (tree !== null) return { finding: tree, dir: '?', statement: command };

  const listed = await cmdStatements(command, cwd, env);
  if (!listed.ok) return namesForm(command) ? { finding: unreadable('tree-sitter-bash could not parse it'), dir: '?', statement: command } : null;
  const changed: { path: string; how: string }[] = [];
  for (const s of listed.statements) {
    const found = await gitForm(s, command);
    if (found !== null) return { finding: found, dir: s.dir, statement: s.src ?? s.stmt };
    changed.push(...chmodTargets(s).map((path) => ({ path, how: '`chmod` of' })));
  }
  for (const line of await writePaths(command, { cwd, root: cwd, env })) {
    changed.push({ path: line.startsWith('UNRESOLVED:') ? line.split(':').slice(2).join(':') : line, how: 'a write to' });
  }
  const located = (hit: { path: string; how: string }): Located => ({ finding: { form: `${hit.how} ${hit.path}` }, dir: dirOf(normalized(hit.path)), statement: command });
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

const COMMAND_FORM_MAX = 200;
const MASK = '<arg>';

const capped = (text: string): string => (text.length > COMMAND_FORM_MAX ? `${text.slice(0, COMMAND_FORM_MAX - 1)}…` : text);

/**
 * <statement> as a guard_fail_closed row records it: each command's name, its
 * option words (an `--opt=value` one as `--opt=<arg>`), git's subcommand and
 * every word holding an expansion kept; every other literal argument masked
 * as `<arg>`; at most COMMAND_FORM_MAX chars. Text that does not parse has its
 * quoted literals masked instead.
 */
async function commandForm(statement: string): Promise<string> {
  const tree = (await bashParser()).parse(statement);
  if (tree === null || tree.rootNode.hasError) {
    tree?.delete();
    return capped(statement.replace(/'[^']*'|"[^"$`\\]*"/g, MASK));
  }
  try {
    const masks: { start: number; end: number; text: string }[] = [];
    for (const command of tree.rootNode.descendantsOfType('command')) {
      if (command === null) continue;
      const name = command.childForFieldName('name');
      let git = name !== null && posixBasename(literal(name) ?? '') === 'git';
      let optionValue = false;
      for (const arg of command.childrenForFieldName('argument')) {
        if (arg === null) continue;
        const text = literal(arg);
        if (text === null) {
          // An expansion in git's subcommand slot is that subcommand: the words after it are its arguments.
          if (git && !optionValue) git = false;
          optionValue = false;
          continue;
        }
        if (text.startsWith('-') && text.length > 1 && !optionValue) {
          const eq = text.indexOf('=');
          if (eq > 0) masks.push({ start: arg.startIndex, end: arg.endIndex, text: `${text.slice(0, eq + 1)}${MASK}` });
          optionValue = git && GIT_VALUE_OPTION.has(text);
          continue;
        }
        if (git && !optionValue) git = false; // git's subcommand stays as written
        else masks.push({ start: arg.startIndex, end: arg.endIndex, text: MASK });
        optionValue = false;
      }
    }
    let form = statement;
    for (const m of masks.sort((a, b) => b.start - a.start)) form = `${form.slice(0, m.start)}${m.text}${form.slice(m.end)}`;
    return capped(form);
  } finally {
    tree.delete();
  }
}

/** Writes the guard_fail_closed row for <hit>; any failure is swallowed, so the deny stands as it is. */
async function recordFailClosed(hit: Located & { finding: FailClosed }, reason: string, cwd: string, sessionId: string, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const dir = hit.dir === '?' || hit.dir === '-' || hit.dir === '' || !isDir(hit.dir) ? cwd : hit.dir;
    await observeGuardDeny({ dir, denyClass: hit.finding.failClosed, commandForm: await commandForm(hit.statement), reason, sessionId, caller: GATE_NAME }, env);
  } catch {
    /* recording never changes the deny */
  }
}

/**
 * The gate. A switch finding denies whatever the repo, since the switch
 * reaches every repo; every other deny is routed through <standsDown> for the
 * repo the form lands in, and a fail-closed one is recorded before it returns.
 */
export function prepushHookGuardWith(standsDown: StandsDown): Gate {
  return async (payload, env) => {
    if (!isAgentSession(env)) return ALLOW;
    const input = jqInput(payload);
    const tool = jqCapture(input, ['tool_name'], true);
    const cwd = payloadCwdOf(input, env);
    if (EDIT_TOOLS.has(tool)) {
      const named = editSwitchFinding(tool, input, cwd, env);
      return named !== null && 'switchNamed' in named ? denySwitch(named.switchNamed) : ALLOW;
    }
    const command = jqCapture(input, ['tool_input', 'command'], true);
    // A git word beside an expansion may hide a form no keyword shows (`git -c "$KV" push`), so it is parsed too.
    if (command === '' || (!prefilterPasses(command, (text) => KEYWORDS.test(text) || KEYWORDS_ANY_CASE.test(text)) && !gitBesideExpansion(command))) return ALLOW;
    const hit = await locate(command, cwd, env);
    if (hit === null) return ALLOW;
    const finding = hit.finding;
    if ('switchNamed' in finding) return denySwitch(finding.switchNamed);
    if (await standsDown(await stmtRepoRoot(hit.dir, cwd, env), env)) return ALLOW;
    if ('form' in finding) return denyForm(finding.form);
    const { reason, allowed } = failClosedDeny(finding);
    await recordFailClosed({ ...hit, finding }, reason, cwd, jqCapture(input, ['session_id'], true), env);
    return denyResult(reason, { allowed });
  };
}

export const prepushHookGuard: Gate = prepushHookGuardWith(standsDownFor);
