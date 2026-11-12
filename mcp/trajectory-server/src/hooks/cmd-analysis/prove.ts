/**
 * The allowlist over inline programs (GH 1739): a python, node, perl or ruby
 * program is proven when every call in it is a write the scanner already
 * judges (prog-calls.ts) or sits in a closed safe set, and no name can hold a
 * callable the analysis cannot follow. Anything else is unproven, and the
 * caller prints `UNRESOLVED:$(unproven):<program>`.
 *
 * Python and node programs are parsed with tree-sitter, flow- and
 * scope-insensitively: a name is an import alias only when every binding of
 * it is the same import, a function only when every binding is a `def` /
 * function declaration (or one lambda / function expression), and a local
 * when every binding is fresh data; calling a local is unproven. A name
 * assigned a reference chain (`e=os.environ`, `const e=process.env`, `f=e`)
 * holds what the chain resolves to and is judged as that chain written out,
 * and a name whose bindings mix an import or alias with anything else is
 * unproven wherever it is used (GH 2481). A process global (os.environ,
 * sys.argv, process.env, …) is proven only where it cannot escape into a
 * container, an argument or a return value (`contained`, GH 2490). A judged
 * write call with no `W` line from the scanner is unproven too. A grammar not loaded yet leaves the
 * program unproven for this pass and is loaded before the command is analyzed
 * again (index.ts). perl and ruby are lexed against an identifier allowlist,
 * judged writes included; perl's `select` is proven only as the 4-argument
 * sleep `select(undef,undef,undef,<number or $scalar>)` (GH 1887), and an
 * unjudged `open` only as a 2-argument read of a plain path literal (GH 2024).
 */
import { builtinModules } from 'node:module';
import type { Node } from 'web-tree-sitter';
import { programParser } from './parser.js';
import { type Lang, judgedCall } from './prog-calls.js';

const PY_SAFE_BUILTINS = new Set([
  'print', 'len', 'str', 'int', 'float', 'bool', 'list', 'dict', 'set', 'tuple', 'sorted', 'min', 'max', 'sum', 'range',
  'enumerate', 'zip', 'map', 'filter', 'any', 'all', 'repr', 'isinstance',
]);
const PY_BUILTINS = new Set([
  ...PY_SAFE_BUILTINS, 'abs', 'aiter', 'anext', 'ascii', 'bin', 'breakpoint', 'bytearray', 'bytes', 'callable', 'chr',
  'classmethod', 'compile', 'complex', 'copyright', 'credits', 'delattr', 'dir', 'divmod', 'eval', 'exec', 'exit',
  'format', 'frozenset', 'getattr', 'globals', 'hasattr', 'hash', 'help', 'hex', 'id', 'input', 'issubclass', 'iter',
  'license', 'locals', 'memoryview', 'next', 'object', 'oct', 'open', 'ord', 'pow', 'property', 'quit', 'reversed',
  'round', 'setattr', 'slice', 'staticmethod', 'super', 'type', 'vars', '__import__', '__build_class__',
]);
const PY_READ_MODES = new Set(['r', 'rb', 'rt']);
const PY_SAFE_CALLS = new Set(['json.load', 'json.loads', 'json.dumps', 'os.listdir', 'os.getcwd']);
/**
 * The safe modules and the one name past each a program may reach, a closed
 * list so a module a safe module imports (`os.path.os`, `re.enum`) is never
 * reached; `'*'` is any public name of a C module that holds no modules.
 * A `deep` name allows one more public attribute (`datetime.datetime.now`).
 */
const PY_SAFE_MODULES: Record<string, { names: ReadonlySet<string> | '*'; deep?: ReadonlySet<string> }> = {
  re: {
    names: new Set([
      'compile', 'search', 'match', 'fullmatch', 'split', 'findall', 'finditer', 'sub', 'subn', 'escape', 'purge', 'error',
      'PatternError', 'Pattern', 'Match', 'RegexFlag', 'NOFLAG', 'ASCII', 'A', 'IGNORECASE', 'I', 'LOCALE', 'L', 'MULTILINE',
      'M', 'DOTALL', 'S', 'VERBOSE', 'X', 'UNICODE', 'U', 'DEBUG',
    ]),
  },
  'os.path': {
    names: new Set([
      'abspath', 'basename', 'commonpath', 'commonprefix', 'dirname', 'exists', 'lexists', 'expanduser', 'expandvars',
      'getatime', 'getctime', 'getmtime', 'getsize', 'isabs', 'isdir', 'isfile', 'islink', 'ismount', 'isjunction',
      'isdevdrive', 'isreserved', 'join', 'normcase', 'normpath', 'realpath', 'relpath', 'samefile', 'sameopenfile',
      'samestat', 'split', 'splitdrive', 'splitext', 'splitroot', 'curdir', 'pardir', 'sep', 'altsep', 'extsep', 'pathsep',
      'defpath', 'devnull', 'supports_unicode_filenames',
    ]),
  },
  collections: {
    names: new Set(['ChainMap', 'Counter', 'OrderedDict', 'UserDict', 'UserList', 'UserString', 'defaultdict', 'deque', 'namedtuple']),
    deep: new Set(['ChainMap', 'Counter', 'OrderedDict', 'defaultdict', 'deque']),
  },
  itertools: {
    names: new Set([
      'accumulate', 'batched', 'chain', 'combinations', 'combinations_with_replacement', 'compress', 'count', 'cycle',
      'dropwhile', 'filterfalse', 'groupby', 'islice', 'pairwise', 'permutations', 'product', 'repeat', 'starmap',
      'takewhile', 'tee', 'zip_longest',
    ]),
    deep: new Set(['chain']),
  },
  math: { names: '*' },
  datetime: {
    names: new Set(['date', 'datetime', 'time', 'timedelta', 'timezone', 'tzinfo', 'MINYEAR', 'MAXYEAR', 'UTC']),
    deep: new Set(['date', 'datetime', 'time', 'timedelta', 'timezone']),
  },
};
const PY_JSON_NAMES = new Set(['load', 'loads', 'dump', 'dumps', 'JSONDecoder', 'JSONEncoder', 'JSONDecodeError']);
const PY_SAFE_STREAMS = new Set(['sys.argv', 'sys.stdin', 'sys.stdout', 'sys.stderr', 'os.environ']);
/** Calls that neither store an argument nor return it or a container holding it, so a stream passed to one cannot escape (GH 2490). */
const PY_SINKS = new Set(['print', 'len', 'str', 'repr', 'sorted', 'dict', 'list', 'tuple', 'set', 'json.dumps', 'json.dump', 'json.load']);
/** The streams whose elements are strings, so unpacking one binds only strings or a fresh list (GH 2490). */
const PY_UNPACKED = new Set(['os.environ', 'sys.argv', 'sys.stdin']);
const PY_UNPACK = new Set(['pattern_list', 'tuple_pattern', 'list_pattern']);
const publicName = (p: string): boolean => /^[A-Za-z][A-Za-z0-9_]*$/.test(p);

/** Whether `q` is a name the table lets past a safe module (`re.sub`, `datetime.datetime.now`). */
function safeModuleMember(q: string): boolean {
  for (const [mod, { names, deep }] of Object.entries(PY_SAFE_MODULES)) {
    if (!q.startsWith(`${mod}.`)) continue;
    const [name, attr, ...more] = q.slice(mod.length + 1).split('.');
    if (more.length > 0 || !publicName(name) || (names !== '*' && !names.has(name))) return false;
    return attr === undefined || (deep?.has(name) === true && publicName(attr));
  }
  return false;
}

