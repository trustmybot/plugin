import { readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The transcript tools were Python; these helpers keep their exact output:
// int/float distinction, json.dumps ensure_ascii, f-string padding, and
// round-half-to-even float formatting.

export class PyFloat {
  constructor(value) {
    this.value = value;
  }
}

export class CliExit extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliExit';
  }
}

const PY_WHITESPACE =
  '\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const STRIP = new RegExp(`^[${PY_WHITESPACE}]+|[${PY_WHITESPACE}]+$`, 'g');

export function pyStrip(text) {
  return text.replace(STRIP, '');
}

function reviveNumber(_key, value, context) {
  if (typeof value !== 'number') return value;
  const source = context?.source ?? String(value);
  if (/[.eE]/.test(source)) return new PyFloat(value);
  return Number.isSafeInteger(value) ? value : BigInt(source);
}

export function parseJsonLine(line) {
  return JSON.parse(line, reviveNumber);
}

export function parseJsonLines(text) {
  const values = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = pyStrip(raw);
    if (!line) continue;
    try {
      values.push(parseJsonLine(line));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return values;
}

export function readJsonLines(path) {
  return parseJsonLines(readFileSync(path, 'utf8'));
}

export function isDict(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof PyFloat)
  );
}

export function pyTypeName(value) {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number' || typeof value === 'bigint') return 'int';
  if (value instanceof PyFloat) return 'float';
  if (typeof value === 'string') return 'str';
  if (Array.isArray(value)) return 'list';
  return 'dict';
}

export function pyGet(object, key, fallback = null) {
  if (!isDict(object)) {
    throw new TypeError(`'${pyTypeName(object)}' object has no attribute 'get'`);
  }
  return Object.hasOwn(object, key) ? object[key] : fallback;
}

export function pyTruthy(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== 0n;
  if (value instanceof PyFloat) return value.value !== 0;
  if (typeof value === 'string' || Array.isArray(value)) return value.length > 0;
  return Object.keys(value).length > 0;
}

export function pyIter(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [...value];
  if (isDict(value)) return Object.keys(value);
  throw new TypeError(`'${pyTypeName(value)}' object is not iterable`);
}

export function pyIn(needle, container) {
  if (typeof container === 'string') {
    if (typeof needle !== 'string') {
      throw new TypeError(`'in <string>' requires string as left operand, not ${pyTypeName(needle)}`);
    }
    return container.includes(needle);
  }
  if (Array.isArray(container)) return container.some((item) => item === needle);
  if (isDict(container)) return typeof needle === 'string' && Object.hasOwn(container, needle);
  throw new TypeError(`argument of type '${pyTypeName(container)}' is not iterable`);
}

export function pyLen(value) {
  if (typeof value === 'string') return [...value].length;
  if (Array.isArray(value)) return value.length;
  if (isDict(value)) return Object.keys(value).length;
  throw new TypeError(`object of type '${pyTypeName(value)}' has no len()`);
}

export function pyHashKey(value) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return `s:${value}`;
  if (Array.isArray(value) || isDict(value)) {
    throw new TypeError(`unhashable type: '${pyTypeName(value)}'`);
  }
  const number = toFloat(value);
  return Number.isInteger(number) ? `n:${BigInt(toInt(value) ?? number)}` : `n:${number}`;
}

function isNumeric(value) {
  return (
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean' ||
    value instanceof PyFloat
  );
}

function toInt(value) {
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'bigint') return value;
  return null;
}

function toFloat(value) {
  if (value instanceof PyFloat) return value.value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return Number(value);
}

function fromInt(value) {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value;
}

function requireNumeric(operator, left, right) {
  if (!isNumeric(left) || !isNumeric(right)) {
    throw new TypeError(
      `unsupported operand type(s) for ${operator}: '${pyTypeName(left)}' and '${pyTypeName(right)}'`,
    );
  }
}

export function pyAdd(left, right) {
  requireNumeric('+', left, right);
  const a = toInt(left);
  const b = toInt(right);
  if (a !== null && b !== null) return fromInt(a + b);
  return new PyFloat(toFloat(left) + toFloat(right));
}

export function pySub(left, right) {
  requireNumeric('-', left, right);
  const a = toInt(left);
  const b = toInt(right);
  if (a !== null && b !== null) return fromInt(a - b);
  return new PyFloat(toFloat(left) - toFloat(right));
}

export function pyAbs(value) {
  if (!isNumeric(value)) throw new TypeError(`bad operand type for abs(): '${pyTypeName(value)}'`);
  const integer = toInt(value);
  if (integer !== null) return fromInt(integer < 0n ? -integer : integer);
  return new PyFloat(Math.abs(toFloat(value)));
}

export function pyLess(left, right) {
  if (!isNumeric(left) || !isNumeric(right)) {
    throw new TypeError(
      `'<' not supported between instances of '${pyTypeName(left)}' and '${pyTypeName(right)}'`,
    );
  }
  const a = toInt(left);
  const b = toInt(right);
  if (a !== null && b !== null) return a < b;
  return toFloat(left) < toFloat(right);
}

