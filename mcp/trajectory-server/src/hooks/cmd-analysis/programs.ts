/**
 * The interpreter-program half of cmd-analysis.sh: _tmb_cmd_interp_writes,
 * _tmb_cmd_prog_writes, _tmb_cmd_prog_scan and _tmb_cmd_prog_literals. A
 * process call's command is judged by the caller's `procWrites`
 * (_tmb_cmd_proc_writes), which needs the whole analyzer.
 *
 * Where the .sh prints nothing for a program that writes, the TS prints a
 * `$(computed):<text>` line instead (GH 1692): a write call whose target is
 * not a literal (beside any literal paths the program names), a program held
 * in a variable or a substitution, a quoted paren in it included. A node
 * target name bound once, first, to a plain string literal is that literal; a
 * python one bound first and only by top-level plain-literal statements (also
 * `Path` / `pathlib.Path` / `PurePath` of one) is every literal it is bound to
 * (`heldLiterals`); a program that reaches its namespace dynamically
 * (`VOIDERS`) resolves no name. A `sys.argv[n]` / `process.argv[n]` target is
 * never resolved: it prints a `$(computed)` line beside any operands the .sh
 * prints.
 */
import { SUB_PC, SUB_PO, decode } from './encode.js';
import { type Lang, progCalls } from './prog-calls.js';
import { proveProgram } from './prove.js';

export type ProcWrites = (command: string) => string;

/** The path a fail-closed shape prints in place of the paths it cannot name; `emit` turns it into an UNRESOLVED:$(computed): line. */
export const COMPUTED = '$(computed):';
/** The path a process call's command that does not parse prints; `emit` turns it into an UNRESOLVED:$(parse): line. */
export const PARSE = '$(parse):';
/** The path an inline program `proveProgram` cannot prove prints (GH 1739); `emit` turns it into an UNRESOLVED:$(unproven): line. */
export const UNPROVEN = '$(unproven):';

/** The index past the double-quoted text that starts at `from`, or -1. */
function dquoteEnd(s: string, from: number): number {
  for (let k = from; k < s.length; k++) {
    if (s[k] === '\\') k++;
    else if (s[k] === '"') return k + 1;
    else if (s.startsWith('$(', k)) {
      const e = closeAt(s, k + 2, true, '(', ')');
      if (e < 0) return -1;
      k = e - 1;
    } else if (s[k] === '`') {
      const e = s.indexOf('`', k + 1);
      if (e < 0) return -1;
      k = e;
    }
  }
  return -1;
}

/** The index past the `shut` that closes an `open` before `from`, nesting counted, quotes skipped when `quotes`; -1 when none. */
function closeAt(s: string, from: number, quotes: boolean, open: string, shut: string): number {
  let depth = 1;
  for (let k = from; k < s.length; k++) {
    const c = s[k];
    if (quotes && c === '\\') k++;
    else if (quotes && c === "'") {
      k = s.indexOf("'", k + 1);
      if (k < 0) return -1;
    } else if (quotes && c === '"') {
      k = dquoteEnd(s, k + 1) - 1;
      if (k < 0) return -1;
    } else if (c === open) depth++;
    else if (c === shut && --depth === 0) return k + 1;
  }
  return -1;
}

