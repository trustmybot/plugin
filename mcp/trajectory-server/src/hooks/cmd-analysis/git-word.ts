/**
 * Where git sits in a statement's words (GH 2797): the first word, by its
 * basename (`/usr/bin/git`, `./git`), or the command a chain of wrappers
 * runs (`env`, `sudo -u me`, `nice -n 5`, `xargs`, `timeout 5`, ...), each
 * wrapper read by its own option table. A wrapper option the table does not
 * know, a `--chdir=` word the listing left for a dir it moved, or a word the
 * table must skip that is not literal makes the place unsure: git is then
 * the first later word whose basename is git, if any. `env -C` / `--chdir`
 * take a dir value only within the words `unwrap` strips, where the listing
 * moves the statement into that dir; elsewhere (`/usr/bin/env`, env behind
 * `setsid` or another wrapper `unwrap` does not strip) they are unknown.
 * `sudo -D` / `-R` stay out of the table.
 */
import { ASSIGNMENT, unwrap } from './unwrap.js';

export interface GitWord {
  /** The index of git's word. */
  at: number;
  /** Every word before it was read by the wrapper table. */
  sure: boolean;
  /** An `xargs` runs it, so stdin may supply its subcommand. */
  xargs: boolean;
}

interface Wrapper {
  /** Short options that take no value. */
  flags?: string;
  /** Short options that take a value, attached or as the next word. */
  values?: string;
  /** Short options whose value, if any, is attached only. */
  attached?: string;
  /** Short options with which the wrapper runs nothing. */
  lookups?: string;
  /** Long options that take no value. */
  long?: readonly string[];
  /** Long options that take a value, after `=` or as the next word. */
  longValues?: readonly string[];
  /** Short options that take a dir value, known only where `unwrap` strips the wrapper and the listing moves the statement into that dir. */
  dirValues?: string;
  /** Long options that take a dir value, known as dirValues are. */
  dirLongValues?: readonly string[];
  /** The one operand before the command. */
  operand?: RegExp;
  /** NAME=value words before the command. */
  assignments?: boolean;
  /** `-<digits>` is an option (`nice -5`). */
  numeric?: boolean;
  /** A lone `-` is an option (`env -`). */
  dash?: boolean;
}

const DURATION = /^[0-9]+(\.[0-9]+)?[smhd]?$/;

const WRAPPERS: { readonly [name: string]: Wrapper } = {
  env: {
    flags: '0iv',
    values: 'u',
    long: ['ignore-environment', 'null', 'debug'],
    longValues: ['unset'],
    dirValues: 'C',
    dirLongValues: ['chdir'],
    assignments: true,
    dash: true,
  },
  command: { flags: 'p', lookups: 'vV' },
  builtin: {},
  exec: { flags: 'cl', values: 'a' },
  nice: { values: 'n', longValues: ['adjustment'], numeric: true },
  nohup: {},
  time: { flags: 'alpqv', values: 'fo', long: ['append', 'portability', 'quiet', 'verbose'], longValues: ['format', 'output'], assignments: true },
  sudo: {
    flags: 'AbEHiknPSsB',
    values: 'CghpTrtUu',
    long: ['askpass', 'background', 'preserve-env', 'set-home', 'login', 'non-interactive', 'preserve-groups', 'stdin', 'shell', 'reset-timestamp', 'bell'],
    longValues: ['close-from', 'command-timeout', 'group', 'host', 'other-user', 'prompt', 'role', 'type', 'user'],
    assignments: true,
  },
  doas: { flags: 'n', values: 'u' },
  xargs: {
    flags: '0oprtx',
    values: 'adEIJLnPRSs',
    attached: 'eil',
    long: ['null', 'no-run-if-empty', 'verbose', 'interactive', 'exit', 'open-tty'],
    longValues: ['arg-file', 'delimiter', 'eof', 'max-args', 'max-chars', 'max-lines', 'max-procs', 'replace', 'process-slot-var'],
  },
  timeout: { flags: 'v', values: 'ks', long: ['foreground', 'preserve-status', 'verbose'], longValues: ['kill-after', 'signal'], operand: DURATION },
  stdbuf: { values: 'eio', longValues: ['error', 'input', 'output'] },
  ionice: { flags: 't', values: 'cn', long: ['ignore'], longValues: ['class', 'classdata'] },
  chrt: {
    flags: 'abdfiorRv',
    values: 'DPT',
    long: ['all-tasks', 'batch', 'deadline', 'fifo', 'idle', 'other', 'rr', 'reset-on-fork', 'verbose'],
    longValues: ['sched-deadline', 'sched-period', 'sched-runtime'],
    operand: /^[0-9]+$/,
  },
  taskset: { flags: 'ac', long: ['all-tasks', 'cpu-list'], operand: /^(0x)?[0-9a-fA-F,-]+$/ },
  setsid: { flags: 'cfw', long: ['ctty', 'fork', 'wait'] },
};
const ALIASES: { readonly [name: string]: string } = { gnice: 'nice', gtimeout: 'timeout', gstdbuf: 'stdbuf' };

