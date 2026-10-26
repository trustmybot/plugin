// Deterministic one-line file purpose from the first bytes of a file: a module
// docstring, a leading comment block, a JSDoc @file tag, markdown frontmatter or
// heading, or a manifest description; else, for a data file, its shape
// (structural), and for a code file, its L1 symbols (purposeFromSymbols). Pure:
// the caller supplies the head (at most PURPOSE_HEAD_BYTES) and the symbols;
// nothing here reads the disk.
export const PURPOSE_SOURCES = [
    'docstring',
    'comment',
    'jsdoc',
    'frontmatter',
    'heading',
    'manifest',
    'symbols',
    'structural',
    'swe',
    'none',
];
export const PURPOSE_HEAD_BYTES = 4096;
export const PURPOSE_MAX_CHARS = 200;
const NONE = { purpose: '', source: 'none' };
const MANIFESTS = new Set(['package.json', 'plugin.json', 'marketplace.json']);
const COMMENT_STYLES = {
    ts: { line: ['//'], block: true },
    tsx: { line: ['//'], block: true },
    js: { line: ['//'], block: true },
    mjs: { line: ['//'], block: true },
    sh: { line: ['#'], block: false },
    pl: { line: ['#'], block: false },
    sql: { line: ['--'], block: true },
};
const JSDOC_EXTS = new Set(['ts', 'tsx', 'js', 'mjs']);
const STRUCTURAL_EXTS = new Set(['json', 'yml', 'yaml', 'txt']);
const DIRECTIVE_LINE = /^(spdx-license-identifier|copyright|\(c\)|©|licensed under|all rights reserved|shellcheck |eslint|prettier-ignore|@ts-|-\*-|vim:|jshint|global )/i;
function baseName(path) {
    const i = path.lastIndexOf('/');
    return i >= 0 ? path.slice(i + 1) : path;
}
function extension(path) {
    const name = baseName(path);
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}
function inChangelogDir(path) {
    return /(^|\/)changelog\.d\//.test(path);
}
export function isPurposeCandidate(path) {
    const ext = extension(path);
    return (MANIFESTS.has(baseName(path)) ||
        ext === 'py' ||
        ext === 'md' ||
        ext in COMMENT_STYLES ||
        STRUCTURAL_EXTS.has(ext) ||
        inChangelogDir(path));
}
function capChars(text, max) {
    if (text.length <= max)
        return text;
    const clipped = text.slice(0, max - 1);
    const lastSpace = clipped.lastIndexOf(' ');
    return `${(lastSpace > max / 2 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}
// Collapse whitespace, cut at the first sentence end, cap at PURPOSE_MAX_CHARS.
export function normalizePurpose(raw) {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text)
        return '';
    const end = /[.!?](?=\s+[A-Z0-9`'"(\[]|\s*$)/.exec(text);
    return capChars(end ? text.slice(0, end.index + 1) : text, PURPOSE_MAX_CHARS);
}
function result(raw, source) {
    const purpose = normalizePurpose(raw);
    return purpose ? { purpose, source } : null;
}
// A purpose assembled from names, kept whole rather than cut at a sentence end.
function built(raw, source) {
    const purpose = capChars(raw.replace(/\s+/g, ' ').trim(), PURPOSE_MAX_CHARS);
    return purpose ? { purpose, source } : null;
}
// `<label>: a, b, c, +N more`, as many items as fit in budget (at least one).
function fitList(label, items, budget, sep = ', ') {
    let out = `${label}: `;
    let n = 0;
    for (const item of items) {
        const rest = items.length - n - 1;
        const more = rest > 0 ? `${sep}+${rest} more` : '';
        if (n > 0 && out.length + sep.length + item.length + more.length > budget)
            break;
        out += (n > 0 ? sep : '') + item;
        n++;
    }
    return n < items.length ? `${out}${sep}+${items.length - n} more` : out;
}
function firstParagraph(lines) {
    const out = [];
    for (const l of lines) {
        if (l.trim() === '') {
            if (out.length > 0)
                break;
            continue;
        }
        out.push(l.trim());
    }
    return out.join(' ');
}
function stripBlockComment(body) {
    return body.split('\n').map((l) => l.replace(/^\s*\*+\s?/, '').replace(/\s*\*+$/, ''));
}
function fromJsdoc(head) {
    const blocks = head.matchAll(/\/\*\*([\s\S]*?)\*\//g);
    for (const m of blocks) {
        const lines = stripBlockComment(m[1] ?? '');
        const tagIdx = lines.findIndex((l) => /@(file|fileoverview)\b/.test(l));
        if (tagIdx < 0)
            continue;
        const tagged = lines[tagIdx].replace(/^.*@(file|fileoverview)\b/, '').trim();
        const rest = lines.slice(tagIdx + 1);
        const nextTag = rest.findIndex((l) => l.trim().startsWith('@'));
        const text = tagged
            ? [tagged, ...(nextTag < 0 ? rest : rest.slice(0, nextTag))]
            : lines.filter((l) => !l.trim().startsWith('@'));
        const r = result(firstParagraph(text), 'jsdoc');
        if (r)
            return r;
    }
    return null;
}
function isDirective(text) {
    return DIRECTIVE_LINE.test(text.trim());
}
function proseLine(l) {
    return /[A-Za-z0-9]/.test(l) ? l : '';
}
function fromCommentBlock(head, style) {
    const lines = head.split('\n');
    const offsets = [];
    let acc = 0;
    for (const l of lines) {
        offsets.push(acc);
        acc += l.length + 1;
    }
    let i = 0;
    if (lines[0]?.startsWith('#!'))
        i = 1;
    while (i < lines.length) {
        const line = lines[i].trim();
        if (line === '') {
            i++;
            continue;
        }
        const marker = style.line.find((m) => line.startsWith(m));
        if (marker) {
            const block = [];
            while (i < lines.length) {
                const l = lines[i].trim();
                const m = style.line.find((mk) => l.startsWith(mk));
                if (!m)
                    break;
                block.push(proseLine(l.slice(m.length).replace(/^[#/-]+/, '').trim()));
                i++;
            }
            const content = block.filter((l) => !isDirective(l));
            const r = result(firstParagraph(content), 'comment');
            if (r)
                return r;
            continue;
        }
        if (style.block && line.startsWith('/*')) {
            const start = offsets[i] + lines[i].indexOf('/*');
            const close = head.indexOf('*/', start + 2);
            const body = head.slice(start + 2, close < 0 ? head.length : close).replace(/^\*+/, '');
            const content = stripBlockComment(body).map(proseLine).filter((l) => !isDirective(l));
            const r = result(firstParagraph(content), 'comment');
            if (r)
                return r;
            if (close < 0)
                return null;
            i = head.slice(0, close + 2).split('\n').length;
            continue;
        }
        return null;
    }
    return null;
}
function fromPythonDocstring(head) {
    const lines = head.split('\n');
    let i = 0;
    while (i < lines.length && (lines[i].trim() === '' || lines[i].trim().startsWith('#')))
        i++;
    const rest = lines.slice(i).join('\n');
    const m = /^[rRuU]?("""|''')([\s\S]*?)(?:\1|$)/.exec(rest) ?? /^[rRuU]?(["'])((?:\\.|(?!\1).)*)\1/.exec(rest);
    if (!m)
        return null;
    return result(firstParagraph((m[2] ?? '').split('\n')), 'docstring');
}
function unquoteYaml(v) {
    const t = v.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
        return t.slice(1, -1);
    return t;
}
function splitFrontmatter(head) {
    const lines = head.split('\n');
    if (lines[0]?.trim() !== '---')
        return { frontmatter: null, body: lines };
    const close = lines.findIndex((l, idx) => idx > 0 && l.trim() === '---');
    if (close < 0)
        return { frontmatter: lines.slice(1), body: [] };
    return { frontmatter: lines.slice(1, close), body: lines.slice(close + 1) };
}
function fromFrontmatter(fm) {
    const idx = fm.findIndex((l) => /^description\s*:/.test(l));
    if (idx < 0)
        return null;
    const value = fm[idx].replace(/^description\s*:/, '').trim();
    if (value && !/^[>|][+-]?$/.test(value))
        return result(unquoteYaml(value), 'frontmatter');
    const continuation = [];
    for (const l of fm.slice(idx + 1)) {
        if (!/^\s+\S/.test(l))
            break;
        continuation.push(l.trim());
    }
    return result(continuation.join(' '), 'frontmatter');
}
function stripInlineMarkdown(s) {
    return s
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__)(.*?)\1/g, '$2')
        .trim();
}
function fromHeading(body) {
    const h1 = body.findIndex((l) => /^#\s+\S/.test(l));
    if (h1 < 0)
        return null;
    const title = stripInlineMarkdown(body[h1].replace(/^#\s+/, '').replace(/\s+#+\s*$/, ''));
    const para = [];
    for (const raw of body.slice(h1 + 1)) {
        const l = raw.trim();
        if (l === '') {
            if (para.length > 0)
                break;
            continue;
        }
        if (para.length === 0 && (/^\[?!\[/.test(l) || l.startsWith('<')))
            continue;
        if (/^(#|```|~~~|\||[-*+]\s|\d+\.\s|>)/.test(l))
            break;
        para.push(stripInlineMarkdown(l));
    }
    const sentence = normalizePurpose(para.join(' '));
    return result(sentence ? `${title} — ${sentence}` : title, 'heading');
}
function fromMarkdown(head) {
    const { frontmatter, body } = splitFrontmatter(head);
    return (frontmatter && fromFrontmatter(frontmatter)) || fromHeading(body);
}
function fromManifest(head) {
    try {
        const parsed = JSON.parse(head);
        return typeof parsed.description === 'string' ? result(parsed.description, 'manifest') : null;
    }
    catch {
        const m = /"description"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(head);
        if (!m)
            return null;
        try {
            return result(JSON.parse(m[1]), 'manifest');
        }
        catch {
            return null;
        }
    }
}
function stem(path) {
    return baseName(path).replace(/\.[^.]+$/, '');
}
function readJsonString(text, start) {
    let j = start + 1;
    while (j < text.length && text[j] !== '"')
        j += text[j] === '\\' ? 2 : 1;
    if (j >= text.length)
        return null;
    try {
        return { value: JSON.parse(text.slice(start, j + 1)), end: j + 1 };
    }
    catch {
        return { value: text.slice(start + 1, j), end: j + 1 };
    }
}
// Top-level keys (of the first element, for an array root), their string
// values and an array root's string items, read by a depth-tracking scan so a head cut mid-file still yields them.
function jsonShape(text) {
    const start = text.search(/\S/);
    const array = text[start] === '[';
    if (!array && text[start] !== '{')
        return null;
    const keyDepth = array ? 2 : 1;
    const shape = { array, keys: [], items: [], strings: new Map() };
    let depth = 0;
    let element = 0;
    let i = start;
    while (i < text.length) {
        const c = text[i];
        if (c === '"') {
            const key = readJsonString(text, i);
            if (!key)
                break;
            i = key.end;
            if (array && depth === 1) {
                shape.items.push(key.value);
                continue;
            }
            if (depth !== keyDepth || element > 0)
                continue;
            const colon = /^\s*:\s*/.exec(text.slice(i, i + 64));
            if (!colon)
                continue;
            if (!shape.keys.includes(key.value))
                shape.keys.push(key.value);
            i += colon[0].length;
            if (text[i] === '"') {
                const value = readJsonString(text, i);
                if (!value)
                    break;
                if (!shape.strings.has(key.value))
                    shape.strings.set(key.value, value.value);
                i = value.end;
            }
            continue;
        }
        if (c === '{' || c === '[')
            depth++;
        else if (c === '}' || c === ']') {
            depth--;
            if (depth === 0)
                break;
        }
        else if (c === ',' && array && depth === 1)
            element++;
        i++;
    }
    return shape;
}
const YAML_KEY = /^("[^"]*"|'[^']*'|[A-Za-z_$][\w$.-]*)\s*:(?:\s+(.*))?$/;
function yamlShape(text) {
    const shape = { array: false, keys: [], items: [], strings: new Map() };
    for (const line of text.split('\n')) {
        const schema = /^#\s*yaml-language-server:\s*\$schema=(\S+)/.exec(line);
        if (schema)
            shape.strings.set('$schema', schema[1]);
        const m = YAML_KEY.exec(line.trimEnd());
        if (!m)
            continue;
        const key = unquoteYaml(m[1]);
        if (shape.keys.includes(key))
            continue;
        shape.keys.push(key);
        const value = (m[2] ?? '').replace(/\s+#.*$/, '').trim();
        if (value && !/^[|>&*{[!]/.test(value))
            shape.strings.set(key, unquoteYaml(value));
    }
    return shape;
}
function shortSchema(url) {
    return url.replace(/^[a-z]+:\/\//i, '').replace(/#$/, '');
}
function fromShape(shape) {
    if (!shape)
        return null;
    const name = shape.array ? undefined : shape.strings.get('name');
    const description = shape.array ? undefined : shape.strings.get('description');
    const schema = shape.array ? undefined : shape.strings.get('$schema');
    if (description)
        return result(name ? `${name}: ${description}` : description, 'structural');
    if (name)
        return built(schema ? `${name} (schema ${shortSchema(schema)})` : name, 'structural');
    if (schema)
        return built(`schema ${shortSchema(schema)}`, 'structural');
    if (shape.keys.length === 0)
        return shape.items.length > 0 ? built(fitList('items', shape.items, PURPOSE_MAX_CHARS), 'structural') : null;
    return built(fitList(shape.array ? 'items with keys' : 'keys', shape.keys, PURPOSE_MAX_CHARS), 'structural');
}
// What a header-less text file's directory makes it: a changelog fragment, a
// fixture (named for the directory that owns the fixtures), or text of its parent.
function dirRole(path) {
    if (inChangelogDir(path))
        return 'changelog fragment';
    const dirs = path.split('/').slice(0, -1);
    const parent = dirs[dirs.length - 1];
    if (!parent)
        return 'text';
    if (dirs.includes('fixtures') || dirs.includes('__fixtures__')) {
        const owner = parent === 'fixtures' || parent === '__fixtures__' ? dirs[dirs.length - 2] : parent;
        return owner ? `${owner} fixture` : 'fixture';
    }
    return `${parent} text`;
}
function stripTags(s) {
    let prev;
    let out = s;
    do {
        prev = out;
        out = out.replace(/<[^>]*>/g, '');
    } while (out !== prev);
    return out.replace(/[<>]/g, '');
}
function plainMarkdown(s) {
    return stripTags(stripInlineMarkdown(s))
        .replace(/`([^`]*)`/g, '$1')
        .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?=[^\w*]|$)/g, '$1$2')
        .trim();
}
function fromFirstLine(body) {
    let fenced = false;
    for (const raw of body) {
        const l = raw.trim();
        if (/^(```|~~~)/.test(l)) {
            fenced = !fenced;
            continue;
        }
        if (fenced || l === '' || l.startsWith('<!--') || l.startsWith('|') || /^-{3,}$/.test(l))
            continue;
        const text = plainMarkdown(l.replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/, ''));
        if (/[A-Za-z0-9]/.test(text))
            return result(text, 'structural');
    }
    return null;
}
function fromStructure(path, ext, text) {
    if (inChangelogDir(path) || ext === 'txt')
        return built(`${dirRole(path)}: ${stem(path)}`, 'structural');
    if (ext === 'json')
        return fromShape(jsonShape(text));
    if (ext === 'yml' || ext === 'yaml')
        return fromShape(yamlShape(text));
    if (ext === 'md')
        return fromFirstLine(splitFrontmatter(text).body);
    return null;
}
export function extractPurpose(path, head) {
    if (!head || head.includes('\0') || head.trim() === '')
        return NONE;
    const text = head.slice(0, PURPOSE_HEAD_BYTES).replace(/\r\n?/g, '\n').replace(/^﻿/, '');
    const ext = extension(path);
    let found = null;
    if (MANIFESTS.has(baseName(path)))
        found = fromManifest(text);
    else if (ext === 'py')
        found = fromPythonDocstring(text);
    else if (ext === 'md')
        found = fromMarkdown(text);
    else if (ext in COMMENT_STYLES) {
        found = (JSDOC_EXTS.has(ext) ? fromJsdoc(text) : null) ?? fromCommentBlock(text, COMMENT_STYLES[ext]);
    }
    return found ?? fromStructure(path, ext, text) ?? NONE;
}
const KIND_LABEL = {
    sh_function: 'function',
    sql_table: 'table',
    sql_index: 'index',
    sql_trigger: 'trigger',
};
const CODE_EXT = /\.[cm]?[jt]sx?$/;
export function isTestFile(path) {
    return /(^|\/)(tests?|__tests__)\//.test(path) || /\.(test|spec)\./.test(baseName(path));
}
// Whether a header-less file's purpose depends on its head as well as its
// symbols: a JS/TS test file, whose describe/test titles name what it covers.
export function needsHeadForSymbols(path) {
    return isTestFile(path) && CODE_EXT.test(path);
}
function testTitles(head) {
    const titles = [];
    const re = /\b(?:describe|suite|test|it)(?:\.(?:only|skip|todo))?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
    for (const m of head.matchAll(re)) {
        const title = m[2].trim();
        if (title && !titles.includes(title))
            titles.push(title);
    }
    return titles;
}
function fromTestTitles(path, head) {
    const titles = testTitles(head);
    if (titles.length === 0)
        return null;
    const subject = baseName(path).replace(/\.(test|spec)\.[^.]+$/, '').replace(/\.[^.]+$/, '');
    return built(fitList(`tests for ${subject}`, titles, PURPOSE_MAX_CHARS, '; '), 'symbols');
}
function contains(outer, inner) {
    if (outer.start_line === null || outer.end_line === null || inner.start_line === null || inner.end_line === null) {
        return false;
    }
    return (outer.start_line <= inner.start_line &&
        outer.end_line >= inner.end_line &&
        (outer.start_line < inner.start_line || outer.end_line > inner.end_line));
}
function docSentence(doc) {
    const text = normalizePurpose(doc);
    return text && !isDirective(text) && /[A-Za-z]{3}/.test(text) ? text : '';
}
function squash(name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}
function withDoc(label, items, doc) {
    const docBudget = doc ? Math.min(doc.length + 3, PURPOSE_MAX_CHARS / 2) : 0;
    const list = fitList(label, items, PURPOSE_MAX_CHARS - docBudget);
    const room = PURPOSE_MAX_CHARS - list.length - 3;
    return doc && room >= 20 ? `${list} — ${capChars(doc, room)}` : list;
}
// A header-less code file's purpose from its L1 symbols: its exports (kind and
// name), else its top-level definitions (names only for shell functions), plus
// the first sentence of the module doc or of the main export's doc. A JS/TS test
// file whose head names describe/test titles is described by those instead.
export function purposeFromSymbols(path, symbols, head = '') {
    if (needsHeadForSymbols(path)) {
        const tests = fromTestTitles(path, head);
        if (tests)
            return tests;
    }
    const defs = symbols.filter((s) => s.kind !== 'module' && s.kind !== 'hook' && s.kind !== 'method');
    const top = defs.filter((d) => !defs.some((o) => o !== d && contains(o, d)));
    if (top.length === 0)
        return null;
    const moduleDoc = docSentence(symbols.find((s) => s.kind === 'module')?.doc ?? '');
    const shell = top.every((s) => s.kind === 'sh_function');
    if (shell)
        return built(withDoc('functions', [...new Set(top.map((s) => s.qualified_name))], moduleDoc), 'symbols');
    const exports = top.filter((s) => s.exported === 1);
    const listed = exports.length > 0 ? exports : top;
    const items = [...new Set(listed.map((s) => `${s.qualified_name} (${KIND_LABEL[s.kind] ?? s.kind})`))];
    let doc = moduleDoc;
    if (!doc && exports.length > 0) {
        const fileStem = squash(baseName(path).replace(/\..*$/, ''));
        const main = exports.find((s) => squash(s.qualified_name) === fileStem && docSentence(s.doc)) ?? exports.find((s) => docSentence(s.doc));
        doc = main ? docSentence(main.doc) : '';
    }
    return built(withDoc(exports.length > 0 ? 'exports' : 'defines', items, doc), 'symbols');
}
//# sourceMappingURL=file-purpose.js.map