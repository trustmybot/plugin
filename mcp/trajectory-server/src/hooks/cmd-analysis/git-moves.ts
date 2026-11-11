/**
 * Whole-tree git moves (GH 2987): what one git statement's words change in its work tree beyond the
 * paths they name, and how those paths can be asked of git before it runs. Pure reads of one
 * statement's words; the write-path analyzer (write-paths.ts) calls it on every statement its
 * visitor reaches and reports each move as a GIT_MOVE line. A checkout of named paths is no move:
 * the analyzer reads its pathspecs. TS-only (prompt-write-approval).
 */

/** How the paths a move changes can be told. */
export type TreeChange =
  /** The paths that differ between HEAD and each rev, and with `worktree` the work tree's own changes too. */
  | { readonly kind: 'revs'; readonly revs: readonly string[]; readonly worktree: boolean }
  /** A checkout's one operand: a rev read as for `revs`, else a pathspec when it names a path. */
  | { readonly kind: 'rev-or-path'; readonly operand: string; readonly worktree: boolean }
  /** The paths a stash entry changes, its untracked files included. */
  | { readonly kind: 'stash'; readonly stash: string }
  /** The paths each commit changes against its one parent. */
  | { readonly kind: 'commits'; readonly commits: readonly string[] }
  /** No list of paths can be asked of git before the move runs. */
  | { readonly kind: 'unresolvable'; readonly why: string };

/** A word of a statement as bash hands it to the command: its unquoted text, and whether bash passes it as written. */
export interface SourceWord {
  readonly text: string;
  readonly literal: boolean;
}

/** One git statement the analyzer reached, as a GIT_MOVE line carries it. */
export interface GitMove {
  /** The statement as the analyzer read it. */
  readonly what: string;
  /** The absolute dir git runs in; null when it cannot be told, or git is pointed at a repository or work tree by option or environment. */
  readonly dir: string | null;
  /** What it changes in the work tree; null for a statement that changes no tree but may move a ref. */
  readonly change: TreeChange | null;
  /** It may move a ref another move in the command reads. */
  readonly refMover: boolean;
}

/** What a git statement's words change, and where they point git. */
export interface GitStatementRead {
  readonly change: TreeChange | null;
  readonly refMover: boolean;
  /** Its own `--git-dir` / `--work-tree` point git at a repository or work tree. */
  readonly located: boolean;
  /** Each `-C` dir in order, or null when one may expand. */
  readonly cdirs: readonly string[] | null;
}

export const GIT_MOVE_PREFIX = 'GIT-MOVE:';

export const gitMoveLine = (move: GitMove): string => `${GIT_MOVE_PREFIX}${JSON.stringify(move)}\n`;

export function parseGitMoveLine(line: string): GitMove | null {
  if (!line.startsWith(GIT_MOVE_PREFIX)) return null;
  try {
    return JSON.parse(line.slice(GIT_MOVE_PREFIX.length)) as GitMove;
  } catch {
    return null;
  }
}

export const unresolvable = (why: string): TreeChange => ({ kind: 'unresolvable', why });
const UNREAD = unresolvable('an argument the gate cannot read as written');
/** A runner may start its command once per path, input line or pass, and each `stash pop` takes the next stash. */
export const REPEATED_STASH = unresolvable('a runner may start it more than once, each run popping or applying another stash');
// A move is judged on the refs as they are before the command runs; another git statement in it (a fetch, a branch -f) may move them first.
export const REFS_MAY_MOVE = unresolvable('another git statement in the command may move the refs it reads first; run it on its own');
export const UNREAD_BODY = unresolvable('it runs shell text the gate cannot read');
export const EXPANDED_COMMAND = unresolvable('its command word comes through an expansion');

/** The subcommands whose statements can rewrite the work tree beyond the paths they name. */
export const MOVE_SUBCOMMANDS = ['checkout', 'switch', 'reset', 'merge', 'cherry-pick', 'revert', 'stash', 'pull', 'rebase', 'am', 'apply'] as const;
/** git subcommands that move no ref and touch no work tree file. */
const READ_ONLY = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'describe', 'blame', 'grep', 'shortlog', 'cat-file', 'merge-base', 'rev-list', 'version', 'help']);
const GLOBAL_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);
const GLOBAL_LOCATION = /^--(git-dir|work-tree)(=|$)/;
/** A rev naming more than one commit: `a..b`, `a...b`, `^a`, `a^!`, `a^@`, `a^-`. */
const COMMIT_RANGE = /\.\.|^\^|\^[!@-]/;
/** The words that end or step a merge, cherry-pick, revert, rebase or am already under way; each returns to or finishes a state a judged move began. */
const SEQUENCER = new Set(['--continue', '--abort', '--quit', '--skip', '--show-current-patch', '--edit-todo', '--resolved']);

