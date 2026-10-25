/**
 * tmb_cmd_write_paths (cmd-analysis.sh) on tree-sitter-bash: every path a
 * command writes, resolved against its statement's dir, with the variables it
 * assigns tracked, bash -c / eval bodies and sh programs fed on stdin judged
 * as commands of their own, interpreter one-liners and stdin programs judged
 * by their write calls, what find / fd / xargs run judged with its
 * placeholder bound, and loop variables bound to the paths their lister may
 * list.
 */
import type { Parser } from 'web-tree-sitter';
import { type Heredoc, decode, encode } from './encode.js';
import { type ListerHost, listerBind } from './lister.js';
import { pathCanonical } from './path.js';
import type { Lang } from './prog-calls.js';
import { interpWrites, progWrites } from './programs.js';
import { type Record as Statement, SEP, WSEP, statementsEnc } from './statements.js';
import { type Interp, stmtWritePaths, unwrapStatement } from './targets.js';

const BAD = '\x01';
const MAX_DEPTH = 3;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROG_DIR = '/.tmb-prog-dir';
const XARGS_VALUE = /^(-d|-E|-L|-n|-P|-s|-R|-S|--delimiter|--max-lines|--max-args|--max-procs|--max-chars)$/;

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

/** _tmb_cmd_inner: the -c string of a shell or the rest of an eval. */
function inner(stmt: string): string {
  const words = shellWords(stmt);
  const argv0 = words[0] ?? '';
  if (/^(.*\/)?(bash|sh|zsh|dash|ksh)$/.test(argv0)) {
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (w === '-c' || /^-[a-zA-Z].*c$/s.test(w) || /^-c[a-zA-Z]/.test(w)) return words[i + 1] ?? '';
      if (!w.startsWith('-')) return '';
    }
    return '';
  }
  if (argv0 === 'eval') return stmt.slice(4).replace(/^ /, '');
  return '';
}

/** _tmb_cmd_stdin_interp: the interpreter kind that reads its program from stdin, '' for none. */
function stdinInterp(words: readonly string[]): Lang | 'sh' | '' {
  const argv0 = basename(words[0]);
  let kind: Lang | 'sh';
  if (/^(python|python3|python[23]\..*)$/s.test(argv0)) kind = 'py';
  else if (argv0 === 'node' || argv0 === 'nodejs') kind = 'node';
  else if (argv0 === 'perl') kind = 'perl';
  else if (argv0 === 'ruby') kind = 'ruby';
  else if (/^(sh|bash|zsh|dash|ksh)$/.test(argv0)) kind = 'sh';
  else return '';
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
    if (w === '-' || w === '--') return kind;
    const kw = `${kind}:${w}`;
    if (w.startsWith('--')) {
      if (/^node:--(eval|print)(=.*)?$/s.test(kw)) return '';
      if (/^node:--(require|import|loader|input-type)$/.test(kw)) skip = true;
      continue;
    }
    if (w.startsWith('-')) {
      if (/^(py:-.*c|py:-.*m$|node:-[ep]$|perl:-.*[eE]|ruby:-.*e|sh:-.*c)/s.test(kw)) return '';
      if (/^sh:-.*s/s.test(kw)) return kind;
      if (/^(py:-[WX]|node:-r|ruby:-[rI]|perl:-[IM]|sh:-[oO])$/.test(kw)) skip = true;
      continue;
    }
    return '';
  }
  return kind;
}

class WritePaths {
  out = '';
  pwd = '';
  private rootc: string | undefined;

  constructor(
    private readonly parser: Parser,
    private readonly opts: Options,
  ) {}

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

  private varGet(vars: string, name: string): string | null {
    let found = false;
    let out = '';
    for (const line of vars.split('\n')) {
      if (!line.startsWith(name + '\t')) continue;
      out += after(line, '\t') + '\n';
      found = true;
    }
    return found ? chomp(out) : null;
  }

  /** _tmb_cmd_expand: every value a word expands to (at most 16), or the variable that stops it. */
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