/** The index past the expansion at `i` ($NAME, $1, ${…}, $(…), `…`, a QO … QC frame), or -1. */
function expansionEnd(s: string, i: number, quotes: boolean): number {
  const c = s[i];
  const n = s[i + 1] ?? '';
  if (c === '`') {
    const e = s.indexOf('`', i + 1);
    return e < 0 ? -1 : e + 1;
  }
  if (c === '\x07') return closeAt(s, i + 1, quotes, '\x07', '\x08');
  if (c !== '$') return -1;
  if (n === '(') return closeAt(s, i + 2, quotes, '(', ')');
  if (n === '{') return closeAt(s, i + 2, quotes, '{', '}');
  if (/[A-Za-z_]/.test(n)) return i + 1 + /^[A-Za-z0-9_]*/.exec(s.slice(i + 1))![0].length;
  return /[0-9@*#?$!-]/.test(n) ? i + 2 : -1;
}

function onlyExpansions(s: string, quotes: boolean): boolean {
  let i = 0;
  let any = false;
  for (;;) {
    while (i < s.length && /[ \t\n;]/.test(s[i])) i++;
    if (i >= s.length) return any;
    i = expansionEnd(s, i, quotes);
    if (i < 0) return false;
    any = true;
  }
}

/**
 * A program made only of expansions ("$PROG", "$(cat $(echo x))"): its text
 * is not in the command. `program` is an encoded word, so a quoted paren in a
 * substitution (SUB_PO / SUB_PC) is not taken for the substitution's own, or
 * raw text (a heredoc body), read once honouring quotes and once not.
 */
export function heldProgram(program: string): boolean {
  const text = decode(program.split(SUB_PO).join('_').split(SUB_PC).join('_'));
  if (!/[$`\x07]/.test(text)) return false;
  return onlyExpansions(text, true) || onlyExpansions(text, false);
}

/** The shown text of a fail-closed line: decoded, one line, at most 80 characters. */
export function shown(text: string): string {
  const flat = decode(text).replace(/\x07/g, '$(').replace(/\x08/g, ')').replace(/[\r\n]/g, ' ');
  return [...flat].slice(0, 80).join('');
}

const PY_RUNNERS = /^(timeit|cProfile|profile|trace|pdb|runpy|code|doctest|pydoc|pickle|py_compile|compileall)$/;
const SP = '[ \\t\\n\\v\\f\\r]*';
const Q = `['"]`;
const LIT = `${Q}[^'"]+${Q}`;
const FN =
  'writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|mkdirSync|renameSync|rmSync|rmdirSync|unlinkSync|copyFileSync|cpSync|fs\\.(mkdir|rename|rm|rmdir|unlink|copyFile|cp)|makedirs|rmtree|dump_stats|(File|IO)\\.(bin)?write|os\\.(remove|unlink|mkdir|rename|replace|rmdir)|shutil\\.(copy|copyfile|copy2|copytree|move)';
const SHAPE = new RegExp(
  `open${SP}\\([^)]*,${SP}(mode${SP}=${SP})?${Q}[rbt]*[wax+]|open${SP}\\(?[^,;()]*,${SP}${Q}[+]?>|write_text|write_bytes|createWriteStream|(${FN})${SP}\\(`,
);
const WRITES = new RegExp(
  `open${SP}\\(${SP}${LIT}${SP},${SP}(mode${SP}=${SP})?${Q}[rbt]*[wax+]|(${FN})${SP}\\(${SP}${LIT}|Path${SP}\\(${SP}${LIT}${SP}\\)${SP}\\.${SP}(write_text|write_bytes|mkdir|touch|unlink|rmdir|rename)`,
  'g',
);
const READS = new RegExp(
  `open${SP}\\(${SP}${LIT}${SP}(,${SP}${Q}r[bt]?${Q}${SP})?\\)|(readFileSync|readFile|createReadStream|existsSync|statSync)${SP}\\(${SP}${LIT}|Path${SP}\\(${SP}${LIT}${SP}\\)${SP}\\.${SP}(read_text|read_bytes|exists)`,
  'g',
);
const QUOTED = new RegExp(LIT, 'g');
const RAW_TOKEN = /['"][^'"\t\n\v\f\r ]+['"]/g;

const chomp = (s: string): string => s.replace(/\n+$/, '');
const basename = (w: string): string => w.replace(/.*\//, '');
const blank = (line: string): boolean => !/[^ \t\n]/.test(line);

/** grep -o over the lines of `text`: every match, line by line. */
function grepO(text: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) for (const m of line.matchAll(re)) if (m[0] !== '') out.push(m[0]);
  return out;
}

/** _tmb_cmd_prog_scan: the scanner's lines, a code-string runner's `R<TAB><code>` replaced by `R` and the scan of the code. */
export function progScan(lang: Lang, program: string, depth = 0): string[] {
  if (depth > 3) return ['W', 'U'];
  const out: string[] = [];
  for (const line of progCalls(lang, program)) {
    if (line.startsWith('R\t')) out.push('R', ...progScan(lang, chomp(line.slice(2).replace(/\x1f/g, '\n')), depth + 1));
    else out.push(line);
  }
  return out;
}

/** _tmb_cmd_prog_literals: every path-like literal not only read, one per line. */
function progLiterals(src: string, reads: readonly string[], writes: readonly string[], raw: boolean): string[] {
  const lits = raw ? grepO(src, RAW_TOKEN) : src.split('\n');
  const out: string[] = [];
  for (let lit of lits) {
    if (lit.length < 2) continue;
    if (reads.includes(lit) && !writes.includes(lit)) continue;
    lit = lit.slice(1, -1).replace(/^\+/, '').replace(/^>/, '').replace(/^>/, '');
    if (lit === '' || lit === '.' || lit === '..' || /[^A-Za-z0-9_./~-]/.test(lit)) continue;
    if (lit.includes('/') || /\.[A-Za-z0-9]/.test(lit)) out.push(lit);
  }
  return out;
}

const PY_DYNAMIC =
  /^(globals|locals|vars|exec|eval|compile|getattr|setattr|delattr|builtins|modules|_getframe|f_globals|f_locals|f_back|tb_frame|gi_frame|cr_frame|settrace|setprofile|inspect|gc|ctypes|importlib|pickle|marshal|shelve|yaml|dill|cloudpickle|jsonpickle|runpy|breakpoint|pdb|interact|operator|attrgetter|__[A-Za-z0-9_]*__)$/;
const NODE_DYNAMIC =
  /^(eval|Function|globalThis|global|window|self|with|vm|Reflect|defineProperty|arguments|this|constructor|prototype|__proto__|import|module|mainModule|binding|contextify|repl|inspector|dlopen|runInThisContext|runInContext|runInNewContext|Script|compileFunction)$/;
const PY_KEYWORDS =
  /^(and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|match|case)$/;
const NODE_KEYWORDS =
  /^(if|while|for|switch|catch|with|return|function|typeof|void|delete|new|in|of|instanceof|await|yield|case|throw|else|do|let|const|var|class|extends|super|import|export|async|get|set|static)$/;
const PY_COMPOUND = /^(if|elif|else|for|while|with|try|except|finally|def|class|async|match|case|lambda)$/;
const DEFINER = /^(function|def|class|async|get|set|static)$/;
const UNBINDABLE = /^(True|False|None|__debug__|undefined|NaN|Infinity|null|true|false)$/;
const PLAIN = /^[^\\$@#{}%`'"\x00-\x1f]+$/;
const GAP = '(?:\\s|\\\\\\r?\\n)*';
const VOIDERS = new RegExp(
  `\\bimport${GAP}\\*|\\b(?:exec|eval|compile|globals|locals|vars|setattr|delattr)${GAP}\\(|__dict__|__builtins__|__import__|importlib`,
);
const STR = '\x01';
const OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const space = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);

/** A python or node program with its strings and comments taken out: `code` holds one STR mark per string literal. */
interface Lexed {
  py: boolean;
  code: string;
  strs: { pfx: string; q: string; body: string }[];
  strAt: Map<number, number>;
  encl: number[];
  match: Map<number, number>;
}

/**
 * Lexes a program for `heldLiterals`, or undefined when no name in it can be
 * trusted to hold one value: an unclosed string or bracket, a template
 * substitution, a regex or division (node), a non-ASCII or escaped
 * identifier, a python `case` pattern, a non-literal `require`, a `VOIDERS`
 * token anywhere in the text (`import *` across continuations, `exec(`,
 * `vars(`, `__dict__`, `importlib`, ...), or a word that reaches the
 * namespace dynamically (exec, globals, frames, vm, the global object, ...)
 * in the code or in any string.
 */
function lex(py: boolean, src: string): Lexed | undefined {
  if (/[\x00-\x08\x0e-\x1f]/.test(src) || VOIDERS.test(src)) return undefined;
  let code = '';
  const strs: Lexed['strs'] = [];
  const strAt = new Map<number, number>();
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if ((py && c === '#') || (!py && src.startsWith('//', i))) {
      const e = src.indexOf('\n', i);
      i = e < 0 ? src.length : e;
      code += ' ';
      continue;
    }
    if (!py && src.startsWith('/*', i)) {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) return undefined;
      i = e + 2;
      code += ' ';
      continue;
    }
    if (c === "'" || c === '"' || (!py && c === '`')) {
      let pfx = '';
      const m = py ? /(?:^|[^A-Za-z0-9_])([A-Za-z]{1,2})$/.exec(code) : null;
      if (m && /^[rRbBuUfF]{1,2}$/.test(m[1])) {
        pfx = m[1];
        code = code.slice(0, -pfx.length);
      }
      const q = py && src.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      let j = i + q.length;
      let body = '';
      while (!src.startsWith(q, j)) {
        if (j >= src.length || (q.length === 1 && c !== '`' && src[j] === '\n')) return undefined;
        if (c === '`' && src.startsWith('${', j)) return undefined;
        const n = src[j] === '\\' ? 2 : 1;
        body += src.slice(j, j + n);
        j += n;
      }
      strAt.set(code.length, strs.length);
      strs.push({ pfx, q, body });
      code += STR;
      i = j + q.length;
      continue;
    }
    code += c;
    i++;
  }
  if (/[^\x00-\x7f]/.test(code) || (py ? /\\(?!\n)/.test(code) : /[\\/]/.test(code))) return undefined;
  if (py && /(^|\n)[ \t]*case\b/.test(code)) return undefined;
  if (!py && /\brequire\b(?!\s*\(\s*\x01\s*\))/.test(code)) return undefined;
  const word = py ? /[A-Za-z0-9_]+/g : /[A-Za-z0-9_$]+/g;
  const dynamic = py ? PY_DYNAMIC : NODE_DYNAMIC;
  for (const text of [code, ...strs.map((s) => s.body)]) for (const w of text.match(word) ?? []) if (dynamic.test(w)) return undefined;
  const encl: number[] = [];
  const match = new Map<number, number>();
  const stack: number[] = [];
  for (let k = 0; k < code.length; k++) {
    const ch = code[k];
    if (OPENER[ch]) {
      const o = stack.pop();
      if (o === undefined || code[o] !== OPENER[ch]) return undefined;
      match.set(o, k);
    }
    encl[k] = stack.length > 0 ? stack[stack.length - 1] : -1;
    if (ch === '(' || ch === '[' || ch === '{') stack.push(k);
  }
  if (stack.length > 0) return undefined;
  return { py, code, strs, strAt, encl, match };
}

/** Where the logical python line holding `i` starts: past bracketed and backslash-continued newlines. */
function lineStart(lx: Lexed, i: number): number {
  const { code, encl } = lx;
  let ls = code.lastIndexOf('\n', i - 1) + 1;
  while (ls > 0 && (encl[ls - 1] !== -1 || code[ls - 2] === '\\')) ls = code.lastIndexOf('\n', ls - 2) + 1;
  return ls;
}

/** The python simple statement holding `i`: from the `;` or logical line start before it to the `;` or line end after it. */
function statementAt(lx: Lexed, i: number): string {
  const { code, encl } = lx;
  const from = Math.max(lineStart(lx, i), code.lastIndexOf(';', i - 1) + 1);
  let to = i;
  while (to < code.length && code[to] !== ';' && !(code[to] === '\n' && encl[to] === -1 && code[to - 1] !== '\\')) to++;
  return code.slice(from, to);
}

const PATH_CALLEE = /^(pathlib\s*\.\s*Path|Path|PurePath)\s*\(\s*/;

/**
 * Whether `Path(…)`, `pathlib.Path(…)` and `PurePath(…)` are pathlib's own:
 * every mention of Path, PurePath or pathlib is a call (pathlib's as
 * `pathlib.Path(` / `pathlib.PurePath(`) or sits in `from pathlib import …` /
 * a plain `import`, never in a definition, another module's import or an
 * assignment.
 */
function pathlibCalls(lx: Lexed): boolean {
  const { code } = lx;
  for (const m of code.matchAll(/\b(Path|PurePath|pathlib)\b/g)) {
    const st = statementAt(lx, m.index);
    if (/^\s*(from|import)\b/.test(st)) {
      if (/^\s*from\s+pathlib\s+import\b/.test(st) || (/^\s*import\s+[A-Za-z0-9_.,\s]*$/.test(st) && !/\bas\b/.test(st))) continue;
      return false;
    }
    const rest = code.slice(m.index + m[0].length);
    if (m[0] === 'pathlib' ? !/^\s*\.\s*(Path|PurePath)\s*\(/.test(rest) : !/^\s*\(/.test(rest)) return false;
    if (DEFINER.test(/([A-Za-z0-9_]+)\s*$/.exec(code.slice(0, m.index))?.[1] ?? '')) return false;
  }
  return true;
}

/** The literal of `name = '<plain>'` (python also `name = Path('<plain>')`, `pathlib.Path(…)`, `PurePath(…)`) at `i` when it is an unconditional top-level statement of its own. */
function bindingAt(lx: Lexed, name: string, i: number): string | undefined {
  const { py, code } = lx;
  if (lx.encl[i] !== -1) return undefined;
  if (py) {
    const ls = lineStart(lx, i);
    const before = code.slice(ls, i);
    const first = /^[A-Za-z_][A-Za-z0-9_]*/.exec(before)?.[0] ?? '';
    if (before !== '' && (space(before[0]) || !/;[ \t]*$/.test(before) || PY_COMPOUND.test(first))) return undefined;
  } else {
    let b = code.slice(0, i).replace(/\s+$/, '');
    const decl = /(?:^|[^A-Za-z0-9_$])(const|let|var)$/.exec(b);
    if (decl) b = b.slice(0, -decl[1].length).replace(/\s+$/, '');
    if (b !== '' && !b.endsWith(';')) return undefined;
  }
  let j = i + name.length;
  while (code[j] === ' ' || code[j] === '\t') j++;
  if (code[j] !== '=' || code[j + 1] === '=' || code[j + 1] === '>') return undefined;
  j++;
  while (code[j] === ' ' || code[j] === '\t') j++;
  const callee = py ? PATH_CALLEE.exec(code.slice(j)) : null;
  if (callee) {
    if (!pathlibCalls(lx)) return undefined;
    j += callee[0].length;
  }
  const s = lx.strs[lx.strAt.get(j) ?? -1];
  if (!s || s.pfx !== '' || (s.q !== "'" && s.q !== '"') || !PLAIN.test(s.body)) return undefined;
  j++;
  if (callee) {
    while (space(code[j])) j++;
    if (code[j] !== ')') return undefined;
    j++;
  }
  while (code[j] === ' ' || code[j] === '\t' || code[j] === '\r') j++;
  return code[j] === undefined || code[j] === ';' || (py && code[j] === '\n') ? s.body : undefined;
}

/** Whether the logical python line holding `u` has a lambda. */
function lambdaLine(lx: Lexed, u: number, from: number): boolean {
  const end = lx.code.indexOf('\n', from);
  return /\blambda\b/.test(lx.code.slice(lineStart(lx, u), end < 0 ? lx.code.length : end));
}

/**
 * A read of `name` at `u`: a whole argument of a call that defines nothing and
 * is not assigned to, or (python) the receiver of a method call
 * `name.<ident>(` outside an import. An attribute store or any other
 * attribute access is not one.
 */
function useAt(lx: Lexed, name: string, u: number): boolean {
  const { py, code } = lx;
  let a = u - 1;
  while (space(code[a])) a--;
  let b = u + name.length;
  while (space(code[b])) b++;
  if (code[a] === '.') return false;
  if (py && code[b] === '.') {
    if (!/^\.\s*[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(code.slice(b))) return false;
    return !/^\s*(from|import)\b/.test(statementAt(lx, u)) && !lambdaLine(lx, u, u);
  }
  if ((code[a] !== '(' && code[a] !== ',') || (code[b] !== ')' && code[b] !== ',')) return false;
  const o = lx.encl[u];
  const c = lx.match.get(o);
  if (o < 0 || code[o] !== '(' || c === undefined) return false;
  let k = o - 1;
  while (space(code[k])) k--;
  if (code[k] !== ')' && code[k] !== ']') {
    const callee = /[A-Za-z0-9_$.]+$/.exec(code.slice(0, k + 1))?.[0] ?? '';
    const head = callee.replace(/^\.+/, '');
    if (head === '' || /^[0-9]/.test(head) || (py ? PY_KEYWORDS : NODE_KEYWORDS).test(head)) return false;
    let w = k - callee.length;
    while (space(code[w])) w--;
    if (DEFINER.test(/[A-Za-z0-9_$]+$/.exec(code.slice(0, w + 1))?.[0] ?? '')) return false;
  }
  let e = c + 1;
  while (space(code[e])) e++;
  if (code[e] === '{' || code[e] === ':' || code.startsWith('=>', e) || code.startsWith('->', e) || (code[e] === '=' && code[e + 1] !== '=')) return false;
  return !(py && lambdaLine(lx, u, c));
}

/**
 * Flow-insensitive constant propagation (GH 1692, GH 1756): the literals a
 * name may hold when its first mention binds it at top level to one plain
 * string literal (python: or pathlib's `Path` / `PurePath` of one), every
 * other mention is a whole call argument (python: or a method call's
 * receiver) and, in python only, may also be another such binding. A name
 * rebound in node, bound in a loop, branch, block, comprehension, `with` /
 * `for` header or function, augmented, attribute-stored or read as a non-call
 * attribute, bound to anything else, never bound, or written in a string has
 * none, nor has any name of a program with a `VOIDERS` token.
 */
function heldLiterals(lx: Lexed, name: string): string[] | undefined {
  if (UNBINDABLE.test(name)) return undefined;
  const word = lx.py ? /[A-Za-z0-9_]+/g : /[A-Za-z0-9_$]+/g;
  for (const s of lx.strs) if (s.body.match(word)?.includes(name)) return undefined;
  const occ = [...lx.code.matchAll(word)].filter((m) => m[0] === name).map((m) => m.index);
  if (occ.length < 2) return undefined;
  const first = bindingAt(lx, name, occ[0]);
  if (first === undefined) return undefined;
  const lits = [first];
  for (const u of occ.slice(1)) {
    const lit = lx.py ? bindingAt(lx, name, u) : undefined;
    if (lit !== undefined) lits.push(lit);
    else if (!useAt(lx, name, u)) return undefined;
  }
  return lits;
}

export interface ProgResult {
  lines: string[];
  /** A write call whose target the scanner could not read: F or A beside literal lines, or F / A / a write shape without a W when there are none. */
  computed: boolean;
  /** The program calls something neither judged nor in the safe set (`proveProgram`, GH 1739). */
  unproven: boolean;
}

/**
 * _tmb_cmd_prog_writes: the lines it prints; `-` with `operands` for a
 * program that writes but names no literal. `computed` marks a result that a
 * write call with a non-literal target took part in, so the caller adds a
 * `$(computed)` line beside the literal paths. A write shape the scanner did
 * not see as a call (often `open(join(d, 'x'))`, a read) adds none when a
 * literal was found. A target name `heldLiterals` resolves adds no
 * `$(computed)` line: the .sh's literal fallback still runs, and every literal
 * the name may hold follows it, each judged as a write target.
 */
export function progWrites(lang: Lang, program: string, operands: boolean, procWrites: ProcWrites): ProgResult {
  const scanned = progScan(lang, program);
  const unproven = !proveProgram(lang, program, scanned);
  const found = progFound(lang, program, scanned, operands, procWrites);
  return { ...found, unproven };
}

function progFound(lang: Lang, program: string, scanned: string[], operands: boolean, procWrites: ProcWrites): Omit<ProgResult, 'unproven'> {
  const scan = chomp(scanned.join('\n'));
  const has = (line: string): boolean => `\n${scan}\n`.includes(`\n${line}\n`);
  const cd = has('C');
  const run = has('R');
  const names = scan.split('\n').flatMap((line) => (line.startsWith('F\t') ? [line.slice(2)] : []));
  const lexed = names.length > 0 && (lang === 'py' || lang === 'node') && !has('A') && !run ? lex(lang === 'py', program) : undefined;
  const held = new Map<string, string[] | undefined>(names.map((name) => [name, lexed && heldLiterals(lexed, name)]));
  const unread = has('A') || has('F') || [...held.values()].includes(undefined);
  let fail = unread || held.size > 0;
  if (!has('W')) {
    if (!program.split('\n').some((line) => SHAPE.test(line))) return { lines: [], computed: false };
    fail = true;
  }
  let out = '';
  let src = '';
  for (const line of scan.split('\n')) {
    const rest = line.slice(2);
    if (line === 'U') out += '$(proc)\n';
    else if (line === 'H') out += '$(alias-write)\n';
    else if (rest === '' || line[1] !== '\t') continue;
    else if (line[0] === 'T') out += rest + '\n';
    else if (line[0] === 'S') out += (cd ? '$(proc)' : chomp(procWrites(chomp(rest.replace(/\x1f/g, '\n'))))) + '\n';
    else if (line[0] === 'Q') src += rest + '\n';
  }
  let raw = false;
  if (has('A')) {
    src = program;
    raw = true;
  }
  if (fail) {
    const writes = grepO(program, WRITES)
      .map((m) => /^[^'"]*['"][^'"]+['"]/.exec(m)?.[0])
      .filter((m): m is string => m !== undefined)
      .map((m) => /['"][^'"]+['"]$/.exec(m)?.[0])
      .filter((m): m is string => m !== undefined);
    const reads = grepO(grepO(program, READS).join('\n'), QUOTED);
    out += progLiterals(src, reads, writes, raw).join('\n');
    if (run) out += '\n$(proc)';
    for (const lits of held.values()) for (const lit of lits ?? []) out += `\n${lit}`;
  }
  let lines = out.split('\n');
  if (cd) lines = lines.filter((l) => !blank(l)).map((l) => (/^[/~$]/.test(l) ? '' : '$(proc)/') + l);
  const seen = new Set<string>();
  lines = lines.filter((l) => !blank(l) && !seen.has(l) && seen.add(l) !== undefined);
  if (lines.length > 0) return { lines, computed: unread };
  return { lines: operands ? ['-'] : [], computed: fail };
}

/** The option word that takes an inline program, clustered after flags that take no argument, the program attached in group 1 or in the next word. */
const PROGRAM_FLAG: Record<Lang, RegExp> = {
  py: /^-[bBdEhiIOPqRsSuvx]*c(.*)$/s,
  node: /^(?:-e|-p|-pe|--eval|--print)(?:=(.*))?$/s,
  perl: /^-[nlpaswWtTUcX]*[eE](.*)$/s,
  ruby: /^-[nlpaswWdv]*e(.*)$/s,
};

/**
 * _tmb_cmd_interp_writes: the lines an interpreter one-liner's statement
 * words add. A program `proveProgram` cannot prove, or one part of whose text
 * the shell fills in (`held`, a word of `Encoded.held`), adds a
 * `$(unproven)` line (GH 1739); perl and ruby run every `-e` program, joined.
 */
export function interpWrites(words: readonly string[], procWrites: ProcWrites, held: (word: string) => boolean = () => false): string[] {
  const argv0 = basename(words[0] ?? '');
  let lang: Lang;
  let pyopt = false;
  if (/^(python|python3|python[23]\..*)$/s.test(argv0)) {
    lang = 'py';
    pyopt = true;
  } else if (argv0 === 'node' || argv0 === 'nodejs') lang = 'node';
  else if (argv0 === 'perl') lang = 'perl';
  else if (argv0 === 'ruby') lang = 'ruby';
  else return [];
  const n = words.length;
  let k = 1;
  let optarg = false;
  const encoded: string[] = [];
  const carriers: string[] = [];
  const take = (flagWord: string, attached: string | undefined, next: string | undefined): void => {
    encoded.push(attached ? attached : (next ?? ''));
    carriers.push(attached ? flagWord : (next ?? ''));
  };
  while (k < n) {
    const w = words[k++];
    if (pyopt) {
      const m = /^-[bBdEhiIOPqRsSuvx]*m(.*)$/s.exec(w);
      if (m) {
        pyopt = false;
        if (PY_RUNNERS.test(chomp(decode(m[1] || (words[k] ?? ''))))) return ['$(proc)'];
      } else if (optarg) optarg = false;
      else if (w === '-W' || w === '-X') optarg = true;
      else if (!w.startsWith('-')) pyopt = false;
    }
    const m = PROGRAM_FLAG[lang].exec(w);
    if (m) {
      take(w, m[1], m[1] ? undefined : words[k++]);
      break;
    }
  }
  if (lang === 'perl' || lang === 'ruby') {
    for (let j = k; j < n; j++) {
      const m = PROGRAM_FLAG[lang].exec(words[j]);
      if (m) take(words[j], m[1], m[1] ? undefined : words[++j]);
    }
  }
  const program = encoded.map((e) => chomp(decode(e))).join('\n');
  if (program === '') return [];
  if (heldProgram(encoded[0])) return [COMPUTED + shown(`${argv0} ${program}`)];
  const found = progWrites(lang, program, true, procWrites);
  const unproven = found.unproven || carriers.some(held) ? [UNPROVEN + shown(program)] : [];
  if (found.lines.length === 0) return unproven;
  const literal = !(found.lines[0] === '-' && found.lines.length === 1);
  const out = literal ? [...found.lines] : [];
  for (; k < n; k++) if (!words[k].startsWith('-')) out.push(...decode(words[k]).split('\n'));
  if (found.computed) out.push(COMPUTED + argv0);
  return [...out, ...unproven];
}
