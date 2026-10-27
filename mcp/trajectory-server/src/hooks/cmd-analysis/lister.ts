/**
 * The path-listing model of cmd-analysis.sh: _tmb_cmd_lister_bind with
 * _tmb_cmd_pat_matches and _tmb_cmd_excl_covers, judging prompt surfaces with
 * surface.ts's isPromptSurfacePath. A loop variable fed by a lister, and the placeholder of what find / fd run,
 * is bound to the paths the lister may list when every one lies in the run
 * root.
 */
import { statSync } from 'node:fs';
import { decode } from './encode.js';
import { pathCanonical } from './path.js';
import { isPromptSurfacePath } from './surface.js';

export interface ListerHost {
  cwd: string;
  root: string;
  home: string;
  rootc(): string;
  /** _tmb_cmd_expand: every value of a word, null when a variable stops it. */
  expand(word: string): string[] | null;
}

export type ListerMode = 'loop' | 'exec';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SURFACES = ['agents', 'skills', 'commands', 'templates', 'rules', '.claude/agents', 'CLAUDE.md'];
const PROMPT_FILES = ['CLAUDE.md', 'CODEX.md', 'CURSOR.md', 'GEMINI.md'];
const EXEC_REDIRECT = /^(>|>>|>\||<|<<<|&>|&>>|[0-9]>|[0-9]>>|[0-9]<)$/;
const EXEC_REDIRECT_WORD = /^(>|<|&>|[0-9]>|[0-9]<)/;
const RG_VALUE = /^(-t|--type|-T|--type-not|--type-add|-j|--threads|-d|--max-depth|--max-filesize|--ignore-file|--sort|--sortr|-E|--encoding)$/;
const FD_VALUE =
  /^(-e|--extension|-t|--type|-d|--max-depth|--min-depth|--exact-depth|-S|--size|--changed-within|--changed-before|-o|--owner|-j|--threads|--max-results|-c|--color|--ignore-file|--and)$/;
const PLACEHOLDER = /\{\}|\{\/\}|\{\/\/\}|\{\.\}|\{\/\.\}/;