interface OptionSpec {
  /** The long options git knows for the subcommand, each read in full or by a unique prefix, as git's parse-options reads them. */
  readonly long: readonly string[];
  /** The long options among them that take the next word as their value when no `=` gives one. */
  readonly longValued: readonly string[];
  /** Short options that take a value: the rest of their cluster, else the next word. */
  readonly shortValued: string;
  /** Short options whose value, if any, is the rest of their cluster. */
  readonly shortOptional?: string;
}

interface ParsedArgs {
  /** Each option given: `--<long name>`, a prefix read in full, or `-<char>`. */
  readonly options: ReadonlySet<string>;
  readonly operands: readonly SourceWord[];
  /** The words after `--`, or null without one. */
  readonly afterDashes: readonly SourceWord[] | null;
}

function longName(name: string, known: readonly string[]): string {
  if (known.includes(name)) return name;
  const matches = known.filter((option) => option.startsWith(name));
  return matches.length === 1 ? matches[0] : name;
}

/** A subcommand's words read as git's parse-options reads them, or null when an option word may expand. */
function parseArgs(words: readonly SourceWord[], spec: OptionSpec): ParsedArgs | null {
  const options = new Set<string>();
  const operands: SourceWord[] = [];
  for (let k = 0; k < words.length; k++) {
    const { text, literal } = words[k];
    if (literal && text === '--') return { options, operands, afterDashes: words.slice(k + 1) };
    if (!text.startsWith('-') || text === '-') {
      operands.push(words[k]);
      continue;
    }
    if (!literal) return null;
    if (text.startsWith('--')) {
      const eq = text.indexOf('=');
      const name = longName(text.slice(2, eq < 0 ? undefined : eq), spec.long);
      options.add(`--${name}`);
      if (eq < 0 && spec.longValued.includes(name)) k++;
      continue;
    }
    for (let i = 1; i < text.length; i++) {
      const c = text[i];
      options.add(`-${c}`);
      if (spec.shortOptional?.includes(c)) break;
      if (spec.shortValued.includes(c)) {
        if (i === text.length - 1) k++;
        break;
      }
    }
  }
  return { options, operands, afterDashes: null };
}

const has = (parsed: ParsedArgs, ...names: string[]): boolean => names.some((name) => parsed.options.has(name));

/** An operand read as a rev: `-` is the branch checked out before, as git reads it; null when the shell may expand it. */
function revOf(word: SourceWord): string | null {
  if (!word.literal) return null;
  return word.text === '-' ? '@{-1}' : word.text;
}

const CHECKOUT: OptionSpec = {
  long: ['force', 'detach', 'merge', 'patch', 'ours', 'theirs', 'track', 'no-track', 'quiet', 'progress', 'no-progress', 'recurse-submodules', 'no-recurse-submodules', 'overlay', 'no-overlay', 'orphan', 'conflict', 'pathspec-from-file', 'pathspec-file-nul', 'ignore-skip-worktree-bits', 'ignore-other-worktrees', 'guess', 'no-guess', 'overwrite-ignore', 'no-overwrite-ignore'],
  longValued: ['orphan', 'conflict', 'pathspec-from-file'],
  shortValued: 'bB',
};

function checkoutChange(words: readonly SourceWord[]): TreeChange | null {
  const parsed = parseArgs(words, CHECKOUT);
  if (parsed === null) return UNREAD;
  if (has(parsed, '-p', '--patch', '--pathspec-from-file', '--ours', '--theirs')) return null;
  if (parsed.afterDashes !== null && parsed.afterDashes.length > 0) return null;
  const worktree = has(parsed, '-f', '--force');
  if (parsed.operands.length === 0) return worktree ? { kind: 'revs', revs: [], worktree } : null;
  if (parsed.operands.length > 1) return null;
  const rev = revOf(parsed.operands[0]);
  if (rev === null) return UNREAD;
  const surelyRev = parsed.afterDashes !== null || has(parsed, '-b', '-B', '--orphan', '--detach');
  return surelyRev ? { kind: 'revs', revs: [rev], worktree } : { kind: 'rev-or-path', operand: rev, worktree };
}

const SWITCH: OptionSpec = {
  long: ['create', 'force-create', 'orphan', 'detach', 'force', 'discard-changes', 'merge', 'conflict', 'guess', 'no-guess', 'track', 'no-track', 'quiet', 'progress', 'no-progress', 'recurse-submodules', 'no-recurse-submodules', 'ignore-other-worktrees'],
  longValued: ['create', 'force-create', 'orphan', 'conflict'],
  shortValued: 'cC',
};