export function pyMin(left, right) {
  return pyLess(right, left) ? right : left;
}

export function pySum(values) {
  return values.reduce((total, value) => pyAdd(total, value), 0);
}

export function pyTrueDivide(left, right) {
  requireNumeric('/', left, right);
  return toFloat(left) / toFloat(right);
}

export function pyNumber(value) {
  requireNumeric('+', value, 0);
  return toFloat(value);
}

export function pyFloatRepr(x) {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const sign = x < 0 ? '-' : '';
  const [mantissa, exponentText] = Math.abs(x).toExponential().split('e');
  const digits = mantissa.replace('.', '');
  const exponent = Number(exponentText);
  if (exponent < -4 || exponent >= 16) {
    const rest = digits.slice(1);
    const expSign = exponent < 0 ? '-' : '+';
    const expDigits = String(Math.abs(exponent)).padStart(2, '0');
    return `${sign}${digits[0]}${rest ? `.${rest}` : ''}e${expSign}${expDigits}`;
  }
  if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
  const whole = digits.padEnd(exponent + 1, '0');
  const integerPart = whole.slice(0, exponent + 1);
  const fraction = whole.slice(exponent + 1);
  return `${sign}${integerPart}.${fraction || '0'}`;
}

function exactRatio(x) {
  if (x === 0) return [0n, 1n];
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  let mantissa = bits & ((1n << 52n) - 1n);
  let exponent = -1074;
  if (exponentBits !== 0) {
    mantissa |= 1n << 52n;
    exponent = exponentBits - 1075;
  }
  return exponent >= 0 ? [mantissa << BigInt(exponent), 1n] : [mantissa, 1n << BigInt(-exponent)];
}

export function pyFixed(value, digits) {
  if (!isNumeric(value)) {
    throw new ValueError(`Unknown format code 'f' for object of type '${pyTypeName(value)}'`);
  }
  const x = toFloat(value);
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  const negative = x < 0 || Object.is(x, -0);
  const [numerator, denominator] = exactRatio(Math.abs(x));
  const scaled = numerator * 10n ** BigInt(digits);
  let quotient = scaled / denominator;
  const twiceRemainder = 2n * (scaled % denominator);
  if (twiceRemainder > denominator || (twiceRemainder === denominator && quotient % 2n === 1n)) {
    quotient += 1n;
  }
  const text = quotient.toString().padStart(digits + 1, '0');
  const body = digits ? `${text.slice(0, -digits)}.${text.slice(-digits)}` : text;
  return `${negative ? '-' : ''}${body}`;
}

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

export function pyLeft(value, width) {
  let text;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'boolean') text = value ? '1' : '0';
  else if (typeof value === 'number' || typeof value === 'bigint') text = String(value);
  else if (value instanceof PyFloat) text = pyFloatRepr(value.value);
  else {
    throw new TypeError(`unsupported format string passed to ${pyTypeName(value)}.__format__`);
  }
  const length = [...text].length;
  return length >= width ? text : text + ' '.repeat(width - length);
}

export function pyJoin(separator, items) {
  items.forEach((item, index) => {
    if (typeof item !== 'string') {
      throw new TypeError(`sequence item ${index}: expected str instance, ${pyTypeName(item)} found`);
    }
  });
  return items.join(separator);
}

const SHORT_ESCAPES = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };

export function pyJsonString(text) {
  let out = '"';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const code = text.charCodeAt(index);
    if (Object.hasOwn(SHORT_ESCAPES, char)) out += SHORT_ESCAPES[char];
    else if (code >= 0x20 && code <= 0x7e) out += char;
    else out += `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return `${out}"`;
}

function jsonFloat(x) {
  if (Number.isNaN(x)) return 'NaN';
  if (!Number.isFinite(x)) return x > 0 ? 'Infinity' : '-Infinity';
  return pyFloatRepr(x);
}

export function pyDumps(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value instanceof PyFloat) return jsonFloat(value.value);
  if (typeof value === 'string') return pyJsonString(value);
  if (Array.isArray(value)) return `[${value.map(pyDumps).join(', ')}]`;
  const entries = Object.entries(value).map(([key, item]) => `${pyJsonString(key)}: ${pyDumps(item)}`);
  return `{${entries.join(', ')}}`;
}

export function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function requireFile(path) {
  if (!isFile(path)) throw new CliExit(`Error: file not found: ${path}`);
}

export function scriptLabel() {
  return relative(process.cwd(), process.argv[1] ?? '') || process.argv[1];
}

function invokedDirectly(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(resolve(process.argv[1]))).href === moduleUrl;
  } catch {
    return false;
  }
}

export function runCli(moduleUrl, main) {
  if (!invokedDirectly(moduleUrl)) return;
  const lines = [];
  try {
    for (const line of main(process.argv.slice(2))) lines.push(line);
  } catch (error) {
    const message =
      error instanceof CliExit ? error.message : `${error?.name ?? 'Error'}: ${error?.message ?? error}`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
  if (lines.length) process.stdout.write(lines.map((line) => `${line}\n`).join(''));
}