const basename = (w: string): string => w.replace(/.*\//, '');
const trimSlash = (s: string): string => s.replace(/\/$/, '');
const isDir = (p: string): boolean => statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
const isFile = (p: string): boolean => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;

const CLASSES: Readonly<Record<string, string>> = {
  alnum: 'A-Za-z0-9',
  alpha: 'A-Za-z',
  blank: ' \\t',
  cntrl: '\\x00-\\x1f\\x7f',
  digit: '0-9',
  graph: '\\x21-\\x7e',
  lower: 'a-z',
  print: '\\x20-\\x7e',
  punct: '!-\\/:-@\\[-`{-~',
  space: ' \\t\\n\\v\\f\\r',
  upper: 'A-Z',
  xdigit: '0-9A-Fa-f',
};

const escapeRe = (c: string): string => c.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');

/** The bracket expression starting at `pat[i]` ('['), as a regex class and the index after it; null when unterminated. */
function bracket(pat: string, i: number): { re: string; next: number } | null {
  let k = i + 1;
  let neg = false;
  if (pat[k] === '!' || pat[k] === '^') {
    neg = true;
    k++;
  }
  let body = '';
  let first = true;
  while (k < pat.length) {
    const c = pat[k];
    if (c === ']' && !first) return { re: `[${neg ? '^' : ''}${body}]`, next: k + 1 };
    first = false;
    if (c === '[' && pat[k + 1] === ':') {
      const end = pat.indexOf(':]', k + 2);
      const cls = end < 0 ? undefined : CLASSES[pat.slice(k + 2, end)];
      if (cls !== undefined) {
        body += cls;
        k = end + 2;
        continue;
      }
    }
    if (c === '\\' && k + 1 < pat.length) {
      body += escapeRe(pat[k + 1]);
      k += 2;
      continue;
    }
    if (c === '-' && body !== '' && pat[k + 1] !== undefined && pat[k + 1] !== ']') {
      body += '-';
      k++;
      continue;
    }
    body += escapeRe(c);
    k++;
  }
  return null;
}

/** A bash case pattern (no extglob) as an anchored regex. */
function globRegex(pat: string, nocase: boolean): RegExp {
  let re = '';
  for (let i = 0; i < pat.length; ) {
    const c = pat[i];
    if (c === '*') {
      re += '.*';
      i++;
    } else if (c === '?') {
      re += '.';
      i++;
    } else if (c === '[') {
      const b = bracket(pat, i);
      if (b) {
        re += b.re;
        i = b.next;
      } else {
        re += '\\[';
        i++;
      }
    } else if (c === '\\' && i + 1 < pat.length) {
      re += escapeRe(pat[i + 1]);
      i += 2;
    } else {
      re += escapeRe(c);
      i++;
    }
  }
  try {
    return new RegExp(`^${re}$`, nocase ? 'is' : 's');
  } catch {
    return /(?!)/;
  }
}

/** _tmb_cmd_pat_matches: `s:` a glob, `i:` a glob compared case-insensitively, `r:` a regex (assumed to match). */
export function patMatches(pat: string, name: string): boolean {
  if (pat.startsWith('r:')) return true;
  return globRegex(pat.slice(2), pat.startsWith('i:')).test(name);
}

/** _tmb_cmd_excl_covers: whether an exclusion leaves out the whole prompt-surface subtree `d`. */
function exclCovers(pat: string, d: string, sub: string, v: string, root: string, rootc: string): boolean {
  const e = pat.slice(2);
  const l = trimSlash(v);
  const b = basename(d);
  let r: string;
  switch (pat.slice(0, 2)) {
    case 'N:':
      return d === 'CLAUDE.md' && e === 'CLAUDE.md';
    case 'P:':
      if (e.endsWith('/**')) r = e.slice(0, -3);
      else if (e.endsWith('/*')) r = e.slice(0, -2);
      else {
        if (d !== 'CLAUDE.md') return false;
        r = e;
      }
      break;
    case 'R:':
      r = e;
      break;
    case 'G:':
      r = trimSlash(e).replace(/\/\*\*$/, '').replace(/\/\*$/, '');
      return r === d;
    case 'F:':
    case 'Q:':
      r = trimSlash(e).replace(/\/\*\*$/, '');
      return r === d || r === `**/${b}` || (r === b && !r.includes('/'));
    default:
      return false;
  }
  return (
    r === `*/${b}` ||
    r === `**/${b}` ||
    r === `${l}/${sub}` ||
    r === `./${sub}` ||
    r === `${trimSlash(root)}/${d}` ||
    r === `${trimSlash(rootc)}/${d}`
  );
}

interface Model {
  paths: string[];
  vals: string[];
  pats: string[];
  excl: string[];
  gdir: string;
  listed: boolean;
}

function findModel(mode: ListerMode, args: string[], raw: string[], acts: string[], m: Model): boolean {
  const n = args.length;
  let k = 0;
  let bad = false;
  let ok = false;
  const prune: string[] = [];
  while (k < n) {
    const a = args[k];
    if (a === '-L') {
      bad = true;
      k++;
    } else if (a === '-H' || a === '-P' || a.startsWith('-O')) k++;
    else if (a === '-D') k += 2;
    else if (a === '--') {
      k++;
      break;
    } else break;
  }
  while (k < n && !/^(-.*|\(|!|,)$/s.test(args[k])) m.paths.push(args[k++]);
  while (k < n) {
    const w = args[k++];
    switch (w) {
      case '-exec':
      case '-execdir':
      case '-ok':
      case '-okdir': {
        if (mode !== 'exec') return false;
        const run: string[] = [];
        let prev = '';
        while (k < n) {
          const x = raw[k++];
          if (x === '\x06' || (x === '+' && prev === '{}')) break;
          run.push(x);
          prev = x;
        }
        if (run.length > 0) acts.push('x' + run.join(' '));
        break;
      }
      case '-delete':
        if (mode !== 'loop') acts.push('d');
        break;
      case '-fprint':
      case '-fprint0':
      case '-fprintf':
      case '-fls':
        if (mode !== 'exec') return false;
        acts.push('f' + (raw[k] ?? ''));
        k += w === '-fprintf' ? 2 : 1;
        break;
      case '-printf':
        if (mode !== 'exec') return false;
        k++;
        break;
      case '-ls':
        if (mode !== 'exec') return false;
        break;
      case '-follow':
        bad = true;
        break;
      case '-name':
        m.pats.push('s:' + (args[k++] ?? ''));
        break;
      case '-iname':
        m.pats.push('i:' + (args[k++] ?? ''));
        break;
      case '-regex':
      case '-iregex':
        m.pats.push('r:' + (args[k++] ?? ''));
        break;
      case '-not':
      case '!': {
        const a = args[k] ?? '';
        if (a === '-path' || a === '-wholename') {
          m.excl.push('P:' + (args[k + 1] ?? ''));
          k += 2;
        } else if (a === '-name') {
          m.excl.push('N:' + (args[k + 1] ?? ''));
          k += 2;
        }
        break;
      }
      case '-path':
      case '-wholename':
      case '-ipath':
        if (args[k + 1] === '-prune') prune.push('R:' + (args[k] ?? ''));
        k++;
        break;
      case '-o':
      case '-or':
        ok = true;
        break;
    }
  }
  if (ok) {
    m.excl = [];
    if (mode !== 'loop') m.pats = [];
  }
  m.excl.push(...prune);
  if (m.paths.length === 0) m.paths = ['.'];
  return !bad;
}

function lsModel(args: string[], m: Model): boolean {
  for (const w of args) {
    if (w === '--') continue;
    if (w.startsWith('--')) return false;
    if (w.startsWith('-')) {
      if (/[^1AaBCdFfhimpRrSstuUvXx]/.test(w.slice(1))) return false;
    } else m.paths.push(w);
  }
  if (m.paths.length === 0) m.paths = ['.'];
  m.listed = true;
  return true;
}

function gitModel(dir: string, args: string[], m: Model): boolean {
  const n = args.length;
  let k = 0;
  let gdir = dir;
  while (k < n) {
    const a = args[k];
    if (a === '-C') {
      const p = args[k + 1] ?? '';
      if (p.startsWith('/')) gdir = p;
      else if (p === '') return false;
      else gdir = `${trimSlash(gdir)}/${p}`;
      k += 2;
    } else if (a === '-c') k += 2;
    else if (a.startsWith('-')) k++;
    else break;
  }
  const sub = args[k++] ?? '';
  if (sub !== 'ls-files' && sub !== 'diff') return false;
  let ok = false;
  for (const w of args.slice(k)) {
    if (w === '--name-only') ok = true;
    else if (/^(--format|--full-name$|--output|--src-prefix|--dst-prefix)/.test(w)) return false;
    else if (w.startsWith('-')) continue;
    else if (w.startsWith(':!') || w.startsWith(':^')) m.excl.push('G:' + w.slice(2));
    else if (w.startsWith(':(exclude)')) m.excl.push('G:' + w.slice(10));
    else if (w.startsWith(':')) return false;
    else m.paths.push(w.startsWith('/') ? w : `${trimSlash(gdir)}/${w}`);
  }
  if (sub !== 'ls-files' && !ok) return false;
  if (m.paths.length === 0) m.paths = [gdir];
  m.vals = ['*'];
  m.gdir = gdir;
  return true;
}

function rgModel(args: string[], m: Model): boolean {
  const n = args.length;
  let k = 0;
  let ok = false;
  let nocase = false;
  while (k < n) {
    const w = args[k++];
    if (w === '--files') ok = true;
    else if (/^(-L|--follow|--path-separator.*|--pre|--pre=.*)$/s.test(w)) return false;
    else if (w === '-g' || w === '--glob' || w === '--iglob') {
      const a = args[k] ?? '';
      if (a.startsWith('!')) {
        if (w !== '--iglob') m.excl.push('Q:' + a.slice(1));
      } else m.pats.push((w === '--iglob' ? 'i:' : 's:') + a);
      k++;
    } else if (w === '-i' || w === '--ignore-case' || w === '--glob-case-insensitive') nocase = true;
    else if (RG_VALUE.test(w)) k++;
    else if (!w.startsWith('-')) m.paths.push(w);
  }
  if (!ok) return false;
  if (nocase) {
    m.pats = m.pats.map((p) => 'i:' + p.slice(2));
    m.excl = [];
  }
  return true;
}

function fdModel(mode: ListerMode, args: string[], raw: string[], acts: string[], m: Model): boolean {
  const n = args.length;
  let k = 0;
  let ok = false;
  let bad = false;
  while (k < n) {
    const w = args[k++];
    if (w === '-x' || w === '--exec' || w === '-X' || w === '--exec-batch') {
      if (mode !== 'exec') return false;
      const run: string[] = [];
      let hit = false;
      while (k < n) {
        const x = raw[k++];
        if (x === '\x06') break;
        if (PLACEHOLDER.test(x)) hit = true;
        run.push(x);
      }
      if (!hit) run.push('{}');
      acts.push('x' + run.join(' '));
    } else if (/^(--format.*|--path-separator.*|-L|--follow|-l|--list-details|--base-directory.*)$/s.test(w)) bad = true;
    else if (w === '--search-path') m.paths.push(args[k++] ?? '');
    else if (w === '-E' || w === '--exclude') m.excl.push('F:' + (args[k++] ?? ''));
    else if (FD_VALUE.test(w)) k++;
    else if (w.startsWith('-')) continue;
    else if (!ok) ok = true;
    else m.paths.push(w);
  }
  return !bad;
}

/**
 * _tmb_cmd_lister_bind: the values to record under `name` for a lister's
 * `words` (decoded for `loop`, encoded for `exec`, whose actions are appended
 * to `acts`), or null when its paths cannot be bound.
 */
export function listerBind(
  host: ListerHost,
  name: string,
  dirtok: string,
  mode: ListerMode,
  words: readonly string[],
  acts: string[],
): string[] | null {
  if (mode === 'loop' && (host.root === '' || !NAME.test(name))) return null;
  const dec = mode === 'loop' ? words : words.map(decode);
  let dir = '';
  if (dirtok.startsWith('/')) dir = dirtok;
  else if (dirtok === '@') dir = host.cwd;
  else if (dirtok.startsWith('@/') && host.cwd !== '') dir = `${trimSlash(host.cwd)}/${dirtok.slice(2)}`;
  if (dir === '' && mode !== 'exec') return null;
  const args: string[] = [];
  const raw: string[] = [];
  let skip = false;
  for (let k = 1; k < words.length; k++) {
    const w = dec[k] ?? '';
    if (mode === 'exec') {
      if (skip) {
        skip = false;
        continue;
      }
      if (EXEC_REDIRECT.test(words[k])) {
        skip = true;
        continue;
      }
      if (EXEC_REDIRECT_WORD.test(words[k])) continue;
      raw.push(words[k]);
    } else {
      if (w === '2>/dev/null') continue;
      if (w === '2>') {
        if (words[k + 1] !== '/dev/null') return null;
        k++;
        continue;
      }
      if (/[<>`]/.test(w)) return null;
    }
    args.push(w);
  }
  const cmd = basename(words[0] ?? '');
  if (mode === 'exec' && cmd !== 'find' && cmd !== 'fd' && cmd !== 'fdfind') return null;
  const m: Model = { paths: [], vals: [], pats: [], excl: [], gdir: '', listed: false };
  let fine: boolean;
  if (cmd === 'find') fine = findModel(mode, args, raw, acts, m);
  else if (cmd === 'ls') fine = lsModel(args, m);
  else if (cmd === 'git') fine = gitModel(dir, args, m);
  else if (cmd === 'rg') fine = rgModel(args, m);
  else if (cmd === 'fd' || cmd === 'fdfind') fine = fdModel(mode, args, raw, acts, m);
  else return null;
  if (!fine || dir === '' || host.root === '') return null;
  if (mode === 'exec' && acts.length === 0) return null;
  if (!NAME.test(name)) return null;
  const rootc = host.rootc();
  const rootTrim = trimSlash(rootc);
  let bound = rootc;
  const git = cmd === 'git';
  if (git) {
    bound = pathCanonical(m.gdir);
    if (!(bound + '/').startsWith(rootTrim + '/')) return null;
  }
  if (m.paths.length === 0) m.paths = ['.'];
  const vals = m.vals;
  for (const p of m.paths) {
    const exp = host.expand(p);
    if (exp === null) return null;
    for (let v of exp) {
      if (v === '~') v = host.home;
      else if (v.startsWith('~/')) v = `${host.home}/${v.slice(2)}`;
      let w = v.startsWith('/') ? v : `${trimSlash(dir)}/${v}`;
      const glob = w.search(/[*?[]/);
      if (glob >= 0) {
        w = w.slice(0, glob);
        const slash = w.lastIndexOf('/');
        if (slash >= 0) w = w.slice(0, slash);
        if (w === '') w = '/';
      }
      w = pathCanonical(w);
      if (!(w + '/').startsWith(trimSlash(bound) + '/')) return null;
      if (w.startsWith(rootTrim)) w = w.slice(rootTrim.length);
      const at = git ? trimSlash(p) : trimSlash(v);
      if (isPromptSurfacePath(`${rootTrim}${trimSlash(w)}/x.md`, rootc)) vals.push(`${at}/*.md`);
      else if (cmd !== 'ls') {
        const rel = w.replace(/^\//, '');
        for (const d of SURFACES) {
          const sub = rel !== '' && d.startsWith(rel + '/') ? d.slice(rel.length + 1) : d;
          if (d === 'CLAUDE.md') {
            if (rel !== '' || !isFile(`${rootTrim}/${d}`)) continue;
          } else if (!isDir(`${rootTrim}/${d}`) || (rel !== '' && sub === d)) continue;
          if (m.excl.some((e) => exclCovers(e, d, sub, v, host.root, rootc))) continue;
          if (m.pats.length > 0) {
            const names = d === 'CLAUDE.md' ? ['CLAUDE.md'] : ['x.md', 'SKILL.md', 'CLAUDE.md'];
            if (!m.pats.some((pat) => names.some((v2) => patMatches(pat, v2)))) continue;
          }
          vals.push(`${at}/${d === 'CLAUDE.md' ? d : `${sub}/*.md`}`);
        }
      }
      if (git) continue;
      vals.push(v, `${trimSlash(v)}/*`);
      for (const pat of m.pats) {
        const body = pat.slice(2);
        if (body === '' || body.includes('/') || body.startsWith('!')) continue;
        if (PROMPT_FILES.some((f) => patMatches(pat, f))) vals.push(`${trimSlash(v)}/${body}`);
      }
    }
  }
  if (m.listed) vals.push('*');
  let list = '\n';
  for (const v of vals) if (!list.includes(`\n${v}\n`)) list += v + '\n';
  const lines = list.slice(1).replace(/\n$/, '').split('\n');
  return lines.length > 16 ? null : lines;
}