/** Whether `q` names a safe module, a member the table allows, a json name, or a public attribute of a stream, argv or the environment. */
function pySafeValue(q: string): boolean {
  if (Object.hasOwn(PY_SAFE_MODULES, q) || q === 'json' || safeModuleMember(q)) return true;
  const parts = q.split('.');
  if (parts[0] === 'json') return parts.length === 2 && PY_JSON_NAMES.has(parts[1]);
  const stream = parts.slice(0, 2).join('.');
  return PY_SAFE_STREAMS.has(stream) && parts.slice(2).every(publicName);
}
const PY_PATH = new Set(['pathlib.Path', 'pathlib.PurePath']);
const PY_METHODS = new Set([
  'strip', 'split', 'rsplit', 'join', 'get', 'items', 'keys', 'values', 'lower', 'upper', 'startswith', 'endswith', 'read',
  'readlines', 'format', 'count', 'find', 'append', 'extend', 'write', 'writelines', 'close', 'flush', 'add', 'update',
  'discard', 'remove', 'pop', 'setdefault', 'sort', 'insert', 'copy', 'clear',
]);
/** The container mutators of PY_METHODS, never proven on argv, a stream or the environment, whose stores are unproven too. */
const PY_MUTATORS = new Set(['add', 'update', 'discard', 'remove', 'pop', 'setdefault', 'sort', 'insert', 'clear']);
const PY_STREAM_FILES = new Set(['sys.stdout', 'sys.stderr']);
const PY_STR_METHODS = new Set(['read', 'read_text', 'decode', 'strip', 'lstrip', 'rstrip', 'lower', 'upper', 'replace', 'format', 'join']);
const PY_DUNDERS = new Set(['__name__', '__file__', '__doc__']);
const PY_UNPROVEN = new Set([
  'class_definition', 'decorated_definition', 'decorator', 'exec_statement', 'print_statement', 'match_statement',
  'wildcard_import', 'relative_import', 'type_alias_statement',
]);
const JSON_HOOKS = ['object_hook', 'object_pairs_hook', 'parse_float', 'parse_int', 'parse_constant', 'cls', 'default'];
/** The argument positions and keywords of a safe call that it calls back; `.sort` is the method on a local or literal. */
const PY_CALLBACKS: Record<string, { pos: number[]; kw: string[] }> = {
  map: { pos: [0], kw: [] },
  filter: { pos: [0], kw: [] },
  sorted: { pos: [], kw: ['key'] },
  min: { pos: [], kw: ['key'] },
  max: { pos: [], kw: ['key'] },
  're.sub': { pos: [1], kw: ['repl'] },
  're.subn': { pos: [1], kw: ['repl'] },
  'json.load': { pos: [], kw: JSON_HOOKS },
  'json.loads': { pos: [], kw: JSON_HOOKS },
  'json.dumps': { pos: [], kw: JSON_HOOKS },
  'json.dump': { pos: [], kw: JSON_HOOKS },
  '.sort': { pos: [], kw: ['key'] },
  'collections.defaultdict': { pos: [0], kw: ['default_factory'] },
  'itertools.accumulate': { pos: [1], kw: ['func'] },
  'itertools.starmap': { pos: [0], kw: [] },
  'itertools.filterfalse': { pos: [0], kw: [] },
  'itertools.takewhile': { pos: [0], kw: [] },
  'itertools.dropwhile': { pos: [0], kw: [] },
  'itertools.groupby': { pos: [1], kw: ['key'] },
};

const JS_SAFE_GLOBAL_CALLS = new Set(['parseInt', 'parseFloat', 'Number', 'String', 'Boolean']);
const JS_SAFE_GLOBALS = new Set([
  ...JS_SAFE_GLOBAL_CALLS, 'console', 'JSON', 'Math', 'Object', 'Array', 'undefined', 'NaN', 'Infinity', 'Map', 'Set', 'Date', 'RegExp', 'Error',
]);
const JS_NEW = new Set(['Map', 'Set', 'Array', 'Date', 'RegExp', 'Error']);
const JS_ROOTS = new Set(['console', 'JSON', 'Math', 'Object', 'process', 'Array', 'String', 'Number', 'Buffer']);
const JS_SAFE_CALLS = new Set([
  'Object.keys', 'Object.values', 'Object.entries', 'fs.readFileSync', 'fs.existsSync', 'fs.readdirSync', 'fs.statSync',
  'process.stdout.write', 'process.stderr.write', 'Buffer.byteLength',
]);
const JS_SAFE_ROOT_CALL = /^(console|JSON|Math)\./;
const JS_SAFE_VALUE = /^process\.(argv|env|stdout|stderr|version|versions|platform|arch)(\.|$)/;
/** The objects of JS_SAFE_VALUE, judged where they are used so none escapes into a name the proof takes for a local (GH 2490). */
const JS_ESCAPE = /^process\.(argv|env|stdout|stderr|versions)$/;
/** The objects of JS_ESCAPE whose values are strings, so destructuring one binds only strings or a fresh copy (GH 2490). */
const JS_UNPACKED = /^process\.(argv|env)$/;
const JS_COMPARE = new Set(['==', '!=', '===', '!==', '<', '>', '<=', '>=', 'in', 'instanceof']);
/** Calls that neither store an argument nor return it or a container holding it; `Object.assign` only past its first argument (GH 2490). */
const JS_SINKS = new Set(['JSON.stringify', 'Object.keys', 'Object.values', 'Object.entries', 'Object.assign']);
const JS_METHODS = new Set([
  'at', 'concat', 'entries', 'every', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flat', 'flatMap', 'forEach',
  'includes', 'indexOf', 'join', 'keys', 'lastIndexOf', 'map', 'reduce', 'reduceRight', 'slice', 'some', 'values', 'toSorted',
  'toReversed', 'toString', 'charAt', 'charCodeAt', 'codePointAt', 'endsWith', 'localeCompare', 'match', 'matchAll',
  'normalize', 'padEnd', 'padStart', 'repeat', 'replace', 'replaceAll', 'search', 'split', 'startsWith', 'substring',
  'toLowerCase', 'toUpperCase', 'trim', 'trimEnd', 'trimStart', 'write', 'end', 'close', 'push', 'pop', 'shift', 'unshift',
  'splice', 'reverse', 'sort', 'fill', 'get', 'set', 'has', 'add', 'delete', 'clear',
]);
/** The container mutators of JS_METHODS, never proven on `process.argv` / `env` / a stream, whose stores are unproven too. */
const JS_MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'reverse', 'sort', 'fill', 'set', 'add', 'delete', 'clear']);
const JS_CALLBACK_METHODS = new Set([
  'every', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flatMap', 'forEach', 'map', 'reduce', 'reduceRight', 'some', 'toSorted',
  'sort',
]);
const JS_UNPROVEN = new Set(['class_declaration', 'class', 'import_statement', 'export_statement', 'with_statement', 'import', 'this']);
const JS_HIDDEN = new Set(['__proto__', 'constructor', 'prototype', '__defineGetter__', '__defineSetter__']);

const SCRIPT_WORDS = new Set([
  'print', 'printf', 'say', 'puts', 'p', 'split', 'join', 'chomp', 'chop', 'lc', 'uc', 'length', 'substr', 'sprintf', 'sort',
  'keys', 'values', 'reverse', 'map', 'grep', 'my', 'our', 'if', 'unless', 'for', 'foreach', 'while', 'ARGV',
  'upcase', 'downcase', 'STDIN', 'STDOUT', 'STDERR',
  'else', 'elsif', 'until', 'and', 'or', 'not', 'xor', 'eq', 'ne', 'lt', 'gt', 'le', 'ge', 'cmp', 'x', 'last', 'next',
  'do', 'end', 'then', 'nil', 'true', 'false', 'in', 'BEGIN', 'END', 'write', 'close', 'sleep',
]);

/**
 * A resolved binding. An `import` with `json` set came from a required `.json`
 * file: plain data, safe to use as a value. An `alias` is a name bound to a
 * chain on a global (`const e=process.env`), judged as that chain written out.
 * `mixed` is a name whose bindings disagree past locals and defs: every use
 * of it is unproven. `local` is fresh in-memory data only.
 */
type Resolved =
  | { kind: 'import'; q: string; json?: boolean }
  | { kind: 'alias'; q: string }
  | { kind: 'def' }
  | { kind: 'local' }
  | { kind: 'mixed' };
/** A name assigned a reference chain (`e=os.environ`, `f=e`), resolved through `root` when used; a `bare` local is a declarator with no initializer. */
type Bind = Resolved | { kind: 'ref'; root: string; parts: string[] } | { kind: 'local'; bare: true };
/** A ref that led back to `name`, a binding still being resolved; `grew` when the way back added a part (`n=n.next`). */
type Cycle = { kind: 'cycle'; name: string; grew: boolean };

const LOCAL: Resolved = { kind: 'local' };
const MIXED: Resolved = { kind: 'mixed' };
const BARE: Bind = { kind: 'local', bare: true };
const WALK_LIMIT = 2000;

/** The names a program binds: every binding of each, merged by `resolve`. */
class Bindings {
  private readonly map = new Map<string, Bind[]>();
  /** Walks one `resolve` has taken: past WALK_LIMIT every name is mixed, so a program built to branch refs cannot stall the hook. */
  private steps = 0;

  /** `roots`: the unbound globals a ref may alias (node's `process`, `console`, …). */
  constructor(private readonly roots: ReadonlySet<string> = new Set()) {}

  add(name: string, bind: Bind): void {
    const list = this.map.get(name);
    if (list) list.push(bind);
    else this.map.set(name, [bind]);
  }

  /** Whether some binding of `name` is a ref: the name holds a value assigned to it. */
  assigned(name: string): boolean {
    return this.map.get(name)?.some((b) => b.kind === 'ref') === true;
  }

  resolve(name: string): Resolved | undefined {
    this.steps = 0;
    const b = this.walk(name, new Set());
    return b?.kind === 'cycle' ? MIXED : b;
  }

  private walk(name: string, seen: ReadonlySet<string>): Resolved | Cycle | undefined {
    const list = this.map.get(name);
    if (!list) return undefined;
    if (++this.steps > WALK_LIMIT) return MIXED;
    if (seen.has(name)) return { kind: 'cycle', name, grew: false };
    const inner = new Set(seen).add(name);
    const held = list.filter((b) => !('bare' in b));
    if (held.length === 0) return LOCAL;
    const all = held.map((b) => (b.kind === 'ref' ? this.deref(b, inner) : b));
    const own = (b: Resolved | Cycle): boolean => b.kind === 'cycle' && b.name === name;
    const binds = all.filter((b) => !own(b));
    const grown = all.some((b) => own(b) && (b as Cycle).grew);
    if (binds.length === 0 || (grown && !binds.every((b) => b.kind === 'local'))) return MIXED;
    const rest = binds.filter((b): b is Resolved => b.kind !== 'cycle');
    const cycles = binds.filter((b): b is Cycle => b.kind === 'cycle');
    if (cycles.length > 0) return rest.every((b) => b.kind === 'local') ? (cycles.find((c) => c.grew) ?? cycles[0]) : MIXED;
    const [first] = rest;
    const q = (b: Resolved): string | undefined => ('q' in b ? b.q : undefined);
    if (rest.every((b) => b.kind === first.kind && q(b) === q(first))) return first;
    if (rest.some((b) => b.kind === 'import' || b.kind === 'alias' || b.kind === 'mixed')) return MIXED;
    return LOCAL;
  }

