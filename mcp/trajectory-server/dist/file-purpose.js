// Deterministic one-line file purpose from the first bytes of a file: a module
// docstring, a leading comment block, a JSDoc @file tag, markdown frontmatter or
// heading, or a manifest description. Pure: the caller supplies the head (at
// most PURPOSE_HEAD_BYTES); nothing here reads the disk.
export const PURPOSE_SOURCES = [
    'docstring',
    'comment',
    'jsdoc',
    'frontmatter',
    'heading',
    'manifest',
    'swe',
    'none',
];
export const PURPOSE_HEAD_BYTES = 4096;
export const PURPOSE_MAX_CHARS = 200;
const NONE = { purpose: '', source: 'none' };
const MANIFESTS = new Set(['package.json', 'plugin.json', 'marketplace.json']);
const COMMENT_STYLES = {
    ts: { line: ['//'], block: true },
    js: { line: ['//'], block: true },
    mjs: { line: ['//'], block: true },
    sh: { line: ['#'], block: false },
    pl: { line: ['#'], block: false },
    sql: { line: ['--'], block: true },
};
const JSDOC_EXTS = new Set(['ts', 'js', 'mjs']);
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
export function isPurposeCandidate(path) {
    const ext = extension(path);
    return MANIFESTS.has(baseName(path)) || ext === 'py' || ext === 'md' || ext in COMMENT_STYLES;
}
// Collapse whitespace, cut at the first sentence end, cap at PURPOSE_MAX_CHARS.
export function normalizePurpose(raw) {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text)
        return '';
    const end = /[.!?](?=\s+[A-Z0-9`'"(\[]|\s*$)/.exec(text);
    const sentence = end ? text.slice(0, end.index + 1) : text;
    if (sentence.length <= PURPOSE_MAX_CHARS)
        return sentence;
    const clipped = sentence.slice(0, PURPOSE_MAX_CHARS - 1);
    const lastSpace = clipped.lastIndexOf(' ');
    return `${(lastSpace > PURPOSE_MAX_CHARS / 2 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}
function result(raw, source) {
    const purpose = normalizePurpose(raw);
    return purpose ? { purpose, source } : null;
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
    return found ?? NONE;
}
//# sourceMappingURL=file-purpose.js.map