/**
 * tmb_cmd_write_paths (cmd-analysis.sh) on tree-sitter-bash: every path a
 * command writes, resolved against its statement's dir, with the variables it
 * assigns tracked, bash -c / eval bodies and sh programs fed on stdin judged
 * as commands of their own, interpreter one-liners and stdin programs judged
 * by their write calls, what find / fd / xargs run judged with its
 * placeholder bound, and loop variables bound to the paths their lister may
 * list. A bash -c statement's own redirects and write commands are judged
 * before its body. Where cmd-analysis.sh misses a write, the TS fails closed
 * with UNRESOLVED:$(computed):<argv0 or text> (GH 1692): a program piped or
 * redirected into an interpreter (an info option counts only among the
 * interpreter's own options, before `-`, `--`, `sh -s` or an operand; perl -c
 * is not one, ruby -c is), a bash -c program held in a variable or in
 * substitutions nested to any depth, a write target the scanner cannot read
 * (a `sys.argv[n]` / `process.argv[n]` one included) beside the literal ones,
 * a shell
 * body that find / fd / xargs run on a positional parameter, and bash -c /
 * eval / heredoc nesting deeper than 3. It prints
 * UNRESOLVED:$(unproven):<text> (GH 1739) for an inline program it cannot
 * prove, a program, eval argument or sh -c body part of whose text the shell
 * fills in, and a statement whose command word is an expansion; a variable
 * set where the tracking cannot follow (`+=`, a subscript, `declare -n`,
 * `mapfile`, an arithmetic or `name=` text anywhere in another statement) is
 * poisoned so its later uses fail closed. An analysis past ANALYSIS_WORK_CAP
 * work units, or one that overflows the stack or the longest string, prints
 * only CAP_LINE (GH 2090): a command is judged only if its analysis finishes.
 */
import type { Parser } from 'web-tree-sitter';
import { type Charge, type Heredoc, decode, encode, heldKey } from './encode.js';
import { type ListerHost, listerBind } from './lister.js';
import { pathCanonical } from './path.js';
import type { Lang } from './prog-calls.js';
import { COMPUTED, PARSE, UNPROVEN, heldProgram, interpWrites, progWrites, shown } from './programs.js';
import { ALT, LOOP_CLOSE, LOOP_OPEN, type Record as Statement, SEP, UNBALANCED, WSEP, statementsEnc } from './statements.js';
import { type Interp, stmtWritePaths, unwrapStatement } from './targets.js';

const BAD = '\x01';
const MAX_DEPTH = 3;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROG_DIR = '/.tmb-prog-dir';
const XARGS_VALUE = /^(-d|-E|-L|-n|-P|-s|-R|-S|--delimiter|--max-lines|--max-args|--max-procs|--max-chars)$/;
const WATCH_VALUE = /^(-[A-Za-z]*[nq]|--interval|--equexit)$/;
const BODY_UNRESOLVED = /^UNRESOLVED:(?!\$\(|PWD:)/;
/** The options that make an interpreter print information and exit, judged only among its own options. */
const INFO: Record<Lang | 'sh', RegExp> = {
  py: /^(-V|-VV|--version|-h|--help|-\?)$/,
  node: /^(-v|--version|-h|--help|--v8-options|-c|--check)$/,
  perl: /^(-v|-V|-h)$/,
  ruby: /^(-v|--version|-h|--help|-c|-y)$/,
  sh: /^(--version|--help|-n)$/,
};

/** Characters read, scanned, printed or held in tracked variables, and syntax nodes walked, one unit each. */
export const ANALYSIS_WORK_CAP = 1_000_000;
const CAP_TEXT = `analysis cap reached (${ANALYSIS_WORK_CAP} work units): split this command into smaller ones`;
const CAP_LINE = `UNRESOLVED:${COMPUTED}${CAP_TEXT}`;

/** The deny of a gate that acts on the cap itself, in the shape router/records.ts reads as no path judged. */
export const CAP_REASON = `BLOCKED: write target "${CAP_TEXT}" cannot be judged: the analyzer stopped before it finished reading this command, so the guard cannot tell what it writes.`;

export const isCapLine = (line: string): boolean => line === CAP_LINE;

class WorkCapReached extends Error {}

export interface Host {
  HOME?: string;
  TMPDIR?: string;
  CLAUDE_PROJECT_DIR?: string;
  TMB_MODEL_CACHE_DIR?: string;
  HF_HOME?: string;
}

export interface Options {
  cwd: string;
  raw: boolean;
  root: string;
  env: Host;
}

interface Level {
  vars: string;
  oldtok: string;
  why: string;
}

type Expansion = { ok: true; values: string[] } | { ok: false; unres: string };

const basename = (w: string): string => w.replace(/.*\//, '');
const chomp = (s: string): string => s.replace(/\n+$/, '');
const dec = (s: string): string => chomp(decode(s));
const before = (s: string, sep: string): string => {
  const k = s.indexOf(sep);
  return k < 0 ? s : s.slice(0, k);
};
const after = (s: string, sep: string): string => {
  const k = s.indexOf(sep);
  return k < 0 ? s : s.slice(k + sep.length);
};
const shellWords = (s: string): string[] => s.split(/[ \t\n]+/).filter((w) => w !== '');

export function dirPath(tok: string, cwd: string): string {
  if (tok.startsWith('/')) return tok;
  if (tok === '@') return cwd;
  if (tok.startsWith('@/')) return cwd === '' ? '' : `${cwd.replace(/\/$/, '')}/${tok.slice(2)}`;
  return '';
}

function normalize(p: string): string {
  const lead = p.startsWith('/') ? '/' : '';
  const out: string[] = [];
  for (const part of p === '' ? [] : p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') {
      out.pop();
      continue;
    }
    if (part === '..' && lead === '/') continue;
    out.push(part);
  }
  const joined = out.join('/');
  return lead + (joined === '' && lead === '' ? '.' : joined);
}

/** One fail-closed line for a shape whose write target the analyzer cannot name. */
function computedLine(text: string): string {
  return `UNRESOLVED:${COMPUTED}${shown(text)}\n`;
}

/** One fail-closed line for a program or command whose text the analyzer cannot prove. */
function unprovenLine(text: string): string {
  return `UNRESOLVED:${UNPROVEN}${shown(text)}\n`;
}

/** The line for a command tree-sitter-bash cannot parse: its first 80 characters, on one line. */
function parseLine(cmd: string): string {
  return `UNRESOLVED:${PARSE}${[...cmd].slice(0, 80).join('').replace(/[\r\n]/g, ' ')}\n`;
}

/** _tmb_cmd_inner: the -c string of a shell or the rest of an eval; for watch (TS only), the command it runs through sh -c. */
function inner(stmt: string): string {
  const words = shellWords(stmt);
  const argv0 = words[0] ?? '';
  if (basename(argv0) === 'watch') {
    let i = 1;
    while (i < words.length && words[i].startsWith('-')) {
      const w = words[i++];
      if (w === '--') break;
      if (WATCH_VALUE.test(w)) i++;
    }
    return words.slice(i).join(' ');
  }
  if (/^(.*\/)?(bash|sh|zsh|dash|ksh)$/.test(argv0)) {
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (w === '-c' || /^-[a-zA-Z].*c$/s.test(w) || /^-c[a-zA-Z]/.test(w)) return words[i + 1] ?? '';
      if (!w.startsWith('-')) return '';
    }
    return '';
  }
  if (argv0 === 'eval') return stmt.slice(4).replace(/^ /, '');
  const builtin = /^(builtin|command)[ \t]+eval(?:[ \t]+|$)/.exec(stmt);
  return builtin ? stmt.slice(builtin[0].length) : '';
}

