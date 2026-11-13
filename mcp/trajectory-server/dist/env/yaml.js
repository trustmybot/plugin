// Line-based YAML scalar and sequence readers for the env_detect CI and Taskfile readers; no YAML dependency.
import { indentOf, unquote } from './text.js';
const BLOCK_INDICATOR = /^[|>][1-9+-]*\s*(#.*)?$/;
export function isBlankYaml(line) {
    const t = line.trim();
    return t === '' || t.startsWith('#');
}
export function plainScalar(value) {
    const v = value.trim();
    if (v.startsWith('"') || v.startsWith("'"))
        return unquote(v);
    return v.replace(/\s+#.*$/, '');
}
// The block scalar whose indicator sits on line `at` under a key at column `keyColumn`: its dedented text and last line.
function blockScalar(lines, at, keyColumn, folded) {
    const body = [];
    let end = at;
    for (let j = at + 1; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim() !== '' && indentOf(line) <= keyColumn)
            break;
        body.push(line);
        end = j;
    }
    while (body.length > 0 && body[body.length - 1].trim() === '') {
        body.pop();
        end--;
    }
    const indents = body.filter((l) => l.trim() !== '').map(indentOf);
    const cut = indents.length > 0 ? Math.min(...indents) : 0;
    const text = body.map((l) => l.slice(cut).trimEnd()).join(folded ? ' ' : '\n');
    return { text, end };
}
// The scalar value on line `at` (0-based) of a key at column `keyColumn`: a block scalar, a plain or quoted one,
// or a plain one continued on deeper lines; with the last line it spans.
export function scalarAt(lines, at, keyColumn, value) {
    const v = value.trim();
    if (BLOCK_INDICATOR.test(v))
        return blockScalar(lines, at, keyColumn, v.startsWith('>'));
    if (v === '' || v.startsWith('#')) {
        const block = blockScalar(lines, at, keyColumn, true);
        return { text: block.text.replace(/\s+/g, ' ').trim(), end: block.end };
    }
    return { text: plainScalar(v), end: at };
}
// The `- item` entries of the sequence under a key at column `keyColumn` on line `at`, each with its 1-based line;
// an item that is itself a `key: value` map keeps its raw text.
export function sequenceAt(lines, at, keyColumn) {
    const items = [];
    let end = at;
    let itemIndent = -1;
    for (let j = at + 1; j < lines.length; j++) {
        const line = lines[j];
        if (isBlankYaml(line))
            continue;
        const indent = indentOf(line);
        const item = line.trimStart().match(/^-(\s+(.*)|)$/);
        if (itemIndent < 0) {
            if (!item || indent < keyColumn)
                break;
            itemIndent = indent;
        }
        if (indent < itemIndent || (indent === itemIndent && !item))
            break;
        end = j;
        if (indent > itemIndent || !item)
            continue;
        const { text, end: last } = scalarAt(lines, j, itemIndent, item[2] ?? '');
        if (text)
            items.push({ line: j + 1, text });
        j = last;
        end = last;
    }
    return { items, end };
}
export function flowItems(value) {
    const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '');
    return inner
        .split(/,(?=(?:[^"']*["'][^"']*["'])*[^"']*$)/)
        .map(plainScalar)
        .filter((s) => s !== '');
}
//# sourceMappingURL=yaml.js.map