/**
 * jq keeps an object's keys in input order (a duplicate key stays at its first
 * position with its last value); a JS object moves integer-like keys to the
 * front in ascending order (GH 1692). parseKeepingKeyOrder remembers the input
 * order of each object it changed, and stringifyInOrder prints it. A payload
 * with no integer-like key takes JSON.parse and JSON.stringify unchanged.
 */
const INTEGER_LIKE_KEY = /"(?:\d|\\u003\d)+"\s*:/;
const inputOrder = new WeakMap();
let anyReordered = false;
export const isRawJson = (value) => JSON.isRawJSON?.(value) ?? false;
/** The end of the JSON value starting at <start>, or -1 when it never closes. */
export function valueEnd(text, start) {
    const first = text[start];
    if (first === '"') {
        let i = start + 1;
        while (i < text.length) {
            if (text[i] === '\\')
                i += 2;
            else if (text[i] === '"')
                return i + 1;
            else
                i += 1;
        }
        return -1;
    }
    if (first === '{' || first === '[') {
        let depth = 0;
        let i = start;
        while (i < text.length) {
            const ch = text[i];
            if (ch === '"') {
                const end = valueEnd(text, i);
                if (end < 0)
                    return -1;
                i = end;
                continue;
            }
            if (ch === '{' || ch === '[')
                depth += 1;
            else if (ch === '}' || ch === ']') {
                depth -= 1;
                if (depth === 0)
                    return i + 1;
            }
            i += 1;
        }
        return -1;
    }
    let i = start;
    while (i < text.length && !/[\s{}[\]",]/.test(text[i]))
        i += 1;
    return i === start ? -1 : i;
}
function skipSpace(text, start) {
    let i = start;
    while (/\s/.test(text[i] ?? ''))
        i += 1;
    return i;
}
/** The keys and elements of the JSON text at <start>, which JSON.parse has already accepted. */
function scan(text, start) {
    const open = text[start];
    if (open !== '{' && open !== '[')
        return { end: valueEnd(text, start) };
    const fields = new Map();
    const items = [];
    let i = skipSpace(text, start + 1);
    while (text[i] !== '}' && text[i] !== ']') {
        if (open === '{') {
            const keyEnd = valueEnd(text, i);
            const child = scan(text, skipSpace(text, skipSpace(text, keyEnd) + 1));
            fields.set(JSON.parse(text.slice(i, keyEnd)), child);
            i = child.end;
        }
        else {
            const child = scan(text, i);
            items.push(child);
            i = child.end;
        }
        i = skipSpace(text, i);
        if (text[i] === ',')
            i = skipSpace(text, i + 1);
    }
    return open === '{' ? { end: i + 1, fields } : { end: i + 1, items };
}
function remember(value, shape) {
    if (value === null || typeof value !== 'object')
        return;
    if (shape.items)
        shape.items.forEach((item, i) => remember(value[i], item));
    if (!shape.fields)
        return;
    const order = [...shape.fields.keys()];
    for (const [key, field] of shape.fields)
        remember(value[key], field);
    if (Object.keys(value).some((key, i) => key !== order[i])) {
        inputOrder.set(value, order);
        anyReordered = true;
    }
}
/** JSON.parse of one JSON value, remembering the input key order a JS object would lose. */
export function parseKeepingKeyOrder(text, reviver) {
    const value = JSON.parse(text, reviver);
    if (!INTEGER_LIKE_KEY.test(text))
        return value;
    try {
        remember(value, scan(text, 0));
    }
    catch (e) {
        if (!(e instanceof RangeError))
            throw e;
    }
    return value;
}
/** An object's keys in jq's order. */
export function keysInOrder(value) {
    return inputOrder.get(value) ?? Object.keys(value);
}
function render(value, indent, at) {
    if (value === null || typeof value !== 'object' || isRawJson(value))
        return JSON.stringify(value) ?? 'null';
    const inner = at + indent;
    const record = value;
    const [open, close] = Array.isArray(value) ? '[]' : '{}';
    const body = Array.isArray(value)
        ? value.map((v) => render(v, indent, inner))
        : keysInOrder(value)
            .filter((key) => record[key] !== undefined)
            .map((key) => `${JSON.stringify(key)}:${indent === '' ? '' : ' '}${render(record[key], indent, inner)}`);
    if (body.length === 0)
        return `${open}${close}`;
    return indent === '' ? `${open}${body.join(',')}${close}` : `${open}\n${inner}${body.join(`,\n${inner}`)}\n${at}${close}`;
}
/** JSON.stringify(value, null, indent), each parsed object's keys in jq's order. */
export function stringifyInOrder(value, indent = 0) {
    return anyReordered ? render(value, ' '.repeat(indent), '') : JSON.stringify(value, null, indent);
}
//# sourceMappingURL=jq-key-order.js.map