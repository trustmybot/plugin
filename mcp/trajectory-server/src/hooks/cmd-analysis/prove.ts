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
 * otherwise; calling a local is unproven. A judged write call with no `W`
 * line from the scanner is unproven too. A grammar not loaded yet leaves the
 * program unproven for this pass and is loaded before the command is analyzed
 * again (index.ts). perl and ruby are lexed against an identifier allowlist,
 * judged writes included.
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
  'readlines', 'format', 'count', 'find', 'append', 'extend', 'write', 'writelines', 'close', 'flush',
]);
const PY_DUNDERS = new Set(['__name__', '__file__', '__doc__']);
const PY_UNPROVEN = new Set([
  'class_definition', 'decorated_definition', 'decorator', 'exec_statement', 'print_statement', 'match_statement',
  'wildcard_import', 'relative_import', 'type_alias_statement',
]);
const JSON_HOOKS = ['object_hook', 'object_pairs_hook', 'parse_float', 'parse_int', 'parse_constant', 'cls', 'default'];
/** The argument positions and keywords of a safe call that it calls back. */
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
  'collections.defaultdict': { pos: [0], kw: ['default_factory'] },
  'itertools.accumulate': { pos: [1], kw: ['func'] },
  'itertools.starmap': { pos: [0], kw: [] },
  'itertools.filterfalse': { pos: [0], kw: [] },
  'itertools.takewhile': { pos: [0], kw: [] },
  'itertools.dropwhile': { pos: [0], kw: [] },
  'itertools.groupby': { pos: [1], kw: ['key'] },
};

const JS_SAFE_GLOBAL_CALLS = new Set(['parseInt', 'parseFloat', 'Number', 'String']);
const JS_SAFE_GLOBALS = new Set([
  ...JS_SAFE_GLOBAL_CALLS, 'console', 'JSON', 'Math', 'Object', 'Array', 'undefined', 'NaN', 'Infinity', 'Map', 'Set', 'Date', 'RegExp', 'Error',
]);
const JS_NEW = new Set(['Map', 'Set', 'Array', 'Date', 'RegExp', 'Error']);
const JS_ROOTS = new Set(['console', 'JSON', 'Math', 'Object', 'process', 'Array', 'String', 'Number']);
const JS_SAFE_CALLS = new Set([
  'Object.keys', 'Object.values', 'Object.entries', 'fs.readFileSync', 'fs.existsSync', 'fs.readdirSync', 'fs.statSync',
  'process.stdout.write', 'process.stderr.write',
]);
const JS_SAFE_ROOT_CALL = /^(console|JSON|Math)\./;
const JS_SAFE_VALUE = /^process\.(argv|env|stdout|stderr|version|versions|platform|arch)(\.|$)/;
const JS_METHODS = new Set([
  'at', 'concat', 'entries', 'every', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flat', 'flatMap', 'forEach',
  'includes', 'indexOf', 'join', 'keys', 'lastIndexOf', 'map', 'reduce', 'reduceRight', 'slice', 'some', 'values', 'toSorted',
  'toReversed', 'toString', 'charAt', 'charCodeAt', 'codePointAt', 'endsWith', 'localeCompare', 'match', 'matchAll',
  'normalize', 'padEnd', 'padStart', 'repeat', 'replace', 'replaceAll', 'search', 'split', 'startsWith', 'substring',
  'toLowerCase', 'toUpperCase', 'trim', 'trimEnd', 'trimStart', 'write', 'end', 'close',
]);
const JS_CALLBACK_METHODS = new Set([
  'every', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flatMap', 'forEach', 'map', 'reduce', 'reduceRight', 'some', 'toSorted',
]);
const JS_UNPROVEN = new Set(['class_declaration', 'class', 'import_statement', 'export_statement', 'with_statement', 'import']);
const JS_HIDDEN = new Set(['__proto__', 'constructor', 'prototype', '__defineGetter__', '__defineSetter__']);

const SCRIPT_WORDS = new Set([
  'print', 'printf', 'say', 'puts', 'p', 'split', 'join', 'chomp', 'chop', 'lc', 'uc', 'length', 'substr', 'sprintf', 'sort',
  'keys', 'values', 'reverse', 'map', 'grep', 'my', 'our', 'if', 'unless', 'for', 'foreach', 'while', 'ARGV',
  'upcase', 'downcase', 'STDIN', 'STDOUT', 'STDERR',
  'else', 'elsif', 'until', 'and', 'or', 'not', 'xor', 'eq', 'ne', 'lt', 'gt', 'le', 'ge', 'cmp', 'x', 'last', 'next',
  'do', 'end', 'then', 'nil', 'true', 'false', 'in', 'BEGIN', 'END', 'write', 'close',
]);