  private varSet(level: Level, name: string, value: string): void {
    if (!VAR_NAME.test(name)) return;
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
    if (dir === '-' && why !== '' && !/^[/~$`]/.test(p)) {
      let v = dec(after(why, WSEP));
      if (p !== '.') v = `${v.replace(/\/$/, '')}/${p}`;
      this.emit(level, before(why, WSEP), v, '');
      return;
    }
    if (!/[$`]/.test(p)) {
      this.out += this.join(dir, p);
      return;
    }
    this.pwd = dirPath(dir, this.opts.cwd);
    const e = this.expand(p, level);
    if (e.ok) {
      for (const v of e.values) this.out += this.join(dir, v);
      return;
    }
    if (!/^[/~$`]/.test(p)) {
      if (dir === '-') p = '$PWD/' + p;
      else {
        const base = chomp(this.join(dir, '.'));
        if (base !== '.') p = `${base.replace(/\/$/, '')}/${p}`;
      }
    }
    this.out += `UNRESOLVED:${e.unres}:${p}\n`;
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
  private execWrites(outer: Level, dir: string, mark: string, words: readonly string[]): void {
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
      }
    }
  }

  /** _tmb_cmd_proc_writes: what a program's process call writes, relative paths under `$(proc)/`. */
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
    const nested = new WritePaths(this.parser, { cwd: PROG_DIR, raw: true, root: '', env: this.opts.env });
    nested.run(cmd, '@', 0, '');
    const lines = nested.out.split('\n');
    lines.pop();
    for (let p of lines) {
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
    const encoded = encode(this.parser, cmd);
    if (!encoded.ok) return [];
    const out: Statement[] = [];
    for (const record of statementsEnc(encoded.text, base, this.opts.env.HOME ?? '', true)) {
      if (/^\t*$/.test(record.stmt)) continue;
      const body = depth < MAX_DEPTH && !record.dir.startsWith('=') ? inner(record.stmt) : '';
      if (body !== '') out.push(...this.listing(dec(body), record.dir, depth + 1));
      else out.push(record);
    }
    return out;
  }

  private readonly interp: Interp = (words) => interpWrites(words, (cmd) => this.procWrites(cmd));

  /** _tmb_cmd_track_vars */
  private trackVars(level: Level, words: readonly string[]): void {
    switch (basename(words[0])) {
      case 'export':
      case 'declare':
      case 'typeset':
      case 'local':
      case 'readonly':
        for (const w of words.slice(1)) {
          if (/^[A-Za-z_].*=/s.test(w)) this.varSet(level, before(w, '='), dec(after(w, '=')));
        }
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
    const encoded = encode(this.parser, cmd);
    if (!encoded.ok) {
      this.out += `UNRESOLVED:$(parse):${[...cmd].slice(0, 80).join('').replace(/[\r\n]/g, ' ')}\n`;
      return;
    }
    const level: Level = { vars, oldtok: '-', why: '' };
    const { cwd } = this.opts;
    const records = statementsEnc(encoded.text, base, this.opts.env.HOME ?? '', true).filter((r) => !/^\t*$/.test(r.stmt));
    const bodies = heredocAlign(encoded.heredocs, records);
    let idx = 0;
    for (const record of records) {
      idx++;
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
        this.pwd = dirPath(dir.slice(1), cwd);
        for (const w of words) this.varSet(level, before(w, '='), dec(after(w, '=')));
        continue;
      }
      const tok = dir + SEP + old + (why === '' ? '' : SEP + why);
      if (depth < MAX_DEPTH) {
        const body = inner(record.stmt);
        if (body !== '') {
          this.run(dec(body), tok, depth + 1, level.vars);
          continue;
        }
      }
      let stmt = record.stmt;
      let mark = '';
      if (basename(words[0]) === 'xargs' && words[words.length - 1].startsWith(SEP)) {
        mark = words[words.length - 1];
        words = words.slice(0, -1);
        stmt = words.join(' ');
      }
      const chain = dir === '-' && why === '';
      for (const p of stmtWritePaths(stmt, chain, this.interp).paths) if (p !== '') this.emit(level, dir, dec(p));
      if (/^(find|fd|fdfind|xargs)$/.test(basename(words[0]))) this.execWrites(level, dir, mark, words);
      const kind = stdinInterp(words);
      if (kind !== '') {
        const progs: string[] = [];
        for (let w = 0; w < words.length; w++) {
          if (words[w] === '<<<') progs.push(dec(words[w + 1] ?? ''));
          else if (words[w].startsWith('<<<')) progs.push(dec(words[w].slice(3)));
        }
        progs.push(...(bodies.get(idx) ?? []));
        for (const prog of progs) {
          if (kind === 'sh') {
            if (depth < MAX_DEPTH) this.run(prog, tok, depth + 1, level.vars);
          } else {
            for (const p of progWrites(kind, prog, false, (c) => this.procWrites(c))) if (p !== '') this.emit(level, dir, p);
          }
        }
      }
      this.pwd = dirPath(dir, cwd);
      this.trackVars(level, words);
    }
  }
}

/** _tmb_cmd_heredoc_align: each heredoc body under the 1-based index of the statement whose `<<WORD` names its delimiter, in order. */
function heredocAlign(heredocs: readonly Heredoc[], records: readonly Statement[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
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
      out.set(i + 1, [...(out.get(i + 1) ?? []), heredocs[j].body]);
    }
  });
  return out;
}

/** The lines tmb_cmd_write_paths prints for `command`, parsed with the given tree-sitter-bash parser. */
export function writePathsWith(parser: Parser, command: string, opts: Options): string[] {
  const w = new WritePaths(parser, opts);
  w.run(command, '@', 0, '');
  const lines = w.out.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
