/**
 * Python's json.loads and json.dumps (default ensure_ascii, `", "` and `": "`
 * separators), str() and repr() over a Python-shaped value model, so the
 * MCP-down fallback subcommands print byte for byte what their python3-backed
 * .sh predecessors printed (GH 1692). An int is a bigint, a float a number, a
 * dict a Map (insertion order, a duplicate key keeping its first position).
 */
export class PyJsonError extends Error {
}
const NUMBER = /(-?(?:0|[1-9]\d*))(\.\d+)?([eE][-+]?\d+)?/y;
const WHITESPACE = /[ \t\n\r]*/y;
const SHORT_ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
class Parser {
    text;
    pos = 0;
    constructor(text) {
        this.text = text;
    }
    fail(what) {
        throw new PyJsonError(`${what} at char ${this.pos}`);
    }
    skip() {
        WHITESPACE.lastIndex = this.pos;
        WHITESPACE.exec(this.text);
        this.pos = WHITESPACE.lastIndex;
    }
    value() {
        const t = this.text;
        const ch = t[this.pos];
        if (ch === '"')
            return this.string();
        if (ch === '{')
            return this.object();
        if (ch === '[')
            return this.array();
        for (const [word, v] of [
            ['null', null],
            ['true', true],
            ['false', false],
            ['NaN', Number.NaN],
            ['Infinity', Number.POSITIVE_INFINITY],
            ['-Infinity', Number.NEGATIVE_INFINITY],
        ]) {
            if (t.startsWith(word, this.pos)) {
                this.pos += word.length;
                return v;
            }
        }
        NUMBER.lastIndex = this.pos;
        const m = NUMBER.exec(t);
        if (!m)
            this.fail('Expecting value');
        this.pos = NUMBER.lastIndex;
        if (m[2] === undefined && m[3] === undefined)
            return BigInt(m[1]);
        return Number(m[0]);
    }
    string() {
        const t = this.text;
        let out = '';
        this.pos += 1;
        for (;;) {
            if (this.pos >= t.length)
                this.fail('Unterminated string');
            const ch = t[this.pos];
            if (ch === '"') {
                this.pos += 1;
                return out;
            }
            if (ch.charCodeAt(0) < 0x20)
                this.fail('Invalid control character');
            if (ch !== '\\') {
                out += ch;
                this.pos += 1;
                continue;
            }
            const esc = t[this.pos + 1];
            if (esc === 'u') {
                const hex = t.slice(this.pos + 2, this.pos + 6);
                if (!/^[0-9a-fA-F]{4}$/.test(hex))
                    this.fail('Invalid \\u escape');
                out += String.fromCharCode(parseInt(hex, 16));
                this.pos += 6;
            }
            else if (esc !== undefined && esc in SHORT_ESCAPES) {
                out += SHORT_ESCAPES[esc];
                this.pos += 2;
            }
            else {
                this.fail('Invalid \\escape');
            }
        }
    }
    array() {
        const items = [];
        this.pos += 1;
        this.skip();
        if (this.text[this.pos] === ']') {
            this.pos += 1;
            return items;
        }
        for (;;) {
            this.skip();
            items.push(this.value());
            this.skip();
            const ch = this.text[this.pos];
            this.pos += 1;
            if (ch === ']')
                return items;
            if (ch !== ',')
                this.fail("Expecting ',' delimiter");
        }
    }
    object() {
        const dict = new Map();
        this.pos += 1;
        this.skip();
        if (this.text[this.pos] === '}') {
            this.pos += 1;
            return dict;
        }
        for (;;) {
            this.skip();
            if (this.text[this.pos] !== '"')
                this.fail('Expecting property name enclosed in double quotes');
            const key = this.string();
            this.skip();
            if (this.text[this.pos] !== ':')
                this.fail("Expecting ':' delimiter");
            this.pos += 1;
            this.skip();
            dict.set(key, this.value());
            this.skip();
            const ch = this.text[this.pos];
            this.pos += 1;
            if (ch === '}')
                return dict;
            if (ch !== ',')
                this.fail("Expecting ',' delimiter");
        }
    }
}
/** json.loads: throws PyJsonError where Python raises JSONDecodeError. */
export function pyLoads(text) {
    const p = new Parser(text);
    p.skip();
    const v = p.value();
    p.skip();
    if (p.pos !== text.length)
        p.fail('Extra data');
    return v;
}
/** repr(float), the shortest round-trip digits in Python's notation. */
export function pyFloatRepr(x) {
    if (Number.isNaN(x))
        return 'nan';
    if (x === Number.POSITIVE_INFINITY)
        return 'inf';
    if (x === Number.NEGATIVE_INFINITY)
        return '-inf';
    if (x === 0)
        return Object.is(x, -0) ? '-0.0' : '0.0';
    const [mantissa, expText] = Math.abs(x).toExponential().split('e');
    const exp = Number(expText);
    const digits = mantissa.replace('.', '');
    const sign = x < 0 ? '-' : '';
    if (exp < -4 || exp >= 16) {
        const frac = digits.length > 1 ? `.${digits.slice(1)}` : '';
        const e = String(Math.abs(exp)).padStart(2, '0');
        return `${sign}${digits[0]}${frac}e${exp < 0 ? '-' : '+'}${e}`;
    }
    if (exp < 0)
        return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
    const whole = digits.slice(0, exp + 1).padEnd(exp + 1, '0');
    const frac = digits.slice(exp + 1);
    return `${sign}${whole}.${frac === '' ? '0' : frac}`;
}
function dumpFloat(x) {
    if (Number.isNaN(x))
        return 'NaN';
    if (x === Number.POSITIVE_INFINITY)
        return 'Infinity';
    if (x === Number.NEGATIVE_INFINITY)
        return '-Infinity';
    return pyFloatRepr(x);
}
const DUMP_ESCAPES = { '\\': '\\\\', '"': '\\"', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
function dumpString(s) {
    return `"${s.replace(/[\\"]|[^ -~]/g, (c) => DUMP_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
}
/** json.dumps(v) with Python's default arguments. */
export function pyDumps(v) {
    if (v === null)
        return 'null';
    if (v === true)
        return 'true';
    if (v === false)
        return 'false';
    if (typeof v === 'bigint')
        return v.toString();
    if (typeof v === 'number')
        return dumpFloat(v);
    if (typeof v === 'string')
        return dumpString(v);
    if (Array.isArray(v))
        return `[${v.map(pyDumps).join(', ')}]`;
    return `{${[...v].map(([k, item]) => `${dumpString(k)}: ${pyDumps(item)}`).join(', ')}}`;
}
function reprString(s) {
    const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
    let out = '';
    for (const c of s) {
        const code = c.codePointAt(0) ?? 0;
        if (c === '\\' || c === quote)
            out += `\\${c}`;
        else if (c === '\n')
            out += '\\n';
        else if (c === '\r')
            out += '\\r';
        else if (c === '\t')
            out += '\\t';
        else if (code < 0x20 || code === 0x7f)
            out += `\\x${code.toString(16).padStart(2, '0')}`;
        else
            out += c;
    }
    return `${quote}${out}${quote}`;
}
/** repr(v). */
export function pyRepr(v) {
    if (v === null)
        return 'None';
    if (v === true)
        return 'True';
    if (v === false)
        return 'False';
    if (typeof v === 'bigint')
        return v.toString();
    if (typeof v === 'number')
        return pyFloatRepr(v);
    if (typeof v === 'string')
        return reprString(v);
    if (Array.isArray(v))
        return `[${v.map(pyRepr).join(', ')}]`;
    return `{${[...v].map(([k, item]) => `${reprString(k)}: ${pyRepr(item)}`).join(', ')}}`;
}
/** str(v): a string as itself, anything else as its repr. */
export function pyStr(v) {
    return typeof v === 'string' ? v : pyRepr(v);
}
//# sourceMappingURL=py-json.js.map