/** `eval`, `builtin eval` or `command eval`: the words after `eval`, or undefined. */
function evalArgs(words: readonly string[]): readonly string[] | undefined {
  if (words[0] === 'eval') return words.slice(1);
  if ((words[0] === 'builtin' || words[0] === 'command') && words[1] === 'eval') return words.slice(2);
  return undefined;
}

const SET_IN_TEXT = /(?<![A-Za-z0-9_$-])([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?[ \t]*(?:[-+*/%&^|]|<<|>>)?=(?!=)/g;
const STEPPED = /(?:\+\+|--)[ \t]*([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?:\+\+|--)/g;

/** The names a text may set where the tracking cannot follow: `name=` / `name op=` / `name[…]=` anywhere, `++` / `--` beside a name in arithmetic. */
function setInText(text: string): string[] {
  const names = [...text.matchAll(SET_IN_TEXT)].map((m) => m[1]);
  if (/\(\(|\$\[|\[|^let\b/.test(text)) for (const m of text.matchAll(STEPPED)) names.push(m[1] ?? m[2]);
  return names;
}

interface StdinProgram {
  kind: Lang | 'sh' | '';
  /** TS only: one of the interpreter's own options prints information and exits (`--version`, `-h`, `sh -n`), so it runs no program. */
  info: boolean;
}

/**
 * _tmb_cmd_stdin_interp: the interpreter kind that reads its program from
 * stdin, '' for none, walking the interpreter's own options up to the first
 * `-`, `--`, `sh -s` or operand. The TS also rules out `node --test` /
 * `--run` / `--watch` and `python -m<module>` with the module attached.
 */
function stdinProgram(words: readonly string[]): StdinProgram {
  const argv0 = basename(words[0]);
  let kind: Lang | 'sh';
  if (/^(python|python3|python[23]\..*)$/s.test(argv0)) kind = 'py';
  else if (argv0 === 'node' || argv0 === 'nodejs') kind = 'node';
  else if (argv0 === 'perl') kind = 'perl';
  else if (argv0 === 'ruby') kind = 'ruby';
  else if (/^(sh|bash|zsh|dash|ksh)$/.test(argv0)) kind = 'sh';
  else return { kind: '', info: false };
  const none: StdinProgram = { kind: '', info: false };
  let info = false;
  let skip = false;
  for (let k = 1; k < words.length; k++) {
    const w = words[k];
    if (skip) {
      skip = false;
      continue;
    }
    if (w === '<<<') {
      skip = true;
      continue;
    }
    if (w.startsWith('<<')) continue;
    if (/^(<|>|>>|>\||&>|&>>|[0-9]<|[0-9]>|[0-9]>>)$/.test(w)) {
      skip = true;
      continue;
    }
    if (/^(<|>|&>|[0-9]<|[0-9]>)/.test(w)) continue;
    if (w === '-' || w === '--') return { kind, info };
    if (INFO[kind].test(w)) info = true;
    const kw = `${kind}:${w}`;
    if (w.startsWith('--')) {
      if (/^node:--(eval|print)(=.*)?$/s.test(kw)) return none;
      if (/^node:--(test|run|watch|watch-path)(=.*)?$/s.test(kw)) return none;
      if (/^node:--(require|import|loader|input-type)$/.test(kw)) skip = true;
      continue;
    }
    if (w.startsWith('-')) {
      if (/^(py:-.*c|py:-.*m$|node:-[ep]$|perl:-.*[eE]|ruby:-.*e|sh:-.*c)/s.test(kw)) return none;
      if (/^py:-[bBdEhiIOPqRsSuvVx]*m/.test(kw)) return none;
      if (/^sh:-.*s/s.test(kw)) return { kind, info };
      if (/^(py:-[WX]|node:-r|ruby:-[rI]|perl:-[IM]|sh:-[oO])$/.test(kw)) skip = true;
      continue;
    }
    return none;
  }
  return { kind, info };
}

const stdinInterp = (words: readonly string[]): Lang | 'sh' | '' => stdinProgram(words).kind;

class WritePaths {
  out = '';
  pwd = '';
  private rootc: string | undefined;

  constructor(
    private readonly parser: Parser,
    private readonly opts: Options,
    private readonly charge: Charge,
  ) {}

  private print(line: string): void {
    this.charge(line.length);
    this.out += line;
  }

  private envVar(name: string, level: Level): string | null {
    const { env } = this.opts;
    let v = '';
    switch (name) {
      case 'PWD':
        v = this.pwd;
        break;
      case 'OLDPWD':
        v = dirPath(level.oldtok || '-', this.opts.cwd);
        break;
      case 'HOME':
        v = env.HOME ?? '';
        break;
      case 'TMPDIR':
        v = env.TMPDIR ?? '';
        break;
      case 'CLAUDE_PROJECT_DIR':
        v = env.CLAUDE_PROJECT_DIR ?? '';
        break;
      case 'TMB_MODEL_CACHE_DIR':
        v = env.TMB_MODEL_CACHE_DIR || env.HF_HOME || '';
        if (v === '' && env.HOME) v = `${env.HOME}/.cache/huggingface`;
        break;
    }
    return v === '' ? null : chomp(v);
  }

  /** _tmb_cmd_var_get: every recorded value of <name>, each once, or null when never assigned. */
  private varGet(vars: string, name: string): string | null {
    const values = new Set<string>();
    for (const line of vars.split('\n')) if (line.startsWith(name + '\t')) values.add(after(line, '\t'));
    return values.size > 0 ? chomp([...values].join('\n') + '\n') : null;
  }

  /** _tmb_cmd_expand: every value a word expands to (at most 16), or the variable that stops it (any one in an unbalanced level). */
  expand(word: string, level: Level): Expansion {
    let rest = word;
    let acc = [''];
    const fail = (unres: string): Expansion => ({ ok: false, unres });
    for (;;) {
      const at = rest.search(/[$`]/);
      if (at < 0) {
        acc = acc.map((a) => a + rest);
        break;
      }
      const lit = rest.slice(0, at);
      rest = rest.slice(at);
      acc = acc.map((a) => a + lit);
      let name: string;
      let def: string | null = null;
      let cut = '';
      if (rest.startsWith('$(proc)')) return fail('$(proc)');
      if (rest.startsWith('$(alias-write)')) return fail('$(alias-write)');
      if (rest.startsWith('`') || rest.startsWith('$(')) return fail('$()');
      if (rest.startsWith('${')) {
        let a = rest.slice(2);
        if (!a.includes('}')) return fail(rest);
        rest = after(a, '}');
        a = before(a, '}');
        name = /^[A-Za-z0-9_]*/.exec(a)![0];
        const op = a.slice(name.length);
        if (name === '' || /^[0-9]/.test(name)) return fail('${' + a + '}');
        if (op === '') {
          // plain ${NAME}
        } else if (op.startsWith(':-') || op.startsWith(':=')) def = op.slice(2);
        else if (op.startsWith('-') || op.startsWith('=')) def = op.slice(1);
        else if (op.startsWith('%')) {
          cut = op.slice(1).replace(/^%/, '');
          if (cut === '' || /[^A-Za-z0-9._-]/.test(cut)) return fail(name);
        } else return fail(name);
      } else if (/^\$[A-Za-z_]/.test(rest)) {
        const a = rest.slice(1);
        name = /^[A-Za-z0-9_]*/.exec(a)![0];
        rest = a.slice(name.length);
      } else if (/^\$[0-9@*#?$!-]/.test(rest)) return fail(rest.slice(0, 2));
      else {
        acc = acc.map((a) => a + '$');
        rest = rest.slice(1);
        continue;
      }
      if (this.unbalanced) return fail(name);
      let vals = this.varGet(level.vars, name);
      if (vals !== null) {
        if (vals.includes(BAD)) return fail(name);
      } else if (def !== null) {
        if (/[$`]/.test(def)) return fail(name);
        vals = def;
      } else {
        vals = this.envVar(name, level);
        if (vals === null) return fail(name);
      }
      const next: string[] = [];
      for (const a of acc) {
        for (const v of vals.split('\n')) next.push(a + (cut !== '' && v.endsWith(cut) ? v.slice(0, -cut.length) : v));
      }
      if (next.length > 16) return fail(name);
      acc = next;
    }
    return { ok: true, values: acc };
  }

  private poison(level: Level, name: string): void {
    if (VAR_NAME.test(name)) level.vars += `${name}\t${BAD}\n`;
  }

  private varSet(level: Level, name: string, value: string): void {
    for (const set of setInText(value)) this.poison(level, set);
    if (!VAR_NAME.test(name)) {
      this.poison(level, /^[A-Za-z_][A-Za-z0-9_]*/.exec(name)?.[0] ?? '');
      return;
    }
    const e = this.expand(value, level);
    if (e.ok) for (const v of e.values) level.vars += `${name}\t${v}\n`;
    else level.vars += `${name}\t${BAD}\n`;
  }

  /** _tmb_cmd_join: <p> joined to its statement's dir and normalized, newline-terminated. */
  private join(dir: string, p: string): string {
    const { cwd, raw, env } = this.opts;
    if (/[$`]/.test(p)) return p + '\n';
    if (p === '~' || p.startsWith('~/')) {
      if (!env.HOME) return p + '\n';
      p = env.HOME + p.slice(1);
    }
    let base = '';
    if (!p.startsWith('/')) {
      if (dir === '-') return p === '.' ? 'UNRESOLVED:PWD:$PWD\n' : `UNRESOLVED:PWD:$PWD/${p}\n`;
      if (dir === '@') base = cwd;
      else if (dir.startsWith('@/')) base = (cwd === '' ? '' : `${cwd.replace(/\/$/, '')}/`) + dir.slice(2);
      else base = dir;
    }
    if (raw) {
      if (p === '.' && base !== '') return base + '\n';
      return (base === '' ? '' : `${base.replace(/\/$/, '')}/`) + p + '\n';
    }
    return ((base === '' ? '' : base + '/') + p).split('\n').map(normalize).join('\n') + '\n';
  }

  /** _tmb_cmd_emit */
  private emit(level: Level, dir: string, p: string, why = level.why): void {
    if (p.startsWith(COMPUTED)) {
      this.print(computedLine(p.slice(COMPUTED.length)));
      return;
    }
    if (p.startsWith(PARSE)) {
      this.print(parseLine(p.slice(PARSE.length)));
      return;
    }
    if (p.startsWith(UNPROVEN)) {
      this.print(unprovenLine(p.slice(UNPROVEN.length)));
      return;
    }
    if (dir === '-' && why !== '' && !/^[/~$`]/.test(p)) {
      let v = dec(after(why, WSEP));
      if (p !== '.') v = `${v.replace(/\/$/, '')}/${p}`;
      this.emit(level, before(why, WSEP), v, '');
      return;
    }
    if (!/[$`]/.test(p)) {
      this.print(this.join(dir, p));
      return;
    }
    this.pwd = dirPath(dir, this.opts.cwd);
    const e = this.expand(p, level);
    if (e.ok) {
      for (const v of e.values) this.print(this.join(dir, v));
      return;
    }
    if (!/^[/~$`]/.test(p)) {
      if (dir === '-') p = '$PWD/' + p;
      else {
        const base = chomp(this.join(dir, '.'));
        if (base !== '.') p = `${base.replace(/\/$/, '')}/${p}`;
      }
    }
    this.print(`UNRESOLVED:${e.unres}:${p}\n`);
  }

  private listerHost(level: Level): ListerHost {
    const { cwd, root, env } = this.opts;
    return {
      cwd,
      root,
      home: env.HOME ?? '',
      rootc: () => (this.rootc ??= pathCanonical(root)),
      expand: (word) => {
        const e = this.expand(word, level);
        return e.ok ? e.values : null;
      },
    };
  }

  private bind(level: Level, name: string, values: string[] | null): boolean {
    if (values === null) return false;
    for (const v of values) level.vars += `${name}\t${v}\n`;
    return true;
  }

  /** _tmb_cmd_loop_source: the variable bound from the lister of a source mark (\022<dir>\022<word>…). */
  private loopSource(level: Level, name: string, mark: string): boolean {
    let m = mark.replace(/^\x12/, '');
    const dirtok = before(m, SEP);
    m = dec(m.slice(dirtok.length).replace(/^\x12/, ''));
    const fields = before(m, '\n').split(SEP);
    if (fields[fields.length - 1] === '') fields.pop();
    if (fields.length === 0) return false;
    return this.bind(level, name, listerBind(this.listerHost(level), name, dirtok, 'loop', fields, []));
  }

  /** _tmb_cmd_exec_writes: what a find / fd / xargs statement writes through the command it runs. */
  private execWrites(outer: Level, dir: string, mark: string, words: readonly string[], tok: string, depth: number): void {
    const level: Level = { ...outer };
    const tool = basename(words[0]);
    const acts: string[] = [];
    let name: string;
    if (tool === 'find') name = 'find_path';
    else if (tool === 'fd' || tool === 'fdfind') name = 'fd_path';
    else if (tool === 'xargs') {
      name = 'xargs_arg';
      const n = words.length;
      let k = 1;
      let rep = '';
      let noin = false;
      while (k < n) {
        const p = words[k];
        if (p === '--') {
          k++;
          break;
        }
        if (p === '-I' || p === '-J') {
          rep = words[k + 1] ?? '';
          k += 2;
          continue;
        }
        k++;
        if (p.startsWith('-I') || p.startsWith('-J')) rep = p.slice(2);
        else if (p === '-i' || p === '--replace') rep = '{}';
        else if (p.startsWith('-i')) rep = p.slice(2);
        else if (p.startsWith('--replace=')) rep = p.slice(10);
        else if (p === '-a' || p === '--arg-file') {
          noin = true;
          k++;
        } else if (p.startsWith('-a') || p.startsWith('--arg-file=')) noin = true;
        else if (XARGS_VALUE.test(p)) k++;
        else if (!p.startsWith('-')) {
          k--;
          break;
        }
      }
      if (k >= n) return;
      const rv = '${' + name + '}';
      let cmd = words.slice(k).join(' ');
      cmd = rep !== '' ? cmd.split(rep).join(rv) : `${cmd} ${rv}`;
      acts.push('x' + cmd);
      if (noin || mark === '' || !this.loopSource(level, name, mark)) level.vars += `${name}\t${BAD}\n`;
    } else return;
    if (tool !== 'xargs' && !this.bind(level, name, listerBind(this.listerHost(level), name, dir, 'exec', words, acts))) {
      level.vars += `${name}\t${BAD}\n`;
    }
    const rv = '${' + name + '}';
    for (const act of acts) {
      if (act === 'd') this.emit(level, dir, rv);
      else if (act.startsWith('f')) this.emit(level, dir, dec(act.slice(1)));
      else if (act.startsWith('x')) {
        let cmd = act.slice(1);
        if (tool === 'find') cmd = cmd.split('{}').join(rv);
        else if (tool !== 'xargs') {
          for (const ph of ['{//}', '{.}', '{}']) cmd = cmd.split(ph).join(rv);
          for (const ph of ['{/.}', '{/}']) cmd = cmd.split(ph).join('*');
        }
        for (const p of stmtWritePaths(cmd, true, this.interp).paths) if (p !== '') this.emit(level, dir, dec(p));
        this.execShell(level, cmd, tok, depth);
      }
    }
  }

  /**
   * TS only: the body of a shell that find / fd / xargs run (`-exec sh -c
   * '…"$0"…' {} \;`, `xargs -I % sh -c 'echo > %'`), judged as a command with
   * the placeholder bound. A target left on a variable (a positional
   * parameter, `for f;`, the unbound placeholder) fails closed as $(computed).
   */
  private execShell(level: Level, cmd: string, tok: string, depth: number): void {
    const body = inner(unwrapStatement(cmd).words.join(' '));
    if (body === '') return;
    const text = dec(body);
    if (depth >= MAX_DEPTH) {
      this.print(computedLine(text));
      return;
    }
    const outer = this.out;
    this.out = '';
    this.run(text, tok, depth + 1, level.vars);
    const lines = this.out.split('\n');
    lines.pop();
    this.out = outer;
    let failed = false;
    for (const line of lines) {
      if (BODY_UNRESOLVED.test(line)) failed = true;
      else this.print(line + '\n');
    }
    if (failed) this.print(computedLine(text));
  }

  /**
   * _tmb_cmd_proc_writes: what a program's process call writes, relative paths
   * under `$(proc)/`. A nested `$(parse)` or `$(computed)` line keeps its
   * reason (TS-only): the .sh strips it to its text, which is then judged as a path.
   */
  private procWrites(cmd: string): string {
    const out: string[] = [];
    for (const record of this.listing(cmd, '@', 0)) {
      if (record.dir.startsWith('=')) continue;
      const { words } = unwrapStatement(record.stmt);
      if (words.length === 0) continue;
      if (/[$`]/.test(dec(words[0]))) {
        out.push('$(proc)');
        continue;
      }
      if (!cmd.includes('<<') && stdinInterp(words) !== '') out.push('$(proc)');
    }
    const nested = new WritePaths(this.parser, { cwd: PROG_DIR, raw: true, root: '', env: this.opts.env }, this.charge);
    nested.run(cmd, '@', 0, '');
    const lines = nested.out.split('\n');
    lines.pop();
    for (let p of lines) {
      if (p.startsWith(`UNRESOLVED:${COMPUTED}`) || p.startsWith(`UNRESOLVED:${PARSE}`) || p.startsWith(`UNRESOLVED:${UNPROVEN}`)) {
        out.push(p.slice('UNRESOLVED:'.length));
        continue;
      }
      if (p.startsWith('UNRESOLVED:PWD:')) p = '$(proc)';
      else if (p.startsWith('UNRESOLVED:') && p.indexOf(':', 11) >= 0) p = p.slice(p.indexOf(':', 11) + 1);
      if (p === '') continue;
      if (p === PROG_DIR) p = '.';
      else if (p.startsWith(PROG_DIR + '/')) p = p.slice(PROG_DIR.length + 1);
      else if (!/^[/~$]/.test(p)) p = '$(proc)/' + p;
      out.push(p);
    }
    return out.join('\n');
  }

  /** _tmb_cmd_statements_enc to depth 3: bash -c / eval bodies listed as their own statements. */
  private listing(cmd: string, base: string, depth: number): Statement[] {
    this.charge(cmd.length);
    const encoded = encode(this.parser, cmd, this.charge);
    if (!encoded.ok) return [];
    const out: Statement[] = [];
    for (const record of statementsEnc(encoded.text, base, this.opts.env.HOME ?? '', true, this.charge)) {
      if (/^\t*$/.test(record.stmt)) continue;
      const body = depth < MAX_DEPTH && !record.dir.startsWith('=') ? inner(record.stmt) : '';
      if (body !== '') out.push(...this.listing(dec(body), record.dir, depth + 1));
      else out.push(record);
    }
    return out;
  }

  /** The `heldKey` of every word of the command `run` is in whose text the shell fills in part of. */
  private held = new Set<string>();

  /** _TMB_CMD_UNBAL: the level running, or one it runs within, has loop frames that do not balance. */
  private unbalanced = false;

  private isHeld(word: string): boolean {
    return this.held.has(heldKey(word));
  }

  private readonly interp: Interp = (words) =>
    interpWrites(
      words,
      (cmd) => this.procWrites(cmd),
      (w) => this.isHeld(w),
    );

  /**
   * _tmb_cmd_track_vars. The TS poisons the names a declare-like builtin sets
   * with an option other than -x / -r / -g / -t (`declare -n`, `-a`, `-i`,
   * ...), and those mapfile / readarray, getopts and unset set (GH 1739).
   */
  private trackVars(level: Level, words: readonly string[]): void {
    switch (basename(words[0])) {
      case 'export':
      case 'declare':
      case 'typeset':
      case 'local':
      case 'readonly': {
        const plain = words.slice(1).every((w) => !/^[-+]/.test(w) || /^[-+][xrgt]+$/.test(w));
        for (const w of words.slice(1)) {
          if (!/^[A-Za-z_].*=/s.test(w)) continue;
          if (plain) this.varSet(level, before(w, '='), dec(after(w, '=')));
          else this.poison(level, before(w, '='));
        }
        if (!plain) for (const w of words.slice(1)) this.poison(level, w);
        return;
      }
      case 'mapfile':
      case 'readarray':
        for (const w of [...words.slice(1), 'MAPFILE']) this.poison(level, w);
        return;
      case 'unset':
        for (const w of words.slice(1)) this.poison(level, w);
        return;
      case 'getopts':
        this.poison(level, words[2] ?? '');
        return;
      case 'for': {
        if (words[2] !== 'in') {
          level.vars += `${words[1] ?? ''}\t${BAD}\n`;
          return;
        }
        const name = words[1] ?? '';
        const rest = words.slice(3);
        if (rest.length === 1 && rest[0].startsWith('$\x0f\x10\x12')) {
          if (!this.loopSource(level, name, rest[0].slice(3))) level.vars += `${name}\t${BAD}\n`;
          return;
        }
        for (const w of rest) this.varSet(level, name, dec(w));
        return;
      }
      case 'read': {
        let mk = '';
        let skip = false;
        const names: string[] = [];
        for (const w of words.slice(1)) {
          if (skip) {
            skip = false;
            continue;
          }
          if (w.startsWith(SEP)) mk = w;
          else if (w === '-d') skip = true;
          else if (w === '-r' || w === '-e') continue;
          else if (w.startsWith('-')) mk = '!';
          else if (/^[A-Za-z_]/.test(w)) names.push(w);
        }
        if (names.length === 1 && mk !== '' && mk !== '!' && this.loopSource(level, names[0], mk)) return;
        for (const w of names) level.vars += `${w}\t${BAD}\n`;
        return;
      }
      case 'printf':
        if (words[1] === '-v') level.vars += `${words[2] ?? ''}\t${BAD}\n`;
        return;
    }
  }

  /** _tmb_cmd_write_paths_in */
  run(cmd: string, base: string, depth: number, vars: string): void {
    this.charge(cmd.length);
    const encoded = encode(this.parser, cmd, this.charge);
    if (!encoded.ok) {
      this.print(parseLine(cmd));
      return;
    }
    const outer = this.held;
    const unbalanced = this.unbalanced;
    this.held = encoded.held;
    try {
      this.runEncoded(encoded.text, encoded.heredocs, base, depth, vars);
    } finally {
      this.held = outer;
      this.unbalanced = unbalanced;
    }
  }

  /** The names a statement's words may set beyond what `trackVars` follows; a declare-like builtin's own `name=` words are its to judge. */
  private poisonSet(level: Level, words: readonly string[]): void {
    const declares = /^(export|declare|typeset|local|readonly)$/.test(basename(words[0]));
    for (const w of words) {
      if (declares && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
      for (const name of setInText(dec(w))) this.poison(level, name);
    }
  }

  /**
   * _tmb_cmd_loop_vars: at a loop's `{`, adds to the level every value its
   * records (`loop`, the first at 1-based index `from + 1`) assign, nested
   * loops included, pass after pass until one adds none, so a use that
   * precedes an in-body assignment also sees what a later pass assigns
   * (GH 1944). A name still gaining values after 8 passes is poisoned.
   */
  private loopVars(level: Level, loop: readonly Statement[], from: number, bodies: Map<number, Heredoc[]>, depth: number): void {
    const { cwd } = this.opts;
    const saved = { pwd: this.pwd, oldtok: level.oldtok, why: level.why };
    level.vars = varsUniq(level.vars);
    const seed = new Set(level.vars.split('\n'));
    let converged = false;
    for (let pass = 0; pass < 8 && !converged; pass++) {
      const prev = level.vars;
      this.charge(prev.length + loop.length);
      loop.forEach((record, k) => {
        this.charge(level.vars.length);
        if (record.dir === LOOP_OPEN || record.dir === LOOP_CLOSE || record.dir === UNBALANCED) return;
        let dir = record.dir;
        let old = dir.includes(SEP) ? after(dir, SEP) : '-';
        dir = before(dir, SEP);
        let why = '';
        if (old.includes(SEP)) {
          why = after(old, SEP);
          old = before(old, SEP);
        }
        level.oldtok = old;
        level.why = why;
        const words = shellWords(record.stmt);
        if (words.length === 0) return;
        if (dir.startsWith('=')) {
          this.eachDir(level, dir.slice(1).split(ALT), why, (d) => {
            this.pwd = dirPath(d, cwd);
            for (const w of words) this.varSet(level, before(w, '='), dec(after(w, '=')));
          });
          return;
        }
        this.poisonSet(level, words);
        for (const h of bodies.get(from + k + 1) ?? []) if (h.expands) for (const name of setInText(h.body)) this.poison(level, name);
        const body = inner(record.stmt);
        if (body !== '' && ((!evalArgs(words) && heldProgram(body)) || depth < MAX_DEPTH)) return;
        this.eachDir(level, dir.split(ALT), why, (d) => {
          this.pwd = dirPath(d, cwd);
          this.trackVars(level, words);
        });
      });
      level.vars = varsUniq(level.vars);
      converged = level.vars === prev;
    }
    if (!converged) for (const line of level.vars.split('\n')) if (line !== '' && !seed.has(line)) this.poison(level, before(line, '\t'));
    this.pwd = saved.pwd;
    level.oldtok = saved.oldtok;
    level.why = saved.why;
  }

  /**
   * Runs `fn` for each dir a statement may run in (a loop's back-edge can
   * list more than one, GH 1977), with its why on the first only; each run
   * starts from the variables the statement found and keeps what it adds.
   */
  private eachDir(level: Level, dirs: readonly string[], why: string, fn: (dir: string) => void): void {
    const vars = level.vars;
    let added = '';
    dirs.forEach((d, n) => {
      level.vars = vars;
      level.why = n === 0 ? why : '';
      fn(d);
      added += level.vars.slice(vars.length);
    });
    level.vars = vars + added;
    level.why = why;
  }

  private runEncoded(text: string, heredocs: readonly Heredoc[], base: string, depth: number, vars: string): void {
    const level: Level = { vars, oldtok: '-', why: '' };
    const { cwd } = this.opts;
    const records = statementsEnc(text, base, this.opts.env.HOME ?? '', true, this.charge).filter((r) => !/^\t*$/.test(r.stmt));
    const bodies = heredocAlign(heredocs, records);
    if (records.some((r) => r.dir === UNBALANCED)) this.unbalanced = true;
    let idx = 0;
    for (const record of records) {
      idx++;
      this.charge(level.vars.length);
      if (record.dir === LOOP_OPEN) {
        this.loopVars(level, loopBody(records, idx), idx, bodies, depth);
        continue;
      }
      if (record.dir === LOOP_CLOSE || record.dir === UNBALANCED) continue;
      let dir = record.dir;
      let old = dir.includes(SEP) ? after(dir, SEP) : '-';
      dir = before(dir, SEP);
      let why = '';
      if (old.includes(SEP)) {
        why = after(old, SEP);
        old = before(old, SEP);
      }
      level.oldtok = old;
      level.why = why;
      let words = shellWords(record.stmt);
      if (words.length === 0) continue;
      if (dir.startsWith('=')) {
        this.eachDir(level, dir.slice(1).split(ALT), why, (d) => {
          this.pwd = dirPath(d, cwd);
          for (const w of words) this.varSet(level, before(w, '='), dec(after(w, '=')));
        });
        continue;
      }
      const tok = dir + SEP + old + (why === '' ? '' : SEP + why);
      const dirs = dir.split(ALT);
      const each = (fn: (d: string, chain: boolean, tok: string) => void): void =>
        this.eachDir(level, dirs, why, (d) => fn(d, d === '-' && level.why === '', d + SEP + old + (level.why === '' ? '' : SEP + level.why)));
      const body = inner(record.stmt);
      const evaluated = evalArgs(words);
      this.poisonSet(level, words);
      for (const h of bodies.get(idx) ?? []) if (h.expands) for (const name of setInText(h.body)) this.poison(level, name);
      const argv0 = unwrapStatement(record.stmt).words[0] ?? '';
      if (/[$`\x07]/.test(decode(argv0))) this.print(unprovenLine(dec(record.stmt)));
      if (evaluated?.some((w) => this.isHeld(w))) this.print(unprovenLine(dec(record.stmt)));
      else if (body !== '' && !evaluated && this.isHeld(body)) this.print(unprovenLine(`${basename(dec(words[0]))} ${dec(body)}`));
      const ownWords = body !== '' && !evaluated && basename(words[0]) !== 'watch';
      if (ownWords) {
        each((d, chain) => {
          for (const p of stmtWritePaths(record.stmt, chain, this.interp).paths) if (p !== '') this.emit(level, d, dec(p));
        });
      }
      if (body !== '' && !evaluated && heldProgram(body)) {
        this.print(computedLine(`${basename(dec(words[0]))} ${dec(body)}`));
        continue;
      }
      if (body !== '' && depth < MAX_DEPTH) {
        this.run(dec(body), tok, depth + 1, level.vars);
        continue;
      }
      if (body !== '') this.print(computedLine(dec(body)));
      let stmt = record.stmt;
      let mark = '';
      if (basename(words[0]) === 'xargs' && words[words.length - 1].startsWith(SEP)) {
        mark = words[words.length - 1];
        words = words.slice(0, -1);
        stmt = words.join(' ');
      }
      if (!ownWords) {
        each((d, chain) => {
          for (const p of stmtWritePaths(stmt, chain, this.interp).paths) if (p !== '') this.emit(level, d, dec(p));
        });
      }
      if (/^(find|fd|fdfind|xargs)$/.test(basename(words[0]))) each((d, _, t) => this.execWrites(level, d, mark, words, t, depth));
      const { kind, info } = stdinProgram(words);
      if (kind !== '') {
        const progs: { prog: string; held: boolean; partly: boolean }[] = [];
        const herestring = (w: string): void => {
          progs.push({ prog: dec(w), held: heldProgram(w), partly: this.isHeld(w) });
        };
        for (let w = 0; w < words.length; w++) {
          if (words[w] === '<<<') herestring(words[w + 1] ?? '');
          else if (words[w].startsWith('<<<')) herestring(words[w].slice(3));
        }
        for (const h of bodies.get(idx) ?? []) progs.push({ prog: h.body, held: heldProgram(h.body), partly: h.expands });
        if (progs.length === 0 && !info) this.print(computedLine(basename(dec(words[0]))));
        const shownArgv0 = basename(dec(words[0]));
        for (const { prog, held, partly } of progs) {
          if (held) this.print(computedLine(`${shownArgv0} ${prog}`));
          else if (kind === 'sh') {
            if (partly) this.print(unprovenLine(`${shownArgv0} ${prog}`));
            if (depth < MAX_DEPTH) this.run(prog, tok, depth + 1, level.vars);
            else this.print(computedLine(prog));
          } else {
            const found = progWrites(kind, prog, false, (c) => this.procWrites(c));
            each((d) => {
              for (const p of found.lines) if (p !== '') this.emit(level, d, p);
            });
            if (found.computed) this.print(computedLine(shownArgv0));
            if (partly || found.unproven) this.print(unprovenLine(`${shownArgv0} ${prog}`));
          }
        }
      }
      each((d) => {
        this.pwd = dirPath(d, cwd);
        this.trackVars(level, words);
      });
    }
  }
}

/** The records of the loop whose `{` is records[from - 1], up to its `}`, nested loops included. */
function loopBody(records: readonly Statement[], from: number): Statement[] {
  let depth = 0;
  let k = from;
  for (; k < records.length; k++) {
    if (records[k].dir === LOOP_OPEN) depth++;
    else if (records[k].dir === LOOP_CLOSE && depth-- === 0) break;
  }
  return records.slice(from, k);
}

/** Each line of `vars` once, in first-seen order. */
function varsUniq(vars: string): string {
  const lines = [...new Set(vars.split('\n').filter((l) => l !== ''))];
  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

/** _tmb_cmd_heredoc_align: each heredoc body under the 1-based index of the statement whose `<<WORD` names its delimiter, in order. */
function heredocAlign(heredocs: readonly Heredoc[], records: readonly Statement[]): Map<number, Heredoc[]> {
  const out = new Map<number, Heredoc[]>();
  if (heredocs.length === 0) return out;
  const used = new Set<number>();
  let p = -1;
  records.forEach((record, i) => {
    for (const m of record.stmt.matchAll(/<<+([^ \t;&|<>()]*)/g)) {
      if (m[0].length - m[1].length !== 2 || m[1] === '') continue;
      let j = p + 1;
      while (j < heredocs.length && (used.has(j) || heredocs[j].delim !== m[1])) j++;
      if (j >= heredocs.length) continue;
      used.add(j);
      p = j;
      out.set(i + 1, [...(out.get(i + 1) ?? []), heredocs[j]]);
    }
  });
  return out;
}

/** The lines tmb_cmd_write_paths prints for `command`, parsed with the given tree-sitter-bash parser. */
export function writePathsWith(parser: Parser, command: string, opts: Options): string[] {
  if (command.length > ANALYSIS_WORK_CAP) return [CAP_LINE];
  let spent = 0;
  const w = new WritePaths(parser, opts, (units) => {
    spent += units;
    if (spent > ANALYSIS_WORK_CAP) throw new WorkCapReached();
  });
  try {
    w.run(command, '@', 0, '');
  } catch (e) {
    if (e instanceof WorkCapReached || e instanceof RangeError) return [CAP_LINE];
    throw e;
  }
  const lines = w.out.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