  /** What a ref holds: the chain on what its root resolves to, an alias of an unbound global root, else a local. */
  private deref(ref: { root: string; parts: string[] }, seen: ReadonlySet<string>): Resolved | Cycle {
    const at = (base: string): string => [base, ...ref.parts].join('.');
    const b = this.walk(ref.root, seen);
    if (b === undefined) return this.roots.has(ref.root) ? { kind: 'alias', q: at(ref.root) } : LOCAL;
    switch (b.kind) {
      case 'import':
        return { kind: 'import', q: at(b.q), json: b.json };
      case 'alias':
        return { kind: 'alias', q: at(b.q) };
      case 'mixed':
        return b;
      case 'cycle':
        return { ...b, grew: b.grew || ref.parts.length > 0 };
      default:
        return LOCAL;
    }
  }
}

const kids = (node: Node): Node[] => node.namedChildren.filter((c): c is Node => c !== null);
const field = (node: Node, name: string): Node | null => node.childForFieldName(name);
const same = (a: Node | null | undefined, b: Node): boolean => a?.equals(b) === true;
const splat = (node: Node): boolean => node.type === 'list_splat' || node.type === 'dictionary_splat';

/**
 * A `.replace(a, b, …)` whose receiver is a call of a method that returns str
 * or bytes, never a Path (GH 1723): `Path.replace` and `os.replace` take one
 * target, and a name, subscript or other call receiver stays unproven.
 */
function strReplace(root: Node, parts: readonly string[], args: Node | null): boolean {
  if (root.type !== 'call' || parts.length !== 1 || !args) return false;
  const fn = field(root, 'function');
  const method = fn?.type === 'attribute' ? field(fn, 'attribute')?.text : undefined;
  if (method === undefined || !PY_STR_METHODS.has(method)) return false;
  const list = kids(args).filter((a) => a.type !== 'comment');
  if (list.some(splat)) return false;
  return list.filter((a) => a.type !== 'keyword_argument').length >= 2;
}

/** An attribute / member chain: its innermost object and the names after it. */
function chain(node: Node, type: string, object: string, property: string): { root: Node; parts: string[] } {
  const parts: string[] = [];
  let at = node;
  while (at.type === type) {
    const prop = field(at, property);
    const obj = field(at, object);
    if (!prop || !obj) break;
    parts.unshift(prop.text);
    at = obj;
  }
  return { root: at, parts };
}

/** A reference chain: a bare name or an attribute / member chain on one, as the ref it binds. */
function refOf(node: Node, type: string, object: string, property: string): Bind | undefined {
  const { root, parts } = chain(node, type, object, property);
  return root.type === 'identifier' ? { kind: 'ref', root: root.text, parts } : undefined;
}

const noComments = (node: Node): Node[] => kids(node).filter((c) => c.type !== 'comment');

/** The nodes a python value may evaluate to: through parentheses, chained and walrus assignments, `await`, `a if c else b` and `a or b`. */
function pySources(node: Node): Node[] {
  switch (node.type) {
    case 'parenthesized_expression':
    case 'await':
      return noComments(node).flatMap(pySources);
    case 'assignment':
    case 'named_expression': {
      const value = field(node, node.type === 'assignment' ? 'right' : 'value');
      return value ? pySources(value) : [node];
    }
    case 'conditional_expression': {
      const [a, , b] = noComments(node);
      return [a, b].filter((c) => c !== undefined).flatMap(pySources);
    }
    case 'boolean_operator':
      return [field(node, 'left'), field(node, 'right')].filter((c) => c !== null).flatMap(pySources);
    default:
      return [node];
  }
}

const JS_LOGICAL = new Set(['||', '&&', '??', '||=', '&&=', '??=']);

/** The nodes a node value may evaluate to: through parentheses, sequences, assignments, `await`, `a ? b : c` and `||` / `&&` / `??`. */
function jsSources(node: Node): Node[] {
  switch (node.type) {
    case 'parenthesized_expression':
    case 'await_expression':
      return noComments(node).flatMap(jsSources);
    case 'sequence_expression': {
      const last = noComments(node).at(-1);
      return last ? jsSources(last) : [node];
    }
    case 'assignment_expression': {
      const right = field(node, 'right');
      return right ? jsSources(right) : [node];
    }
    case 'ternary_expression':
      return [field(node, 'consequence'), field(node, 'alternative')].filter((c) => c !== null).flatMap(jsSources);
    case 'binary_expression':
    case 'augmented_assignment_expression': {
      if (!JS_LOGICAL.has(field(node, 'operator')?.text ?? '')) return [node];
      return [field(node, 'left'), field(node, 'right')].filter((c) => c !== null).flatMap(jsSources);
    }
    default:
      return [node];
  }
}

class Proof {
  readonly binds: Bindings;
  ok = true;
  judged = false;
  /** A judged write call with a `*` / `**` argument, whose target the scanner cannot see (GH 1723). */
  blind = false;

  constructor(roots?: ReadonlySet<string>) {
    this.binds = new Bindings(roots);
  }

  fail(): void {
    this.ok = false;
  }

  protected judge(args: Node | null): void {
    this.judged = true;
    if (args && kids(args).some(splat)) this.blind = true;
  }
}