function switchChange(words: readonly SourceWord[]): TreeChange | null {
  const parsed = parseArgs(words, SWITCH);
  if (parsed === null) return UNREAD;
  if (has(parsed, '--orphan')) return unresolvable('switch --orphan empties the work tree');
  const operands = [...parsed.operands, ...(parsed.afterDashes ?? [])];
  if (operands.length === 0) return null;
  const rev = operands.length === 1 ? revOf(operands[0]) : null;
  if (rev === null) return UNREAD;
  return { kind: 'revs', revs: [rev], worktree: has(parsed, '-f', '--force', '--discard-changes') };
}

const RESET: OptionSpec = {
  long: ['hard', 'soft', 'mixed', 'keep', 'merge', 'quiet', 'no-quiet', 'refresh', 'no-refresh', 'recurse-submodules', 'no-recurse-submodules', 'pathspec-from-file', 'pathspec-file-nul', 'intent-to-add'],
  longValued: ['pathspec-from-file'],
  shortValued: '',
};

function resetChange(words: readonly SourceWord[]): TreeChange | null {
  const parsed = parseArgs(words, RESET);
  if (parsed === null) return UNREAD;
  if (!has(parsed, '--hard', '--keep', '--merge')) return null;
  if (has(parsed, '--pathspec-from-file') || (parsed.afterDashes?.length ?? 0) > 0 || parsed.operands.length > 1) return UNREAD;
  if (parsed.operands.length === 0) return { kind: 'revs', revs: [], worktree: true };
  const rev = revOf(parsed.operands[0]);
  return rev === null ? UNREAD : { kind: 'revs', revs: [rev], worktree: true };
}

const MERGE: OptionSpec = {
  long: ['abort', 'quit', 'continue', 'commit', 'no-commit', 'squash', 'no-squash', 'ff', 'no-ff', 'ff-only', 'edit', 'no-edit', 'stat', 'no-stat', 'summary', 'no-summary', 'compact-summary', 'log', 'no-log', 'message', 'file', 'strategy', 'strategy-option', 'into-name', 'cleanup', 'verify', 'no-verify', 'verify-signatures', 'no-verify-signatures', 'gpg-sign', 'no-gpg-sign', 'signoff', 'no-signoff', 'autostash', 'no-autostash', 'allow-unrelated-histories', 'rerere-autoupdate', 'no-rerere-autoupdate', 'overwrite-ignore', 'no-overwrite-ignore', 'quiet', 'verbose', 'progress', 'no-progress'],
  longValued: ['message', 'file', 'strategy', 'strategy-option', 'into-name', 'cleanup'],
  shortValued: 'mFsX',
  shortOptional: 'S',
};

function mergeChange(words: readonly SourceWord[]): TreeChange | null {
  const parsed = parseArgs(words, MERGE);
  if (parsed === null) return UNREAD;
  if (has(parsed, '--abort', '--quit', '--continue')) return null;
  const operands = [...parsed.operands, ...(parsed.afterDashes ?? [])];
  // With no ref, git merges the branch's upstream (merge.defaultToUpstream).
  const revs = operands.length === 0 ? ['@{upstream}'] : operands.map(revOf);
  if (revs.some((rev) => rev === null)) return UNREAD;
  return { kind: 'revs', revs: revs as string[], worktree: false };
}

const PICK: OptionSpec = {
  long: ['continue', 'abort', 'quit', 'skip', 'no-commit', 'edit', 'no-edit', 'signoff', 'mainline', 'strategy', 'strategy-option', 'gpg-sign', 'no-gpg-sign', 'ff', 'allow-empty', 'allow-empty-message', 'keep-redundant-commits', 'empty', 'rerere-autoupdate', 'no-rerere-autoupdate', 'cleanup', 'reference'],
  longValued: ['mainline', 'strategy', 'strategy-option', 'cleanup'],
  shortValued: 'mX',
  shortOptional: 'S',
};

/** A cherry-pick's or revert's commits; any long option it does not know may be a rev-list walk option (`--stdin`, `--all`) naming more commits. */
function pickChange(words: readonly SourceWord[]): TreeChange | null {
  const parsed = parseArgs(words, PICK);
  if (parsed === null) return UNREAD;
  if (has(parsed, '--continue', '--abort', '--quit', '--skip')) return null;
  if (has(parsed, '-m', '--mainline')) return unresolvable('it picks a merge commit');
  if ([...parsed.options].some((option) => option.startsWith('--') && !PICK.long.includes(option.slice(2)))) return unresolvable('a walk option may name more commits');
  const operands = [...parsed.operands, ...(parsed.afterDashes ?? [])];
  if (operands.length === 0) return null;
  const commits = operands.map(revOf);
  if (commits.some((commit) => commit === null)) return UNREAD;
  if (commits.some((commit) => COMMIT_RANGE.test(commit as string))) return unresolvable('it names a commit range');
  return { kind: 'commits', commits: commits as string[] };
}