type Bind = { kind: 'import'; q: string } | { kind: 'def' } | { kind: 'local' };

/** The names a program binds: every binding of each, merged by `resolve`. */
class Bindings {
  private readonly map = new Map<string, Bind[]>();

  add(name: string, bind: Bind): void {
    const list = this.map.get(name);
    if (list) list.push(bind);
    else this.map.set(name, [bind]);
  }

  resolve(name: string): Bind | undefined {
    const list = this.map.get(name);
    if (!list) return undefined;
    if (list.every((b) => b.kind === 'import' && b.q === (list[0] as { q: string }).q)) return list[0];
    if (list.every((b) => b.kind === 'def')) return list[0];
    return { kind: 'local' };
  }
}

const kids = (node: Node): Node[] => node.namedChildren.filter((c): c is Node => c !== null);
const field = (node: Node, name: string): Node | null => node.childForFieldName(name);

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

class Proof {
  readonly binds = new Bindings();
  ok = true;
  judged = false;

  fail(): void {
    this.ok = false;
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

  private bindParams(node: Node): void {
    for (const p of kids(node)) {
      if (p.type === 'identifier') this.binds.add(p.text, { kind: 'local' });
      else if (p.type === 'default_parameter' || p.type === 'typed_default_parameter') {
        const name = field(p, 'name');
        if (name) this.bindTargets(name);
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
        if (name) this.bindTargets(name);
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
    return at > 0 && last !== 'replace' && PY_METHODS.has(last) && this.safeValue(q.slice(0, at)) && q.slice(0, at).includes('.');
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
    } else if (!b && PY_BUILTINS.has(name) && (!PY_SAFE_BUILTINS.has(name) || name === 'open')) this.fail();
  }

  private attribute(node: Node): void {
    const { root, parts } = chain(node, 'attribute', 'object', 'attribute');
    if (parts.some((p) => this.dunder(p))) return this.fail();
    const q = this.qualified(root, parts);
    if (q !== undefined) {
      if (!this.safeValue(q) && !this.safeCall(q)) this.fail();
      return;
    }
    this.visit(root);
  }

  /** Whether a node in a position the call calls back is a function the proof follows. */
  private callback(node: Node): boolean {
    if (node.type === 'lambda') return true;
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
    if (list.some((a) => a.type === 'list_splat' || a.type === 'dictionary_splat')) this.judged = true;
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
          if (judgedCall('py', b.q)) this.judged = true;
          else return this.fail();
        }
      } else if (b?.kind === 'local') return this.fail();
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
        if (!this.safeCall(q) && !PY_PATH.has(q)) {
          if (judgedCall('py', q)) this.judged = true;
          else return this.fail();
        }
      } else {
        this.visit(root);
        const literal = root.type === 'string' && parts.length === 1;
        const pre = root.type === 'identifier' ? [root.text, ...parts.slice(0, -1)].join('.') : '?';
        if (last === 'replace' ? !literal : !PY_METHODS.has(last)) {
          if (judgedCall('py', `${pre}.${last}`)) this.judged = true;
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
      case 'keyword_argument': {
        const value = field(node, 'value');
        if (value) this.visit(value);
        return;
      }
      case 'assignment':
      case 'augmented_assignment': {
        const left = field(node, 'left');
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
  if (node.type !== 'call_expression' || field(node, 'function')?.text !== 'require') return undefined;
  const args = field(node, 'arguments');
  const list = args ? kids(args) : [];
  if (list.length !== 1 || list[0].type !== 'string') return undefined;
  const lit = list[0].text.slice(1, -1);
  if (/[\\'"]/.test(lit)) return undefined;
  const bare = lit.replace(/^node:/, '');
  if (builtinModules.includes(bare)) return bare;
  return /^(\.{0,2}\/).*\.json$/.test(lit) ? lit : undefined;
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
      case 'assignment_pattern': {
        const left = field(node, 'left');
        if (left) this.bindPattern(left);
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

  /** The module path a declaration's value names: `require('<m>')` or a member chain on one. */
  private moduleOf(value: Node | null): string | undefined {
    if (!value) return undefined;
    const { root, parts } = chain(value, 'member_expression', 'object', 'property');
    const mod = requiredModule(root);
    return mod === undefined ? undefined : [mod, ...parts].join('.');
  }

  collect(node: Node): void {
    switch (node.type) {
      case 'variable_declarator': {
        const name = field(node, 'name');
        const value = field(node, 'value');
        const mod = this.moduleOf(value);
        if (!name) break;
        if (mod !== undefined && name.type === 'identifier') this.binds.add(name.text, { kind: 'import', q: mod });
        else if (mod !== undefined && name.type === 'object_pattern') {
          for (const p of kids(name)) {
            if (p.type === 'shorthand_property_identifier_pattern') this.binds.add(p.text, { kind: 'import', q: `${mod}.${p.text}` });
            else if (p.type === 'pair_pattern' && field(p, 'value')?.type === 'identifier' && field(p, 'key')?.type === 'property_identifier') {
              this.binds.add(field(p, 'value')!.text, { kind: 'import', q: `${mod}.${field(p, 'key')!.text}` });
            } else this.bindPattern(p);
          }
        } else if (name.type === 'identifier' && (value?.type === 'arrow_function' || value?.type === 'function_expression' || value?.type === 'function')) {
          this.binds.add(name.text, { kind: 'def' });
        } else this.bindPattern(name);
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
      case 'augmented_assignment_expression':
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
    return at > 0 && JS_METHODS.has(q.slice(at + 1)) && JS_SAFE_VALUE.test(q.slice(0, at));
  }

  /** The dotted name of a chain rooted at a module alias, a literal require or a known global. */
  private qualified(root: Node, parts: string[]): string | undefined {
    const mod = requiredModule(root);
    if (mod !== undefined) return [mod, ...parts].join('.');
    if (root.type !== 'identifier') return undefined;
    const b = this.binds.resolve(root.text);
    if (b?.kind === 'import') return [b.q, ...parts].join('.');
    if (!b && JS_ROOTS.has(root.text)) return [root.text, ...parts].join('.');
    return undefined;
  }

  private name(node: Node): void {
    const b = this.binds.resolve(node.text);
    if (b?.kind === 'import') this.fail();
    else if (!b && !JS_SAFE_GLOBALS.has(node.text)) this.fail();
  }

  private member(node: Node): void {
    const { root, parts } = chain(node, 'member_expression', 'object', 'property');
    if (parts.some((p) => JS_HIDDEN.has(p))) return this.fail();
    const q = this.qualified(root, parts);
    if (q !== undefined) {
      if (root.type === 'call_expression') this.visit(root);
      if (!JS_SAFE_VALUE.test(q) && !this.safeCall(q) && !/^(console|JSON|Math|Object|Array|String|Number)\./.test(q) && !/\.json(\.|$)/.test(q)) this.fail();
      return;
    }
    this.visit(root);
  }

  private callback(node: Node): boolean {
    if (node.type === 'arrow_function' || node.type === 'function_expression' || node.type === 'function') return true;
    if (node.type === 'identifier') {
      const b = this.binds.resolve(node.text);
      if (b?.kind === 'def') return true;
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
      if (b?.kind === 'import') {
        callee = b.q;
        if (!this.safeCall(b.q)) {
          if (judgedCall('node', b.q)) this.judged = true;
          else return this.fail();
        }
      } else if (b?.kind === 'local') return this.fail();
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
      case 'assignment_pattern': {
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
    let dotted = name;
    for (let j = k; !perl && member(toks[j - 1]) && toks[j - 2]?.t === 'w'; j -= 2) dotted = `${toks[j - 2].text}.${dotted}`;
    if (!judgedCall(lang, dotted.replace(/::/g, '.'))) return fail;
    judged = true;
  }
  return { ok: true, judged };
}

/** Whether every call of `program` is judged or safe; `scanned` holds the scanner's lines for the W guard. */
export function proveProgram(lang: Lang, program: string, scanned: readonly string[]): boolean {
  if (lang === 'perl' || lang === 'ruby') {
    const proof = proveScript(lang, program);
    return proof.ok && (!proof.judged || scanned.includes('W'));
  }
  const parser = programParser(lang === 'py' ? 'python' : 'javascript');
  if (!parser) return false;
  const tree = parser.parse(program);
  if (!tree) return false;
  try {
    const root = tree.rootNode;
    if (root.hasError) return false;
    const proof = lang === 'py' ? new PyProof() : new JsProof();
    proof.collect(root);
    if (proof.ok) proof.visit(root);
    if (proof.judged && !scanned.includes('W')) return false;
    return proof.ok;
  } finally {
    tree.delete();
  }
}