/** The plain text of a string literal node, or undefined for one with an interpolation or a prefix. */
function pyLiteral(node: Node | null): string | undefined {
  if (!node || node.type !== 'string') return undefined;
  if (kids(node).some((c) => c.type === 'interpolation')) return undefined;
  const m = /^(['"])([^'"\\]*)\1$/.exec(node.text);
  return m?.[2];
}

class PyProof extends Proof {
  private bindTargets(node: Node): void {
    switch (node.type) {
      case 'identifier':
        this.binds.add(node.text, { kind: 'local' });
        return;
      case 'subscript':
      case 'attribute':
        return;
      default:
        for (const c of kids(node)) this.bindTargets(c);
    }
  }

  /** A name assigned `value`: a ref for each reference chain it may evaluate to, a local for anything else. */
  private bindValue(name: string, value: Node | null): void {
    if (!value) return this.binds.add(name, LOCAL);
    for (const src of pySources(value)) this.binds.add(name, refOf(src, 'attribute', 'object', 'attribute') ?? LOCAL);
  }

  private bindParams(node: Node): void {
    for (const p of kids(node)) {
      if (p.type === 'identifier') this.binds.add(p.text, { kind: 'local' });
      else if (p.type === 'default_parameter' || p.type === 'typed_default_parameter') {
        const name = field(p, 'name');
        if (name) this.bindTargets(name);
        if (name?.type === 'identifier') this.bindValue(name.text, field(p, 'value'));
      } else if (p.type === 'typed_parameter' || p.type === 'list_splat_pattern' || p.type === 'dictionary_splat_pattern') {
        for (const c of kids(p)) if (c.type === 'identifier') this.binds.add(c.text, { kind: 'local' });
      } else this.bindTargets(p);
    }
  }

  collect(node: Node): void {
    switch (node.type) {
      case 'import_statement':
        for (const name of node.childrenForFieldName('name')) {
          if (!name) continue;
          if (name.type === 'aliased_import') {
            const alias = field(name, 'alias');
            const dotted = field(name, 'name');
            if (alias && dotted) this.binds.add(alias.text, { kind: 'import', q: dotted.text.replace(/\s+/g, '') });
          } else {
            const top = name.text.replace(/\s+/g, '').split('.')[0];
            this.binds.add(top, { kind: 'import', q: top });
          }
        }
        return;
      case 'import_from_statement': {
        const mod = field(node, 'module_name');
        if (!mod || mod.type !== 'dotted_name') {
          this.fail();
          return;
        }
        const base = mod.text.replace(/\s+/g, '');
        for (const name of node.childrenForFieldName('name')) {
          if (!name) continue;
          const dotted = name.type === 'aliased_import' ? field(name, 'name') : name;
          const alias = name.type === 'aliased_import' ? field(name, 'alias') : name;
          if (dotted && alias) this.binds.add(alias.text, { kind: 'import', q: `${base}.${dotted.text.replace(/\s+/g, '')}` });
        }
        return;
      }
      case 'function_definition': {
        const name = field(node, 'name');
        if (name) this.binds.add(name.text, { kind: 'def' });
        const params = field(node, 'parameters');
        if (params) this.bindParams(params);
        break;
      }
      case 'lambda': {
        const params = field(node, 'parameters');
        if (params) this.bindParams(params);
        break;
      }
      case 'assignment': {
        const left = field(node, 'left');
        const right = field(node, 'right');
        if (left?.type === 'identifier' && right?.type === 'lambda') this.binds.add(left.text, { kind: 'def' });
        else if (left?.type === 'identifier') this.bindValue(left.text, right);
        else if (left) this.bindTargets(left);
        break;
      }
      case 'augmented_assignment':
      case 'for_statement':
      case 'for_in_clause': {
        const left = field(node, 'left');
        if (left) this.bindTargets(left);
        break;
      }
      case 'named_expression': {
        const name = field(node, 'name');
        if (name?.type === 'identifier') this.bindValue(name.text, field(node, 'value'));
        else if (name) this.bindTargets(name);
        break;
      }
      case 'as_pattern_target':
        this.bindTargets(node);
        return;
      case 'delete_statement':
        for (const c of kids(node)) this.bindTargets(c);
        break;
    }
    for (const c of kids(node)) this.collect(c);
  }

  private safeValue(q: string): boolean {
    return pySafeValue(q);
  }

  private safeCall(q: string): boolean {
    if (PY_SAFE_CALLS.has(q) || safeModuleMember(q)) return true;
    const at = q.lastIndexOf('.');
    const last = q.slice(at + 1);
    return at > 0 && last !== 'replace' && PY_METHODS.has(last) && !PY_MUTATORS.has(last) && this.safeValue(q.slice(0, at)) && q.slice(0, at).includes('.');
  }

  /** `json.dump(obj, fp)` whose `fp`, positional or keyword, is exactly `sys.stdout` or `sys.stderr`, not a name assigned it (GH 2038). */
  private dumpToStream(args: Node | null): boolean {
    const list = args ? kids(args).filter((a) => a.type !== 'comment') : [];
    if (list.some(splat)) return false;
    const kw = list.find((a) => a.type === 'keyword_argument' && field(a, 'name')?.text === 'fp');
    const fp = kw ? field(kw, 'value') : (list.filter((a) => a.type !== 'keyword_argument')[1] ?? null);
    if (!fp || (fp.type !== 'attribute' && fp.type !== 'identifier')) return false;
    const { root, parts } = chain(fp, 'attribute', 'object', 'attribute');
    if (this.binds.assigned(root.text)) return false;
    const q = this.qualified(root, parts);
    return q !== undefined && PY_STREAM_FILES.has(q);
  }

  private qualified(root: Node, parts: string[]): string | undefined {
    if (root.type !== 'identifier') return undefined;
    const b = this.binds.resolve(root.text);
    return b?.kind === 'import' ? [b.q, ...parts].join('.') : undefined;
  }

  private dunder(name: string): boolean {
    return /^__.*__$/.test(name) && !PY_DUNDERS.has(name);
  }

  private name(node: Node): void {
    const name = node.text;
    if (this.dunder(name)) return this.fail();
    const b = this.binds.resolve(name);
    if (b?.kind === 'import') {
      if (!this.safeValue(b.q) && !this.safeCall(b.q)) this.fail();
      else if (PY_SAFE_STREAMS.has(b.q) && !this.contained(node, PY_UNPACKED.has(b.q))) this.fail();
    } else if (b && b.kind !== 'local' && b.kind !== 'def') this.fail();
    else if (!b && PY_BUILTINS.has(name) && (!PY_SAFE_BUILTINS.has(name) || name === 'open')) this.fail();
  }

  private attribute(node: Node): void {
    const { root, parts } = chain(node, 'attribute', 'object', 'attribute');
    if (parts.some((p) => this.dunder(p))) return this.fail();
    const q = this.qualified(root, parts);
    if (q !== undefined) {
      if (!this.safeValue(q) && !this.safeCall(q)) this.fail();
      else if (PY_SAFE_STREAMS.has(q) && !this.contained(node, PY_UNPACKED.has(q))) this.fail();
      return;
    }
    this.visit(root);
  }

  /**
   * Whether a stream at `node` stays where it cannot reach a name the proof
   * takes for a local (GH 2490): the direct base of an attribute or
   * subscript, or, through parentheses, `await`, `or` / `and`, the branches
   * of `a if c else b` and assignments to a plain name, an alias binding, a
   * for iterable, a splat, a comparison operand or a PY_SINKS argument. An
   * iterable stream (`iterable`, PY_UNPACKED) is also the whole right side of
   * an unpacking statement, whose targets bind its elements or a fresh list.
   */
  private contained(node: Node, iterable: boolean): boolean {
    const base = node.parent;
    if ((base?.type === 'attribute' && same(field(base, 'object'), node)) || (base?.type === 'subscript' && same(field(base, 'value'), node))) return true;
    for (let at = node, up = base; up; at = up, up = up.parent) {
      switch (up.type) {
        case 'parenthesized_expression':
        case 'await':
        case 'boolean_operator':
        case 'keyword_argument':
          continue;
        case 'conditional_expression':
          if (same(noComments(up)[1], at)) return false;
          continue;
        case 'assignment':
        case 'named_expression': {
          const assign = up.type === 'assignment';
          if (!same(field(up, assign ? 'right' : 'value'), at)) return false;
          const left = field(up, assign ? 'left' : 'name')?.type ?? '';
          if (assign && iterable && PY_UNPACK.has(left)) return up.parent?.type === 'expression_statement';
          if (left !== 'identifier') return false;
          continue;
        }
        case 'expression_statement':
        case 'list_splat':
        case 'dictionary_splat':
        case 'comparison_operator':
          return true;
        case 'default_parameter':
        case 'typed_default_parameter':
          return same(field(up, 'value'), at) && field(up, 'name')?.type === 'identifier';
        case 'for_statement':
        case 'for_in_clause':
          return same(field(up, 'right'), at);
        case 'argument_list':
          return up.parent?.type === 'call' && this.sink(up.parent, up, at);
        default:
          return false;
      }
    }
    return false;
  }

  /**
   * Whether argument `arg` of `call` goes to a PY_SINKS call, judging a
   * keyword argument like a positional one. A callback
   * (`default=`, `key=`, or a `**` splat that may pass one) is called with
   * what the call reads from its first argument, so with one only a later
   * argument (`fp=sys.stdout`) is a sink. So is the one argument of a
   * string literal's `join` (`" ".join(sys.argv)`).
   */
  private sink(call: Node, args: Node, arg: Node): boolean {
    const fn = field(call, 'function');
    const object = fn?.type === 'attribute' ? field(fn, 'object') : null;
    if ((object?.type === 'string' || object?.type === 'concatenated_string') && field(fn!, 'attribute')?.text === 'join') {
      const list = noComments(args);
      return list.length === 1 && same(list[0], arg);
    }
    let q: string | undefined;
    if (fn?.type === 'identifier') {
      const b = this.binds.resolve(fn.text);
      q = b === undefined ? fn.text : b.kind === 'import' ? b.q : undefined;
    } else if (fn?.type === 'attribute') {
      const { root, parts } = chain(fn, 'attribute', 'object', 'attribute');
      q = this.qualified(root, parts);
    }
    if (q === undefined || !PY_SINKS.has(q)) return false;
    // `dict(k=v)` stores v
    if (q === 'dict' && arg.type === 'keyword_argument') return false;
    const list = noComments(args);
    const back = PY_CALLBACKS[q]?.kw ?? [];
    const hooked = list.some((a) => a.type === 'dictionary_splat' || (a.type === 'keyword_argument' && back.includes(field(a, 'name')?.text ?? '')));
    if (!hooked) return true;
    if (arg.type === 'keyword_argument') return field(arg, 'name')?.text !== 'obj';
    const positional = list.filter((a) => a.type !== 'keyword_argument' && a.type !== 'dictionary_splat');
    const at = positional.findIndex((a) => same(a, arg));
    return at > 0 && positional.slice(0, at).every((a) => a.type !== 'list_splat');
  }

  /** Whether a node in a position the call calls back is a function the proof follows, or a string (re.sub's `repl`; elsewhere a TypeError, not a write). */
  private callback(node: Node): boolean {
    if (node.type === 'lambda' || node.type === 'string' || node.type === 'concatenated_string') return true;
    if (node.type === 'identifier') {
      const b = this.binds.resolve(node.text);
      if (b?.kind === 'def') return true;
      if (b?.kind === 'import') return this.safeCall(b.q);
      if (b) return false;
      return (PY_SAFE_BUILTINS.has(node.text) && node.text !== 'open') || (!PY_BUILTINS.has(node.text) && !this.dunder(node.text));
    }
    if (node.type === 'attribute') {
      const { root, parts } = chain(node, 'attribute', 'object', 'attribute');
      const q = this.qualified(root, parts);
      if (q !== undefined) return this.safeCall(q);
      return root.type === 'identifier' && !this.binds.resolve(root.text) && PY_SAFE_BUILTINS.has(root.text) && parts.length === 1 && PY_METHODS.has(parts[0]);
    }
    return false;
  }

  private openMode(args: Node | null): void {
    const list = args ? kids(args) : [];
    const kw = list.find((a) => a.type === 'keyword_argument' && field(a, 'name')?.text === 'mode');
    const positional = list.filter((a) => a.type !== 'keyword_argument');
    if (list.some(splat)) this.judge(args);
    const mode = kw ? field(kw, 'value') : (positional[1] ?? null);
    if (mode && !PY_READ_MODES.has(pyLiteral(mode) ?? '')) this.judged = true;
  }

  private call(node: Node): void {
    const fn = field(node, 'function');
    const args = field(node, 'arguments');
    let callee: string | undefined;
    if (!fn) return this.fail();
    if (fn.type === 'identifier') {
      const name = fn.text;
      const b = this.binds.resolve(name);
      if (this.dunder(name)) return this.fail();
      if (b?.kind === 'import') {
        callee = b.q;
        if (!this.safeCall(b.q) && !PY_PATH.has(b.q)) {
          if (judgedCall('py', b.q)) this.judge(args);
          else return this.fail();
        }
      } else if (b && b.kind !== 'def') return this.fail();
      else if (!b) {
        if (name === 'open') this.openMode(args);
        else if (PY_SAFE_BUILTINS.has(name)) callee = name;
        else if (PY_BUILTINS.has(name)) return this.fail();
      }
    } else if (fn.type === 'attribute') {
      const { root, parts } = chain(fn, 'attribute', 'object', 'attribute');
      if (parts.some((p) => this.dunder(p))) return this.fail();
      const q = this.qualified(root, parts);
      const last = parts[parts.length - 1];
      if (q !== undefined) {
        callee = q;
        if (!this.safeCall(q) && !PY_PATH.has(q) && !(q === 'json.dump' && this.dumpToStream(args))) {
          if (judgedCall('py', q)) this.judge(args);
          else return this.fail();
        }
      } else {
        this.visit(root);
        const literal = root.type === 'string' && parts.length === 1;
        const pre = root.type === 'identifier' ? [root.text, ...parts.slice(0, -1)].join('.') : '?';
        // dict, list and set copy() take no argument; Path.copy(target) (3.14) writes
        const pathCopy = last === 'copy' && args !== null && kids(args).some((a) => a.type !== 'comment');
        if (last === 'sort') callee = '.sort';
        if (last === 'replace' ? !literal && !strReplace(root, parts, args) : !PY_METHODS.has(last) || pathCopy) {
          if (judgedCall('py', `${pre}.${last}`)) this.judge(args);
          else return this.fail();
        }
      }
    } else return this.fail();
    if (!args) return;
    const back = callee !== undefined ? PY_CALLBACKS[callee] : undefined;
    let pos = 0;
    for (const a of kids(args)) {
      if (a.type === 'keyword_argument') {
        const value = field(a, 'value');
        if (back && value && back.kw.includes(field(a, 'name')?.text ?? '') && !this.callback(value)) this.fail();
        if (value) this.visit(value);
        continue;
      }
      if (back && (a.type === 'list_splat' || a.type === 'dictionary_splat')) this.fail();
      if (back?.pos.includes(pos) && !this.callback(a)) this.fail();
      pos++;
      this.visit(a);
    }
  }

  /** An assignment or `del` target: a name binds, a subscript of a local name is checked, anything else is unproven. */
  private target(node: Node): void {
    switch (node.type) {
      case 'identifier':
        return;
      case 'subscript': {
        const base = field(node, 'value');
        if (base?.type !== 'identifier' || this.binds.resolve(base.text)?.kind !== 'local') return this.fail();
        for (const s of node.childrenForFieldName('subscript')) if (s) this.visit(s);
        return;
      }
      case 'attribute':
        return this.fail();
      default:
        for (const c of kids(node)) this.target(c);
    }
  }

  visit(node: Node): void {
    if (!this.ok) return;
    if (node.isError || node.isMissing || PY_UNPROVEN.has(node.type)) return this.fail();
    switch (node.type) {
      case 'import_statement':
      case 'import_from_statement':
      case 'future_import_statement':
      case 'global_statement':
      case 'nonlocal_statement':
        return;
      case 'identifier':
        return this.name(node);
      case 'attribute':
        return this.attribute(node);
      case 'call':
        return this.call(node);
      case 'interpolation':
        if (node.descendantsOfType('call').length > 0) return this.fail();
        break;
      case 'keyword_argument': {
        const value = field(node, 'value');
        if (value) this.visit(value);
        return;
      }
      case 'assignment':
      case 'augmented_assignment': {
        const left = field(node, 'left');
        // `e |= {…}` / `a += […]` update the object a name holds in place
        if (node.type === 'augmented_assignment' && left?.type === 'identifier' && this.binds.resolve(left.text)?.kind !== 'local') return this.fail();
        if (left) this.target(left);
        for (const f of ['type', 'right']) {
          const c = field(node, f);
          if (c) this.visit(c);
        }
        return;
      }
      case 'for_statement':
      case 'for_in_clause': {
        const left = field(node, 'left');
        if (left) this.target(left);
        for (const c of kids(node)) if (c !== left) this.visit(c);
        return;
      }
      case 'as_pattern_target':
      case 'delete_statement':
        for (const c of kids(node)) this.target(c);
        return;
      case 'named_expression': {
        const value = field(node, 'value');
        if (value) this.visit(value);
        return;
      }
      case 'function_definition': {
        for (const f of ['parameters', 'return_type', 'body']) {
          const c = field(node, f);
          if (c) this.visit(c);
        }
        return;
      }
      case 'default_parameter':
      case 'typed_default_parameter': {
        for (const f of ['type', 'value']) {
          const c = field(node, f);
          if (c) this.visit(c);
        }
        return;
      }
    }
    for (const c of kids(node)) this.visit(c);
  }
}

/** The module a literal `require` loads, or undefined when loading it could run code: a node builtin, or a .json file. */
function requiredModule(node: Node): string | undefined {
  return requiredSource(node)?.mod;
}

/** The module a literal `require` loads and whether it is a .json file, or undefined as for requiredModule. */
function requiredSource(node: Node): { mod: string; json: boolean } | undefined {
  if (node.type !== 'call_expression' || field(node, 'function')?.text !== 'require') return undefined;
  const args = field(node, 'arguments');
  const list = args ? kids(args) : [];
  if (list.length !== 1 || list[0].type !== 'string') return undefined;
  const lit = list[0].text.slice(1, -1);
  if (/[\\'"]/.test(lit)) return undefined;
  const bare = lit.replace(/^node:/, '');
  if (builtinModules.includes(bare)) return { mod: bare, json: false };
  return /^(\.{0,2}\/).*\.json$/.test(lit) ? { mod: lit, json: true } : undefined;
}

class JsProof extends Proof {
  private bindPattern(node: Node, kind: Bind = { kind: 'local' }): void {
    switch (node.type) {
      case 'identifier':
      case 'shorthand_property_identifier_pattern':
        this.binds.add(node.text, kind);
        return;
      case 'member_expression':
      case 'subscript_expression':
        return;
      case 'assignment_pattern':
      case 'object_assignment_pattern': {
        const left = field(node, 'left');
        if (left) this.bindPattern(left);
        if (left?.type === 'identifier' || left?.type === 'shorthand_property_identifier_pattern') this.bindValue(left.text, field(node, 'right'));
        return;
      }
      case 'pair_pattern': {
        const value = field(node, 'value');
        if (value) this.bindPattern(value);
        return;
      }
      default:
        for (const c of kids(node)) this.bindPattern(c);
    }
  }

  /** A name assigned `value`: an import for each require chain it may evaluate to, a ref for each reference chain, a local for anything else. */
  private bindValue(name: string, value: Node | null): void {
    if (!value) return this.binds.add(name, BARE);
    for (const src of jsSources(value)) {
      const mod = this.moduleOf(src);
      this.binds.add(name, mod ? { kind: 'import', q: mod.q, json: mod.json } : (refOf(src, 'member_expression', 'object', 'property') ?? LOCAL));
    }
  }

  /** The module path a declaration's value names: `require('<m>')` or a member chain on one. */
  private moduleOf(value: Node | null): { q: string; json: boolean } | undefined {
    if (!value) return undefined;
    const { root, parts } = chain(value, 'member_expression', 'object', 'property');
    const src = requiredSource(root);
    return src === undefined ? undefined : { q: [src.mod, ...parts].join('.'), json: src.json };
  }

  collect(node: Node): void {
    switch (node.type) {
      case 'variable_declarator': {
        const name = field(node, 'name');
        const value = field(node, 'value');
        const mod = this.moduleOf(value);
        if (!name) break;
        if (mod !== undefined && name.type === 'object_pattern') {
          for (const p of kids(name)) {
            if (p.type === 'shorthand_property_identifier_pattern') this.binds.add(p.text, { kind: 'import', q: `${mod.q}.${p.text}`, json: mod.json });
            else if (p.type === 'pair_pattern' && field(p, 'value')?.type === 'identifier' && field(p, 'key')?.type === 'property_identifier') {
              this.binds.add(field(p, 'value')!.text, { kind: 'import', q: `${mod.q}.${field(p, 'key')!.text}`, json: mod.json });
            } else this.bindPattern(p);
          }
        } else if (name.type === 'identifier' && (value?.type === 'arrow_function' || value?.type === 'function_expression' || value?.type === 'function')) {
          this.binds.add(name.text, { kind: 'def' });
        } else if (name.type === 'identifier') this.bindValue(name.text, value);
        else this.bindPattern(name);
        break;
      }
      case 'function_declaration':
      case 'generator_function_declaration': {
        const name = field(node, 'name');
        if (name) this.binds.add(name.text, { kind: 'def' });
        break;
      }
      case 'formal_parameters':
        for (const c of kids(node)) this.bindPattern(c);
        break;
      case 'arrow_function': {
        const param = field(node, 'parameter');
        if (param) this.bindPattern(param);
        break;
      }
      case 'assignment_expression':
      case 'augmented_assignment_expression': {
        const left = field(node, 'left');
        if (left?.type === 'identifier') this.bindValue(left.text, node.type === 'assignment_expression' ? field(node, 'right') : node);
        else if (left) this.bindPattern(left);
        break;
      }
      case 'for_in_statement': {
        const left = field(node, 'left');
        if (left) this.bindPattern(left);
        break;
      }
      case 'update_expression': {
        const arg = field(node, 'argument');
        if (arg) this.bindPattern(arg);
        break;
      }
      case 'catch_clause': {
        const param = field(node, 'parameter');
        if (param) this.bindPattern(param);
        break;
      }
    }
    for (const c of kids(node)) this.collect(c);
  }

  private safeCall(q: string): boolean {
    if (JS_SAFE_CALLS.has(q) || JS_SAFE_ROOT_CALL.test(q)) return true;
    const at = q.lastIndexOf('.');
    const last = q.slice(at + 1);
    return at > 0 && JS_METHODS.has(last) && !JS_MUTATORS.has(last) && JS_SAFE_VALUE.test(q.slice(0, at));
  }

  /** The dotted name of a chain rooted at a module alias, a literal require or a known global. */
  private qualified(root: Node, parts: string[]): string | undefined {
    const mod = requiredModule(root);
    if (mod !== undefined) return [mod, ...parts].join('.');
    if (root.type !== 'identifier') return undefined;
    const b = this.binds.resolve(root.text);
    if (b?.kind === 'import' || b?.kind === 'alias') return [b.q, ...parts].join('.');
    if (!b && JS_ROOTS.has(root.text)) return [root.text, ...parts].join('.');
    return undefined;
  }

  private name(node: Node): void {
    const b = this.binds.resolve(node.text);
    if (b?.kind === 'import' && b.json !== true) this.fail();
    else if (b?.kind === 'alias' && !(b.q.includes('.') ? this.safeMember(b.q) : JS_SAFE_GLOBALS.has(b.q))) this.fail();
    else if (b?.kind === 'alias' && JS_ESCAPE.test(b.q) && !this.contained(node, JS_UNPACKED.test(b.q))) this.fail();
    else if (b?.kind === 'mixed') this.fail();
    else if (!b && !JS_SAFE_GLOBALS.has(node.text)) this.fail();
  }

  /** Whether a dotted name read as a value is safe: a process value, a safe call, a member of a safe global, or a required .json. */
  private safeMember(q: string): boolean {
    return JS_SAFE_VALUE.test(q) || this.safeCall(q) || /^(console|JSON|Math|Object|Array|String|Number)\./.test(q) || /\.json(\.|$)/.test(q);
  }

  private member(node: Node): void {
    const { root, parts } = chain(node, 'member_expression', 'object', 'property');
    if (parts.some((p) => JS_HIDDEN.has(p))) return this.fail();
    const q = this.qualified(root, parts);
    if (q !== undefined) {
      if (root.type === 'call_expression') this.visit(root);
      if (!this.safeMember(q)) this.fail();
      else if (JS_ESCAPE.test(q) && !this.contained(node, JS_UNPACKED.test(q))) this.fail();
      return;
    }
    this.visit(root);
  }

  /**
   * Whether a process object at `node` stays where it cannot reach a name the
   * proof takes for a local (GH 2490): the direct object of a member or
   * subscript, or, through parentheses, `await`, a sequence's last value,
   * the branches of `c ? a : b`, `||` / `&&` / `??` and assignments to a
   * plain name, an alias binding, a for iterable, a spread, a comparison
   * operand or a JS_SINKS / `console.*` argument. process.env and
   * process.argv (`iterable`) are also the whole value of a destructuring
   * declaration, whose targets bind strings or a fresh copy.
   */
  private contained(node: Node, iterable: boolean): boolean {
    const base = node.parent;
    if ((base?.type === 'member_expression' || base?.type === 'subscript_expression') && same(field(base, 'object'), node)) return true;
    for (let at = node, up = base; up; at = up, up = up.parent) {
      switch (up.type) {
        case 'parenthesized_expression':
        case 'await_expression':
          continue;
        case 'sequence_expression':
          if (!same(noComments(up).at(-1), at)) return false;
          continue;
        case 'ternary_expression':
          if (same(field(up, 'condition'), at)) return false;
          continue;
        case 'binary_expression': {
          const op = field(up, 'operator')?.text ?? '';
          if (JS_COMPARE.has(op)) return true;
          if (!JS_LOGICAL.has(op)) return false;
          continue;
        }
        case 'assignment_expression':
        case 'augmented_assignment_expression': {
          const logical = up.type === 'assignment_expression' || JS_LOGICAL.has(field(up, 'operator')?.text ?? '');
          if (!logical || !same(field(up, 'right'), at) || field(up, 'left')?.type !== 'identifier') return false;
          continue;
        }
        case 'expression_statement':
        case 'spread_element':
          return true;
        case 'variable_declarator': {
          const name = field(up, 'name')?.type;
          return same(field(up, 'value'), at) && (name === 'identifier' || (iterable && (name === 'object_pattern' || name === 'array_pattern')));
        }
        case 'assignment_pattern':
        case 'object_assignment_pattern': {
          const left = field(up, 'left');
          return same(field(up, 'right'), at) && (left?.type === 'identifier' || left?.type === 'shorthand_property_identifier_pattern');
        }
        case 'for_in_statement':
          return same(field(up, 'right'), at);
        case 'arguments':
          return up.parent?.type === 'call_expression' && this.sink(up.parent, at);
        default:
          return false;
      }
    }
    return false;
  }

  /** Whether `arg` of `call` goes to a sink: `console.*`, JSON.stringify with no replacer function, Object.keys / values / entries, or Object.assign past its target. */
  private sink(call: Node, arg: Node): boolean {
    const fn = field(call, 'function');
    let q: string | undefined;
    if (fn?.type === 'identifier') {
      const b = this.binds.resolve(fn.text);
      q = b === undefined ? fn.text : b.kind === 'import' || b.kind === 'alias' ? b.q : undefined;
    } else if (fn?.type === 'member_expression') {
      const { root, parts } = chain(fn, 'member_expression', 'object', 'property');
      q = this.qualified(root, parts);
    }
    const args = field(call, 'arguments');
    const list = args ? noComments(args) : [];
    const at = list.findIndex((a) => same(a, arg));
    if (q === undefined || at < 0 || list.some((a) => a.type === 'spread_element')) return false;
    if (/^console\.[A-Za-z]+$/.test(q)) return true;
    if (q === 'Object.assign') return at > 0;
    // a replacer function is called with the value itself first
    if (q === 'JSON.stringify') return at === 0 && (list.length === 1 || ['null', 'undefined', 'array'].includes(list[1].type));
    return JS_SINKS.has(q);
  }

  private callback(node: Node): boolean {
    if (node.type === 'arrow_function' || node.type === 'function_expression' || node.type === 'function') return true;
    if (node.type === 'identifier') {
      const b = this.binds.resolve(node.text);
      if (b?.kind === 'def') return true;
      if (b?.kind === 'alias') return this.safeCall(b.q);
      return !b && JS_SAFE_GLOBAL_CALLS.has(node.text);
    }
    if (node.type === 'member_expression') {
      const { root, parts } = chain(node, 'member_expression', 'object', 'property');
      const q = this.qualified(root, parts);
      return q !== undefined && this.safeCall(q);
    }
    return false;
  }

  /** A member assignment, update or delete target: only a property of a local name. */
  private target(node: Node): void {
    if (node.type !== 'member_expression' && node.type !== 'subscript_expression') return this.visit(node);
    let root = node;
    while (root.type === 'member_expression' || root.type === 'subscript_expression') root = field(root, 'object') ?? root;
    if (root.type !== 'identifier' || this.binds.resolve(root.text)?.kind !== 'local') return this.fail();
    for (const c of kids(node)) this.visit(c);
  }

  private call(node: Node): void {
    const fn = field(node, 'function');
    const args = field(node, 'arguments');
    if (!fn) return this.fail();
    let callee: string | undefined;
    let method = '';
    if (fn.type === 'identifier') {
      const name = fn.text;
      const b = this.binds.resolve(name);
      if (name === 'require' && !b) {
        if (requiredModule(node) === undefined) this.fail();
        return;
      }
      if (b?.kind === 'import' || b?.kind === 'alias') {
        callee = b.q;
        if (!this.safeCall(b.q)) {
          if (judgedCall('node', b.q)) this.judged = true;
          else return this.fail();
        }
      } else if (b && b.kind !== 'def') return this.fail();
      else if (!b) {
        if (JS_SAFE_GLOBAL_CALLS.has(name)) callee = name;
        else if (judgedCall('node', name)) this.judged = true;
        else return this.fail();
      }
    } else if (fn.type === 'member_expression') {
      const { root, parts } = chain(fn, 'member_expression', 'object', 'property');
      if (parts.some((p) => JS_HIDDEN.has(p))) return this.fail();
      const q = this.qualified(root, parts);
      method = parts[parts.length - 1];
      if (q !== undefined) {
        if (root.type === 'call_expression') this.visit(root);
        callee = q;
        if (!this.safeCall(q)) {
          if (judgedCall('node', q)) this.judged = true;
          else return this.fail();
        }
      } else {
        this.visit(root);
        const pre = root.type === 'identifier' ? [root.text, ...parts.slice(0, -1)].join('.') : '?()';
        if (!JS_METHODS.has(method)) {
          if (judgedCall('node', `${pre}.${method}`)) this.judged = true;
          else return this.fail();
        }
      }
    } else return this.fail();
    if (!args) return;
    const list = args.type === 'template_string' ? [args] : kids(args);
    const at =
      callee === 'JSON.parse' || callee === 'JSON.stringify' || method === 'replace' || method === 'replaceAll'
        ? 1
        : JS_CALLBACK_METHODS.has(method)
          ? 0
          : -1;
    if (at >= 0 && list.some((a) => a.type === 'spread_element')) this.fail();
    list.forEach((a, i) => {
      if (i === at && !this.callback(a) && !(method.startsWith('replace') && a.type !== 'arrow_function' && a.type !== 'identifier' && a.type !== 'member_expression' && a.type !== 'function_expression' && a.type !== 'call_expression' && a.type !== 'subscript_expression')) this.fail();
      this.visit(a);
    });
  }

  visit(node: Node): void {
    if (!this.ok) return;
    if (node.isError || node.isMissing || JS_UNPROVEN.has(node.type)) return this.fail();
    switch (node.type) {
      case 'identifier':
        return this.name(node);
      case 'shorthand_property_identifier':
        return this.name(node);
      case 'property_identifier':
      case 'shorthand_property_identifier_pattern':
      case 'statement_identifier':
        return;
      case 'member_expression':
        return this.member(node);
      case 'call_expression':
        return this.call(node);
      case 'new_expression': {
        const ctor = field(node, 'constructor');
        if (ctor?.type !== 'identifier' || this.binds.resolve(ctor.text) || !JS_NEW.has(ctor.text)) return this.fail();
        const args = field(node, 'arguments');
        if (args) this.visit(args);
        return;
      }
      case 'variable_declarator': {
        const value = field(node, 'value');
        if (value) this.visit(value);
        const name = field(node, 'name');
        if (name && name.type !== 'identifier') this.pattern(name);
        return;
      }
      case 'assignment_expression':
      case 'augmented_assignment_expression': {
        const left = field(node, 'left');
        if (left?.type === 'object_pattern' || left?.type === 'array_pattern') this.pattern(left);
        else if (left && left.type !== 'identifier') this.target(left);
        const right = field(node, 'right');
        if (right) this.visit(right);
        return;
      }
      case 'update_expression': {
        const arg = field(node, 'argument');
        if (arg && arg.type !== 'identifier') this.target(arg);
        return;
      }
      case 'unary_expression': {
        const arg = field(node, 'argument');
        if (node.child(0)?.type === 'delete' && arg) return this.target(arg);
        break;
      }
      case 'for_in_statement': {
        const left = field(node, 'left');
        if (left && (left.type === 'member_expression' || left.type === 'subscript_expression')) this.target(left);
        for (const c of kids(node)) if (c !== left) this.visit(c);
        return;
      }
      case 'pair': {
        const key = field(node, 'key');
        if (key?.type === 'computed_property_name') this.visit(key);
        const value = field(node, 'value');
        if (value) this.visit(value);
        return;
      }
      case 'formal_parameters':
        return this.pattern(node);
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'function_expression':
      case 'function':
      case 'arrow_function': {
        for (const f of ['parameters', 'body']) {
          const c = field(node, f);
          if (c) this.visit(c);
        }
        return;
      }
      case 'catch_clause': {
        const body = field(node, 'body');
        if (body) this.visit(body);
        return;
      }
    }
    for (const c of kids(node)) this.visit(c);
  }

  /** A binding pattern: only its default values and computed keys are evaluated. */
  private pattern(node: Node): void {
    switch (node.type) {
      case 'identifier':
      case 'shorthand_property_identifier_pattern':
        return;
      case 'assignment_pattern':
      case 'object_assignment_pattern': {
        const left = field(node, 'left');
        const right = field(node, 'right');
        if (left) this.pattern(left);
        if (right) this.visit(right);
        return;
      }
      case 'pair_pattern': {
        const key = field(node, 'key');
        if (key?.type === 'computed_property_name') this.visit(key);
        const value = field(node, 'value');
        if (value) this.pattern(value);
        return;
      }
      case 'member_expression':
      case 'subscript_expression':
        return this.target(node);
      default:
        for (const c of kids(node)) this.pattern(c);
    }
  }
}

const QUOTE_LIKE = /^(q|qq|qw|qr|m|s|tr|y)$/;
const CLOSER: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };

interface Token {
  t: 'w' | 'v' | 'p' | 'lit' | 'sym';
  text: string;
}

/** The end of a delimited part starting past `open` at `i`, nesting a bracket pair; -1 when unclosed. */
function delimited(src: string, i: number, open: string): number {
  const close = CLOSER[open] ?? open;
  let depth = 1;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (c === '\\') k++;
    else if (c === close && --depth === 0) return k;
    else if (c === open && close !== open) depth++;
  }
  return -1;
}

/** Whether interpolated text (a string, a regex) can run code: perl `@{…}` / `${…}` / `(?{…})`, ruby `#{…}`. */
function runsCode(perl: boolean, body: string): boolean {
  return perl ? /[@$]\{|\(\?\??\{/.test(body) : /#\{|\(\?\??\{/.test(body);
}

/** The tokens of a perl or ruby program, or undefined when it holds a form that runs code the lexer cannot follow. */
function lexScript(perl: boolean, src: string): Token[] | undefined {
  const out: Token[] = [];
  const termPos = (): boolean => {
    const prev = out[out.length - 1];
    if (!prev) return true;
    if (prev.t === 'w') return true;
    if (prev.t === 'p') return !/^[)\]}]$/.test(prev.text);
    return false;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const rest = src.slice(i);
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '#') {
      const e = src.indexOf('\n', i);
      i = e < 0 ? src.length : e;
      continue;
    }
    if (c === '`') return undefined;
    if (c === "'" || c === '"') {
      const e = delimited(src, i + 1, c);
      if (e < 0) return undefined;
      if (c === '"' && runsCode(perl, src.slice(i + 1, e))) return undefined;
      out.push({ t: 'lit', text: src.slice(i, e + 1) });
      i = e + 1;
      continue;
    }
    if (perl && (c === '$' || c === '@' || c === '%')) {
      const m = /^[$@%]#?(\$*)([A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*|\^[A-Z]|[0-9]+|[^\sA-Za-z0-9_{])/.exec(rest);
      if (m && (c !== '%' || termPos())) {
        out.push({ t: 'v', text: m[0] });
        i += m[0].length;
        continue;
      }
    }
    if (!perl && (c === '$' || c === '@')) {
      const m = /^(@@?|\$)([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[^\sA-Za-z0-9_{])/.exec(rest);
      if (m) {
        out.push({ t: 'v', text: m[0] });
        i += m[0].length;
        continue;
      }
    }
    if (!perl && c === '%' && termPos()) {
      const m = /^%([qQwWiIrsx]?)([^\sA-Za-z0-9_])/.exec(rest);
      if (m) {
        if (m[1] === 'x') return undefined;
        const e = delimited(src, i + m[0].length, m[2]);
        if (e < 0) return undefined;
        if (/^[QWIr]?$/.test(m[1]) && runsCode(false, src.slice(i + m[0].length, e))) return undefined;
        out.push({ t: 'lit', text: src.slice(i, e + 1) });
        i = e + 1;
        continue;
      }
    }
    if (!perl && c === ':' && src[i + 1] !== ':' && src[i - 1] !== ':') {
      const m = /^:([A-Za-z_][A-Za-z0-9_]*[?!=]?)/.exec(rest);
      if (m) {
        out.push({ t: 'sym', text: m[1] });
        i += m[0].length;
        continue;
      }
      if (src[i + 1] === '"' || src[i + 1] === "'") {
        i++;
        continue;
      }
    }
    if (/[0-9]/.test(c)) {
      i += /^[0-9][A-Za-z0-9_]*(\.[0-9][A-Za-z0-9_]*)*/.exec(rest)![0].length;
      out.push({ t: 'lit', text: '0' });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*[?!]?/.exec(rest)![0];
      const after = src.slice(i + word.length);
      if (perl && QUOTE_LIKE.test(word) && /^\s*[^\sA-Za-z0-9_,;)=]/.test(after) && !/^\s*=>/.test(after)) {
        if (word === 'qx') return undefined;
        let k = i + word.length;
        while (/\s/.test(src[k] ?? '')) k++;
        const open = src[k];
        let e = delimited(src, k + 1, open);
        if (e < 0) return undefined;
        let body = src.slice(k + 1, e);
        if (word === 's' || word === 'tr' || word === 'y') {
          if (CLOSER[open]) {
            k = e + 1;
            while (/\s/.test(src[k] ?? '')) k++;
            const second = src[k];
            const e2 = delimited(src, k + 1, second);
            if (e2 < 0) return undefined;
            body += src.slice(k + 1, e2);
            e = e2;
          } else {
            const e2 = delimited(src, e + 1, open);
            if (e2 < 0) return undefined;
            body += src.slice(e + 1, e2);
            e = e2;
          }
        }
        const flags = /^[A-Za-z]*/.exec(src.slice(e + 1))![0];
        if (word === 's' && flags.includes('e')) return undefined;
        if (word !== 'q' && word !== 'qw' && word !== 'tr' && word !== 'y' && runsCode(true, body)) return undefined;
        out.push({ t: 'lit', text: src.slice(i, e + 1 + flags.length) });
        i = e + 1 + flags.length;
        continue;
      }
      if (perl && (word === '__END__' || word === '__DATA__')) break;
      out.push({ t: 'w', text: word });
      i += word.length;
      continue;
    }
    if (c === '/' && termPos()) {
      const e = delimited(src, i + 1, '/');
      if (e < 0) return undefined;
      if (runsCode(perl, src.slice(i + 1, e))) return undefined;
      const flags = /^[A-Za-z]*/.exec(src.slice(e + 1))![0];
      out.push({ t: 'lit', text: src.slice(i, e + 1 + flags.length) });
      i = e + 1 + flags.length;
      continue;
    }
    if (perl && c === '<' && termPos()) {
      const m = /^<(\$?[A-Za-z_][A-Za-z0-9_]*)?>/.exec(rest);
      if (m) {
        out.push({ t: 'lit', text: m[0] });
        i += m[0].length;
        continue;
      }
    }
    const op = /^(&&|&\.|->|=>|::|\|\||==|=~|!~|\.\(|.)/s.exec(rest)![0];
    out.push({ t: 'p', text: op });
    i += op.length;
  }
  return out;
}

const member = (t: Token | undefined): boolean => t?.t === 'p' && (t.text === '.' || t.text === '::');

const SLEEP_SELECT: readonly Token[] = [
  { t: 'w', text: 'select' }, { t: 'p', text: '(' },
  { t: 'w', text: 'undef' }, { t: 'p', text: ',' },
  { t: 'w', text: 'undef' }, { t: 'p', text: ',' },
  { t: 'w', text: 'undef' }, { t: 'p', text: ',' },
];

/** The token count of perl's 4-argument sleep `select(undef,undef,undef,<number or $scalar>)` at `k`, or 0 for any other form. */
function perlSleepSelect(toks: readonly Token[], k: number): number {
  if (toks[k - 1]?.text === '->') return 0;
  if (!SLEEP_SELECT.every((s, j) => toks[k + j]?.t === s.t && toks[k + j].text === s.text)) return 0;
  const wait = toks[k + SLEEP_SELECT.length];
  const numeric = wait?.t === 'lit' && wait.text === '0';
  const scalar = wait?.t === 'v' && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(wait.text);
  if (!(numeric || scalar) || toks[k + SLEEP_SELECT.length + 1]?.text !== ')') return 0;
  return SLEEP_SELECT.length + 2;
}

// A plain path, neither a mode prefix (`>`, `+<`, `<&`), a pipe (`|cmd`, `cmd|`), `-` (stdin) nor text interpolation or escapes could turn into one.
const PERL_READ_PATH = /^\s*<?\s*[A-Za-z0-9_./~][^|<>&$@\\\n]*$/;

/** The token count of perl's 2-argument read `open(F, "path")` / `open(my $f, "path")` at `k`, or 0 for any other form (GH 2024). */
function perlReadOpen(toks: readonly Token[], k: number): number {
  if (toks[k - 1]?.text === '->' || toks[k].text !== 'open' || toks[k + 1]?.text !== '(') return 0;
  let j = k + 2;
  if (toks[j]?.t === 'w' && toks[j].text === 'my') j++;
  const handle = toks[j];
  const bareword = handle?.t === 'w' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(handle.text);
  if (!(bareword || (handle?.t === 'v' && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(handle.text)))) return 0;
  const path = toks[j + 2];
  if (toks[j + 1]?.text !== ',' || path?.t !== 'lit' || !/^(['"]).*\1$/s.test(path.text) || toks[j + 3]?.text !== ')') return 0;
  return PERL_READ_PATH.test(path.text.slice(1, -1)) ? j + 4 - k : 0;
}

/** perl / ruby: every bareword, method name and `&:symbol` is in the allowlist, a judged write, a ruby local, a ruby constant receiver or a hash key. */
function proveScript(lang: Lang, src: string): { ok: boolean; judged: boolean } {
  const perl = lang === 'perl';
  const fail = { ok: false, judged: false };
  const toks = lexScript(perl, src);
  if (!toks) return fail;
  let judged = false;
  const locals = new Set<string>();
  if (!perl) {
    toks.forEach((tk, k) => {
      const next = toks[k + 1];
      if (tk.t === 'w' && next?.t === 'p' && next.text === '=' && toks[k - 1]?.text !== '.') locals.add(tk.text);
    });
    let inPipes = false;
    toks.forEach((tk, k) => {
      if (tk.t === 'p' && tk.text === '|' && (inPipes || toks[k - 1]?.text === '{' || toks[k - 1]?.text === 'do')) inPipes = !inPipes;
      else if (inPipes && tk.t === 'w') locals.add(tk.text);
    });
  }
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    const prev = toks[k - 1];
    const next = toks[k + 1];
    if (tk.t === 'p') {
      if (tk.text === '&' && !(!perl && next?.t === 'sym')) return fail;
      if (tk.text === '.(' || tk.text === '&.' || (tk.text === '->' && (!perl || next?.text === '(' || next?.t === 'v'))) return fail;
      continue;
    }
    if (tk.t === 'v') {
      if (/^[$@]ARGV$/.test(tk.text)) {
        let j = k + 1;
        if (toks[j]?.text === '[' || toks[j]?.text === '{') {
          let depth = 0;
          for (; j < toks.length; j++) {
            if (toks[j].text === '[' || toks[j].text === '{') depth++;
            else if ((toks[j].text === ']' || toks[j].text === '}') && --depth === 0) break;
          }
          j++;
        }
        if (toks[j]?.text === '=' || (toks[j]?.t === 'p' && /^[.+\-*/x|&^]$/.test(toks[j].text) && toks[j + 1]?.text === '=')) return fail;
      }
      continue;
    }
    if (tk.t === 'lit' || (tk.t === 'sym' && prev?.text !== '&')) continue;
    const name = tk.text;
    if (tk.t === 'w' && next?.text === '=>') continue;
    if (tk.t === 'w' && prev?.text === '{' && next?.text === '}') continue;
    if (!perl && tk.t === 'w' && next?.text === ':') continue;
    if (!perl && tk.t === 'w' && locals.has(name) && !member(prev)) continue;
    if (!perl && tk.t === 'w' && /^[A-Z]/.test(name) && member(next) && toks[k + 2]?.t === 'w') continue;
    if (!perl && name === 'ARGV' && next?.text === '[') {
      let j = k + 1;
      let depth = 0;
      for (; j < toks.length; j++) {
        if (toks[j].text === '[') depth++;
        else if (toks[j].text === ']' && --depth === 0) break;
      }
      if (toks[j + 1]?.text === '=') return fail;
    }
    if (SCRIPT_WORDS.has(name)) continue;
    const safeForm = perl ? perlSleepSelect(toks, k) || perlReadOpen(toks, k) : 0;
    if (safeForm) {
      k += safeForm - 1;
      continue;
    }
    let dotted = name;
    for (let j = k; !perl && member(toks[j - 1]) && toks[j - 2]?.t === 'w'; j -= 2) dotted = `${toks[j - 2].text}.${dotted}`;
    if (!judgedCall(lang, dotted.replace(/::/g, '.'))) return fail;
    judged = true;
  }
  return { ok: true, judged };
}

export interface ProgramProof {
  /** Every call of the program is judged or safe. */
  proven: boolean;
  /** It makes a judged write call the scanner names no target for (`open(*a)`, `open(**k)`), so the scan's targets are not complete. */
  blind: boolean;
}

/** Whether every call of `program` is judged or safe; `scanned` holds the scanner's lines for the W guard. */
export function proveProgram(lang: Lang, program: string, scanned: readonly string[]): ProgramProof {
  const no: ProgramProof = { proven: false, blind: false };
  if (lang === 'perl' || lang === 'ruby') {
    const proof = proveScript(lang, program);
    return { proven: proof.ok && (!proof.judged || scanned.includes('W')), blind: false };
  }
  const parser = programParser(lang === 'py' ? 'python' : 'javascript');
  if (!parser) return no;
  const tree = parser.parse(program);
  if (!tree) return no;
  try {
    const root = tree.rootNode;
    if (root.hasError) return no;
    const proof = lang === 'py' ? new PyProof() : new JsProof(JS_ROOTS);
    proof.collect(root);
    if (proof.ok) proof.visit(root);
    return { proven: proof.ok && (!proof.judged || scanned.includes('W')), blind: proof.blind };
  } finally {
    tree.delete();
  }
}