function stashChange(words: readonly SourceWord[]): TreeChange | null {
  const [action, ...rest] = words;
  if (action === undefined || (action.literal && action.text.startsWith('-'))) return null;
  if (!action.literal) return UNREAD;
  if (action.text === 'branch') return unresolvable("stash branch checks out the stash's base commit");
  if (action.text !== 'pop' && action.text !== 'apply') return null;
  const parsed = parseArgs(rest, { long: ['index', 'quiet'], longValued: [], shortValued: '' });
  if (parsed === null) return UNREAD;
  const operands = [...parsed.operands, ...(parsed.afterDashes ?? [])];
  if (operands.length > 1 || (operands.length === 1 && !operands[0].literal)) return UNREAD;
  return { kind: 'stash', stash: operands[0]?.text ?? 'stash@{0}' };
}

const APPLY: OptionSpec = {
  long: ['check', 'stat', 'numstat', 'summary', 'apply', 'cached', 'index', 'intent-to-add', '3way', 'reverse', 'reject', 'unidiff-zero', 'no-add', 'allow-binary-replacement', 'binary', 'exclude', 'include', 'ignore-space-change', 'ignore-whitespace', 'whitespace', 'inaccurate-eof', 'verbose', 'quiet', 'recount', 'directory', 'unsafe-paths', 'allow-empty'],
  longValued: ['exclude', 'include', 'whitespace', 'directory'],
  shortValued: 'pC',
};

/** git apply writes nothing when it only checks or reports a patch (`--check`, `--stat`, `--numstat`, `--summary`) and `--apply` does not turn writing back on. */
function applyChange(words: readonly SourceWord[]): TreeChange | null {
  const parsed = parseArgs(words, APPLY);
  if (parsed === null) return UNREAD;
  if (has(parsed, '--check', '--stat', '--numstat', '--summary') && !has(parsed, '--apply')) return null;
  return unresolvable('git apply applies a patch the gate does not read');
}

function sequencerOr(words: readonly SourceWord[], why: string): TreeChange | null {
  return words.some((word) => word.literal && SEQUENCER.has(word.text)) ? null : unresolvable(why);
}

function subcommandChange(sub: string, words: readonly SourceWord[]): TreeChange | null {
  switch (sub) {
    case 'checkout':
      return checkoutChange(words);
    case 'switch':
      return switchChange(words);
    case 'reset':
      return resetChange(words);
    case 'merge':
      return mergeChange(words);
    case 'cherry-pick':
    case 'revert':
      return pickChange(words);
    case 'stash':
      return stashChange(words);
    case 'pull':
      return unresolvable('git pull merges or rebases whatever it fetches');
    case 'rebase':
      return sequencerOr(words, 'a rebase replays commits it picks as it runs');
    case 'am':
      return sequencerOr(words, 'git am applies patches the gate does not read');
    case 'apply':
      return applyChange(words);
    default:
      return null;
  }
}

/** What a git statement's words, git first (bare or by path), change, and where its own options point git. */
export function gitStatementRead(argv: readonly SourceWord[]): GitStatementRead {
  let located = false;
  let cdirs: string[] | null = [];
  let k = 1;
  while (k < argv.length && argv[k].text.startsWith('-')) {
    const { text, literal } = argv[k];
    if (!literal) return { change: UNREAD, refMover: true, located, cdirs };
    if (GLOBAL_LOCATION.test(text)) located = true;
    if (text === '-C') {
      const value = argv[k + 1];
      if (value === undefined || !value.literal) cdirs = null;
      else cdirs?.push(value.text);
    }
    k += GLOBAL_VALUED.has(text) ? 2 : 1;
  }
  const sub = argv[k];
  // The listing cuts a git statement at an unquoted command substitution, so its subcommand may follow in a tail record.
  if (sub === undefined && argv.some((word) => !word.literal)) return { change: UNREAD, refMover: true, located, cdirs };
  if (sub === undefined) return { change: null, refMover: false, located, cdirs };
  if (!sub.literal) return { change: UNREAD, refMover: true, located, cdirs };
  const change = subcommandChange(sub.text, argv.slice(k + 1));
  return { change, refMover: !READ_ONLY.has(sub.text), located, cdirs };
}