/** A word bash may turn into other words (a parameter, command or arithmetic expansion, a brace or glob pattern), or a redirect, which leaves git's words. */
export const NOT_LITERAL = /[$`*?[{]|^[0-9]*[<>]|^&>/;

const GIT = /(^|\/)git$/;
const base = (word: string): string => word.replace(/^.*\//, '');

/** The wrapper a command word names, by its basename. */
function wrapperOf(word: string): Wrapper | undefined {
  const name = base(word);
  return Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : Object.hasOwn(ALIASES, name) ? WRAPPERS[ALIASES[name]] : undefined;
}

type Step = { k: number } | 'unsure' | 'runs-nothing';

/**
 * From the option words after a wrapper at w[k - 1], the index of the word it
 * runs. A dir option is known only when the word holding its value lies
 * before <stripped>.
 */
function skipWrapper(spec: Wrapper, w: readonly string[], k: number, stripped: number): Step {
  const value = (at: number): Step => (at < w.length && !NOT_LITERAL.test(w[at]) ? { k: at + 1 } : 'unsure');
  const dirValue = (at: number): Step => (at < stripped ? value(at) : 'unsure');
  while (k < w.length && w[k].startsWith('-')) {
    const opt = w[k];
    if (NOT_LITERAL.test(opt)) return 'unsure';
    if (opt === '--') {
      k++;
      break;
    }
    if (opt === '-') {
      if (!spec.dash) return 'unsure';
      k++;
      continue;
    }
    if (spec.numeric && /^-[0-9]+$/.test(opt)) {
      k++;
      continue;
    }
    if (opt.startsWith('--')) {
      const eq = opt.indexOf('=');
      const name = opt.slice(2, eq < 0 ? undefined : eq);
      const dir = spec.dirLongValues?.includes(name) === true;
      if (dir && eq >= 0 && k >= stripped) return 'unsure';
      if (dir || spec.longValues?.includes(name)) {
        if (eq >= 0) k++;
        else {
          const step = dir ? dirValue(k + 1) : value(k + 1);
          if (step === 'unsure' || step === 'runs-nothing') return step;
          k = step.k;
        }
      } else if (spec.long?.includes(name) && eq < 0) k++;
      else return 'unsure';
      continue;
    }
    let next = k + 1;
    for (let j = 1; j < opt.length; j++) {
      const ch = opt[j];
      if (spec.lookups?.includes(ch)) return 'runs-nothing';
      if (spec.flags?.includes(ch)) continue;
      if (spec.attached?.includes(ch)) break;
      const dir = spec.dirValues?.includes(ch) === true;
      if (dir && j + 1 < opt.length && k >= stripped) return 'unsure';
      if (dir || spec.values?.includes(ch)) {
        if (j + 1 === opt.length) {
          const step = dir ? dirValue(k + 1) : value(k + 1);
          if (step === 'unsure' || step === 'runs-nothing') return step;
          next = step.k;
        }
        break;
      }
      return 'unsure';
    }
    k = next;
  }
  if (spec.assignments) {
    while (k < w.length && ASSIGNMENT.test(w[k])) {
      if (NOT_LITERAL.test(w[k])) return 'unsure';
      k++;
    }
  }
  if (spec.operand) {
    if (k >= w.length || !spec.operand.test(w[k])) return 'unsure';
    k++;
  }
  return { k };
}

/**
 * Where git's word is in <w>, or null when the statement is no git command:
 * its first word is neither git nor a wrapper, or the wrappers run another
 * command or nothing, or, unsure, no later word's basename is git.
 */
export function gitWord(w: readonly string[]): GitWord | null {
  const stripped = unwrap(w, 0).k;
  let xargs = false;
  let k = 0;
  const unsure = (from: number): GitWord | null => {
    const at = w.findIndex((word, j) => j >= from && GIT.test(word));
    return at < 0 ? null : { at, sure: false, xargs: w.slice(0, at).some((word) => base(word) === 'xargs') };
  };
  if (w.length === 0 || !(GIT.test(w[0]) || w[0].startsWith('--chdir=') || wrapperOf(w[0]) !== undefined)) return null;
  while (k < w.length) {
    const word = w[k];
    if (GIT.test(word)) return { at: k, sure: true, xargs };
    if (word.startsWith('--chdir=')) return unsure(k + 1);
    if (NOT_LITERAL.test(word)) return unsure(k + 1);
    const spec = wrapperOf(word);
    if (spec === undefined) return null;
    if (base(word) === 'xargs') xargs = true;
    const step = skipWrapper(spec, w, k + 1, stripped);
    if (step === 'runs-nothing') return null;
    if (step === 'unsure') return unsure(k + 1);
    k = step.k;
  }
  return null;
}
