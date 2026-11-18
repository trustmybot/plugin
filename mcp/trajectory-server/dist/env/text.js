// Line helpers the env_detect readers share: line splitting, quote stripping, TOML comments and table headers.
export function splitLines(text) {
    return text.split(/\r?\n/);
}
export function unquote(value) {
    const v = value.trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0])
        return v.slice(1, -1);
    return v;
}
export function quotedStrings(line) {
    return [...line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? '');
}
export function stripHashComment(line) {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
            if (ch === '\\' && quote === '"')
                i++;
            else if (ch === quote)
                quote = null;
        }
        else if (ch === '"' || ch === "'") {
            quote = ch;
        }
        else if (ch === '#') {
            return line.slice(0, i);
        }
    }
    return line;
}
export function indentOf(line) {
    return line.length - line.trimStart().length;
}
// A TOML table header ([a.b] or [[a.b]]) as its dotted segments, quotes removed; null for any other line.
export function tomlHeader(line) {
    const m = stripHashComment(line).trim().match(/^\[\[?\s*([^\]]+?)\s*\]\]?$/);
    if (!m)
        return null;
    return [...m[1].matchAll(/"([^"]*)"|'([^']*)'|([^.\s]+)/g)].map((s) => s[1] ?? s[2] ?? s[3] ?? '');
}
// A TOML `key = value` line as its unquoted key and raw value; null for any other line.
export function tomlKeyValue(line) {
    const m = stripHashComment(line).match(/^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!m)
        return null;
    return { key: unquote(m[1]), value: m[2].trim() };
}
// The distribution name at the head of a requirement string such as `name[extra]>=1.0; marker`.
export function requirementName(spec) {
    return spec.trim().match(/^[A-Za-z0-9][A-Za-z0-9._-]*/)?.[0] ?? null;
}
//# sourceMappingURL=text.js.map