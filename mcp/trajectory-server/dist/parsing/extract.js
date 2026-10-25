// Symbol and reference extraction for the L1 structural layer (ADR 0001):
// TS/JS and bash through tree-sitter, SQL DDL (in .sql files and in TS string
// literals) through regexes. Pure functions: a file's text in, its symbols
// and outgoing references out. Adapted from the GH 1680 MVP.
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
const EXCLUDED_PATH = [
    /(^|\/)dist\//,
    /\.map$/,
    /(^|\/)node_modules\//,
    /(^|\/)vendor\//,
    /\.min\.js$/,
    /(^|\/)package-lock\.json$/,
    /\.lock(b)?$/,
];
const EXTENSION_LANGUAGE = {
    ts: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    sh: 'bash',
    bash: 'bash',
    sql: 'sql',
};
const SH_BUILTINS = new Set('echo printf local export declare readonly return exit set unset shift cd test [ [[ true false read eval exec trap wait source . if then else fi for do done while case esac cat grep sed awk tr cut head tail sort uniq wc mkdir rm cp mv ln chmod touch date sleep command type jq git basename dirname xargs find tee env mktemp pwd kill ps sqlite3 node bash sh python3 curl gh'.split(' '));
export const STOPWORDS = new Set('a an the and or of to in on for with by is are was were be been when where what which who how why does do did it its this that these those from as at into per not no than then there their them our we you i set get'.split(' '));
export const md5 = (s) => createHash('md5').update(s).digest('hex');
export const DOC_MAX = 1000;
export function splitWords(s) {
    return s
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[^A-Za-z0-9]+/g, ' ')
        .toLowerCase()
        .trim();
}
export const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
// A path is in symbol scope unless it is build output, a source map, a
// lockfile or vendored code.
export function inSymbolScope(relPath) {
    return !EXCLUDED_PATH.some((re) => re.test(relPath));
}
// The language a path parses as: by extension, else a bash/sh shebang on an
// extensionless file; null when the file has no symbol extractor.
export function languageOf(relPath, head) {
    const name = basename(relPath);
    const dot = name.lastIndexOf('.');
    if (dot > 0)
        return EXTENSION_LANGUAGE[name.slice(dot + 1).toLowerCase()] ?? null;
    return /^#!.*\b(bash|sh)\b/.test(head().slice(0, 120)) ? 'bash' : null;
}
// The split-name text wm_symbols_fts indexes for a symbol.
export function symbolTerms(kind, qualifiedName, relPath) {
    return `${splitWords(qualifiedName)} ${kind.replace('_', ' ')} ${splitWords(basename(relPath))}`;
}
// The distinct non-stopword words of a body, for callers that rank on them.
export function bodyTerms(text) {
    const seen = new Set();
    for (const w of splitWords(text).split(' '))
        if (w.length > 2 && !STOPWORDS.has(w))
            seen.add(w);
    return [...seen].slice(0, 400).join(' ');
}
function normalizedHash(node) {
    const base = node.startIndex;
    let text = node.text;
    const comments = node
        .descendantsOfType('comment')
        .filter((c) => c !== null)
        .sort((a, b) => b.startIndex - a.startIndex);
    for (const c of comments)
        text = text.slice(0, c.startIndex - base) + text.slice(c.endIndex - base);
    return md5(oneLine(text));
}
// The whole comment block directly above a definition (or above its export).
export function docOf(node) {
    const anchor = node.parent?.type === 'export_statement' ? node.parent : node;
    const lines = [];
    let edge = anchor.startPosition.row;
    let prev = anchor.previousNamedSibling;
    while (prev && prev.type === 'comment' && prev.endPosition.row >= edge - (lines.length === 0 ? 2 : 1)) {
        lines.unshift(prev.text);
        edge = prev.startPosition.row;
        prev = prev.previousNamedSibling;
    }
    const raw = lines
        .map((l) => l
        .replace(/\*\//g, ' ')
        .replace(/^\s*(\/\*\*?|\*|\/\/+|#+)/gm, ' '))
        .join(' ');
    return clip(oneLine(raw), DOC_MAX);
}
const STRING_PARTS = new Set(['string_fragment', 'escape_sequence']);
// The text of a `description:` value built from string literals, joined
// across `+` concatenation and template parts; null for any other value.
function descriptionText(pair) {
    if (pair.childForFieldName('key')?.text.replace(/['"]/g, '') !== 'description')
        return null;
    const value = pair.childForFieldName('value');
    if (!value || !['string', 'template_string', 'binary_expression', 'parenthesized_expression'].includes(value.type)) {
        return null;
    }
    const parts = value
        .descendantsOfType([...STRING_PARTS])
        .filter((n) => n !== null)
        .map((n) => n.text);
    const text = oneLine(parts.join(''));
    return /[a-z]{3}/i.test(text) ? text : null;
}
// A definition's text up to its body, on one line.
export function signatureOf(node, src) {
    const body = node.childForFieldName('body');
    const end = body ? body.startIndex : Math.min(node.endIndex, node.startIndex + 160);
    return clip(oneLine(src.slice(node.startIndex, end)), 200);
}
const SQL_HINT = /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|REPLACE)\b/;
function sqlRefs(text) {
    if (!SQL_HINT.test(text))
        return [];
    const out = [];
    for (const m of text.matchAll(/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`]?([A-Za-z_]\w*)/g)) {
        out.push(['writes_table', m[1]]);
    }
    for (const m of text.matchAll(/\b(?:FROM|JOIN)\s+["`]?([A-Za-z_]\w*)/g))
        out.push(['reads_table', m[1]]);
    for (const m of text.matchAll(/\bALTER\s+TABLE\s+["`]?([A-Za-z_]\w*)/g))
        out.push(['writes_table', m[1]]);
    return out;
}
class Collector {
    symbols = [];
    edges = [];
    byKey = new Map();
    symbol(s) {
        const key = `${s.kind}\u0000${s.qualified_name}`;
        const known = this.byKey.get(key);
        if (known !== undefined)
            return known;
        this.symbols.push(s);
        this.byKey.set(key, this.symbols.length - 1);
        return this.symbols.length - 1;
    }
    edge(src, kind, dstName, line, hint = null) {
        this.edges.push({ src, kind, dst_name: dstName, line, hint });
    }
}
function lineCounter(text, lineBase) {
    const starts = [0];
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1))
        starts.push(i + 1);
    return (index) => {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= index)
                lo = mid;
            else
                hi = mid - 1;
        }
        return lineBase + lo + 1;
    };
}
function statementEnd(text, start, virtual) {
    if (virtual)
        return text.indexOf(';', start);
    let depth = 0;
    let i = text.indexOf('(', start);
    for (; i >= 0 && i < text.length; i++) {
        if (text[i] === '(')
            depth++;
        else if (text[i] === ')' && --depth === 0)
            break;
    }
    return i;
}
function columnNames(stmt) {
    const inner = stmt.slice(stmt.indexOf('(') + 1, stmt.lastIndexOf(')'));
    const cols = [];
    let depth = 0;
    let cur = '';
    for (const ch of inner) {
        if (ch === '(')
            depth++;
        if (ch === ')')
            depth--;
        if (ch === ',' && depth === 0) {
            cols.push(cur);
            cur = '';
        }
        else
            cur += ch;
    }
    cols.push(cur);
    return cols
        .map((c) => c.trim().split(/\s+/)[0] ?? '')
        .filter((c) => c && !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT|content|content_rowid|tokenize|--)/i.test(c));
}
function extractSqlDdl(text, out, moduleSymbol, lineBase = 0) {
    const lineAt = lineCounter(text, lineBase);
    for (const m of text.matchAll(/CREATE\s+(VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi)) {
        const start = m.index;
        let end = statementEnd(text, start, Boolean(m[1]));
        if (end < 0)
            end = Math.min(text.length, start + 400);
        const stmt = text.slice(start, end + 1);
        const name = m[2];
        out.symbol({
            kind: 'sql_table',
            qualified_name: name,
            signature: clip(`${name}(${columnNames(stmt).join(', ')})`, 240),
            doc: '',
            start_line: lineAt(start),
            end_line: lineAt(end),
            body_hash: md5(oneLine(stmt)),
            exported: 0,
        });
    }
    for (const m of text.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)/gi)) {
        const line = lineAt(m.index);
        const id = out.symbol({
            kind: 'sql_index',
            qualified_name: m[1],
            signature: oneLine(m[0]),
            doc: '',
            start_line: line,
            end_line: line,
            body_hash: md5(m[0]),
            exported: 0,
        });
        out.edge(id, 'indexes', m[2], line);
    }
    for (const m of text.matchAll(/CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+([\s\S]*?)\bON\s+(\w+)([\s\S]*?)\bEND\b/gi)) {
        const line = lineAt(m.index);
        const id = out.symbol({
            kind: 'sql_trigger',
            qualified_name: m[1],
            signature: clip(oneLine(`${m[1]} ${m[2]} ON ${m[3]}`), 200),
            doc: '',
            start_line: line,
            end_line: lineAt(m.index + m[0].length),
            body_hash: md5(oneLine(m[0])),
            exported: 0,
        });
        out.edge(id, 'triggers_on', m[3], line);
        for (const [kind, table] of sqlRefs(m[4]))
            out.edge(id, kind, table, line);
    }
    if (moduleSymbol !== null) {
        for (const m of text.matchAll(/\bALTER\s+TABLE\s+(\w+)/gi))
            out.edge(moduleSymbol, 'writes_table', m[1], lineAt(m.index));
    }
}
function named(node) {
    return node.namedChildren.filter((c) => c !== null);
}
const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function']);
function extractTs(root, src, out, moduleSymbol) {
    const definition = (node, kind, qualifiedName) => out.symbol({
        kind,
        qualified_name: qualifiedName,
        signature: signatureOf(node, src),
        doc: docOf(node),
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        body_hash: normalizedHash(node),
        exported: node.parent?.type === 'export_statement' ? 1 : 0,
    });
    const visit = (node, scope, cls) => {
        let inner = scope;
        let innerCls = cls;
        const t = node.type;
        const name = () => node.childForFieldName('name')?.text;
        if (t === 'function_declaration' || t === 'generator_function_declaration') {
            const n = name();
            if (n)
                inner = definition(node, 'function', n);
        }
        else if (t === 'class_declaration' || t === 'abstract_class_declaration') {
            const n = name();
            if (n) {
                inner = definition(node, 'class', n);
                innerCls = n;
            }
        }
        else if (t === 'method_definition' && cls) {
            const n = name();
            if (n)
                inner = definition(node, 'method', `${cls}.${n}`);
        }
        else if (t === 'interface_declaration') {
            const n = name();
            if (n)
                definition(node, 'interface', n);
        }
        else if (t === 'type_alias_declaration' || t === 'enum_declaration') {
            const n = name();
            if (n)
                definition(node, 'type', n);
        }
        else if (t === 'variable_declarator' && scope === moduleSymbol) {
            const decl = node.parent;
            const holder = decl?.parent?.type;
            const n = node.childForFieldName('name');
            if (decl && (holder === 'program' || holder === 'export_statement') && n?.type === 'identifier') {
                const value = node.childForFieldName('value');
                const isFn = value !== null && FUNCTION_VALUES.has(value.type);
                const bodyStart = value?.type === 'arrow_function' ? value.childForFieldName('body')?.startIndex : undefined;
                inner = out.symbol({
                    kind: isFn ? 'function' : 'const',
                    qualified_name: n.text,
                    signature: clip(oneLine(src.slice(decl.startIndex, bodyStart ?? Math.min(decl.endIndex, decl.startIndex + 140))), 200),
                    doc: docOf(decl),
                    start_line: decl.startPosition.row + 1,
                    end_line: decl.endPosition.row + 1,
                    body_hash: normalizedHash(node),
                    exported: holder === 'export_statement' ? 1 : 0,
                });
            }
        }
        else if (t === 'call_expression' || t === 'new_expression') {
            const fn = node.childForFieldName(t === 'call_expression' ? 'function' : 'constructor');
            let callee;
            let receiver;
            if (fn?.type === 'identifier')
                callee = fn.text;
            else if (fn?.type === 'member_expression') {
                callee = fn.childForFieldName('property')?.text;
                receiver = fn.childForFieldName('object')?.text;
            }
            if (callee) {
                out.edge(scope, t === 'call_expression' ? 'calls' : 'instantiates', callee, node.startPosition.row + 1, receiver && receiver.length < 40 ? receiver : null);
            }
        }
        else if (t === 'import_statement') {
            const spec = node.childForFieldName('source')?.text.slice(1, -1) ?? null;
            for (const s of node.descendantsOfType('import_specifier')) {
                const n = s?.childForFieldName('name')?.text;
                if (n)
                    out.edge(moduleSymbol, 'imports', n, node.startPosition.row + 1, spec);
            }
            return;
        }
        else if (t === 'pair' && scope !== moduleSymbol) {
            const text = descriptionText(node);
            const owner = out.symbols[scope];
            if (text && owner)
                owner.doc = clip(owner.doc ? `${owner.doc} ${text}` : text, DOC_MAX);
        }
        else if (t === 'string' || t === 'template_string') {
            const text = node.text;
            for (const [kind, table] of sqlRefs(text))
                out.edge(scope, kind, table, node.startPosition.row + 1);
            if (/CREATE\s+(VIRTUAL\s+)?TABLE/i.test(text))
                extractSqlDdl(text, out, null, node.startPosition.row);
        }
        for (const c of named(node))
            visit(c, inner, innerCls);
    };
    visit(root, moduleSymbol, null);
}
function stripQuotes(s) {
    return s.replace(/^["']|["']$/g, '');
}
function extractBash(root, out, moduleSymbol) {
    const visit = (node, scope) => {
        let inner = scope;
        const t = node.type;
        if (t === 'function_definition') {
            const n = node.childForFieldName('name')?.text;
            if (n) {
                inner = out.symbol({
                    kind: 'sh_function',
                    qualified_name: n,
                    signature: `${n}()`,
                    doc: docOf(node),
                    start_line: node.startPosition.row + 1,
                    end_line: node.endPosition.row + 1,
                    body_hash: normalizedHash(node),
                    exported: 1,
                });
            }
        }
        else if (t === 'command') {
            const name = node.childForFieldName('name')?.text;
            const args = named(node)
                .filter((c) => c.type !== 'command_name')
                .map((c) => stripQuotes(c.text));
            const line = node.startPosition.row + 1;
            if (name === 'source' || name === '.') {
                if (args[0])
                    out.edge(scope, 'sources', basename(args[0]), line);
            }
            else if (name && /\.sh$/.test(name))
                out.edge(scope, 'runs', basename(name), line);
            else if ((name === 'bash' || name === 'sh') && args[0] && /\.sh$/.test(args[0])) {
                out.edge(scope, 'runs', basename(args[0]), line);
            }
            else if (name && /^[A-Za-z_][\w-]*$/.test(name) && !SH_BUILTINS.has(name))
                out.edge(scope, 'calls', name, line);
        }
        else if (t === 'string' || t === 'raw_string' || t === 'heredoc_body') {
            for (const [kind, table] of sqlRefs(node.text))
                out.edge(scope, kind, table, node.startPosition.row + 1);
        }
        for (const c of named(node))
            visit(c, inner);
    };
    visit(root, moduleSymbol);
}
function moduleDoc(lang, src) {
    const out = [];
    const comment = lang === 'bash' || lang === 'sql' ? /^\s*(?:#|--)\s?(.*)$/ : /^\s*(?:\/\/|\/\*\*?|\*)\s?(.*?)(\*\/)?$/;
    for (const l of src.split('\n')) {
        if (/^#!/.test(l))
            continue;
        const m = l.match(comment);
        if (m) {
            if (m[1].trim())
                out.push(m[1].trim());
        }
        else if (out.length || l.trim())
            break;
    }
    return clip(out.join(' '), DOC_MAX);
}
// Every symbol of one file, the per-file 'module' row first, and the
// references each one makes.
export function extractFile(parsers, relPath, lang, src) {
    const out = new Collector();
    const moduleSymbol = out.symbol({
        kind: 'module',
        qualified_name: relPath,
        signature: relPath,
        doc: moduleDoc(lang, src),
        start_line: 1,
        end_line: src.split('\n').length,
        body_hash: md5(src),
        exported: 0,
    });
    if (lang === 'sql') {
        extractSqlDdl(src, out, moduleSymbol);
        return out;
    }
    if (!parsers)
        throw new Error(`no parser loaded for ${lang}`);
    const tree = parsers[lang].parse(src);
    if (!tree)
        throw new Error(`tree-sitter returned no tree for ${relPath}`);
    try {
        if (lang === 'bash')
            extractBash(tree.rootNode, out, moduleSymbol);
        else
            extractTs(tree.rootNode, src, out, moduleSymbol);
    }
    finally {
        tree.delete();
    }
    return out;
}
//# sourceMappingURL=extract.js.map