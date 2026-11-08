// L1 lint: /onboard option wording speaks to the user, not about TMB's internals (GH 1575). Scans the module-level code of mcp/trajectory-server/src/tools/onboard.ts (everything above `export function onboardTools`, where every question option is built; the tool definitions below it are written for the model and are skipped). Checked strings: the string literals of every `label:` and `description:` property value, and of every property value inside BRANCHING_DESCRIPTIONS. FAIL on a case-insensitive whole-word match, plural included, of trajectory, DB, hook, shim, PreToolUse, KV, wire, mirror, containment. WARN (printed, not failing) on a description string literal longer than 15 words (per literal, so the two arms of a ternary are counted apart). Comments are stripped first; `${...}` in template literals counts as nothing. Every run also checks fixtures/onboard-option-wording/: bad.ts fails exactly once per line marked VIOLATION, good.ts passes with exactly one warning.
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = 'tests/l1-lint/fixtures/onboard-option-wording';
const TARGET = 'mcp/trajectory-server/src/tools/onboard.ts';
const FORBIDDEN = /\b(trajectory|DB|hook|shim|PreToolUse|KV|wire|mirror|containment)s?\b/i;
const MAX_WORDS = 15;
const QUOTES = new Set(["'", '"', '`']);

function closeQuote(src, i) {
  const c = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
  return j;
}

function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (QUOTES.has(c)) {
      const j = closeQuote(src, i);
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (two === '//') {
      const j = src.indexOf('\n', i);
      i = j < 0 ? n : j;
    } else if (two === '/*') {
      let j = src.indexOf('*/', i + 2);
      if (j < 0) j = n - 2;
      out += '\n'.repeat((src.slice(i, j + 2).match(/\n/g) ?? []).length);
      i = j + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function valueLiterals(src, pos) {
  const lits = [];
  let depth = 0;
  const n = src.length;
  while (pos < n) {
    const c = src[pos];
    if (QUOTES.has(c)) {
      const j = closeQuote(src, pos);
      let lit = src.slice(pos + 1, j);
      if (c === '`') lit = lit.replace(/\$\{[^}]*\}/g, '');
      lits.push(lit.replace(/\\(.)/g, '$1'));
      pos = j + 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break;
      depth--;
    } else if ((c === ',' || c === ';') && depth === 0) break;
    pos++;
  }
  return lits;
}

export function scan(files) {
  const out = [];
  for (const file of files) {
    let src = stripComments(readFileSync(join(ROOT, file), 'utf8'));
    const end = /^export function onboardTools\b/m.exec(src);
    src = src.slice(0, end ? end.index : src.length);
    const props = [];
    for (const m of src.matchAll(/\b(label|description)\s*:\s*/g)) props.push([m[1], m.index + m[0].length]);
    const b = /\bBRANCHING_DESCRIPTIONS\s*=\s*\{/.exec(src);
    if (b) {
      const start = b.index + b[0].length;
      let depth = 0;
      let close = start;
      for (; close < src.length; close++) {
        const c = src[close];
        if (c === '{') depth++;
        if (c === '}') {
          if (depth === 0) break;
          depth--;
        }
      }
      const block = src.slice(start, close);
      for (const m of block.matchAll(/(?:^|[,{\s])(?:'[^']*'|"[^"]*"|[A-Za-z_]\w*)\s*:\s*/g)) {
        props.push(['description', start + m.index + m[0].length]);
      }
    }
    for (const [kind, at] of props) {
      const lits = valueLiterals(src, at);
      if (!lits.length) continue;
      const line = 1 + (src.slice(0, at).match(/\n/g) ?? []).length;
      for (const lit of lits) {
        const m = FORBIDDEN.exec(lit);
        if (m) {
          out.push(`FAIL\t${file}:${line}: "${m[1]}" in ${kind}: ${lit}`);
          break;
        }
      }
      if (kind === 'description') {
        for (const lit of lits) {
          const words = (lit.match(/\S+/g) ?? []).length;
          if (words > MAX_WORDS) out.push(`WARN\t${file}:${line}: description has ${words} words (aim for <= ${MAX_WORDS}): ${lit}`);
        }
      }
    }
  }
  return out;
}

const strip = (out, kind) => out.filter((l) => l.startsWith(`${kind}\t`)).map((l) => l.slice(kind.length + 1));

test('fixture bad.ts: one failure per VIOLATION line', () => {
  const out = scan([`${FIXTURES}/bad.ts`]);
  const expected = readFileSync(join(ROOT, `${FIXTURES}/bad.ts`), 'utf8').split('\n').filter((l) => l.includes('VIOLATION')).length;
  assert.equal(strip(out, 'FAIL').length, expected, `onboard-option-wording self-test: expected ${expected} failures in bad.ts, got ${strip(out, 'FAIL').length}\n${out.join('\n')}`);
});

test('fixture good.ts: no failure and exactly one length warning', () => {
  const out = scan([`${FIXTURES}/good.ts`]);
  assert.deepEqual(strip(out, 'FAIL'), [], `onboard-option-wording self-test: false positives in good.ts:\n${strip(out, 'FAIL').join('\n')}`);
  assert.equal(strip(out, 'WARN').length, 1, `onboard-option-wording self-test: expected 1 length warning in good.ts, got ${strip(out, 'WARN').length}\n${out.join('\n')}`);
});

test('/onboard option wording is plain language', () => {
  assert.ok(existsSync(join(ROOT, TARGET)), `Onboard-option-wording: FAIL — ${TARGET} not found`);
  const out = scan([TARGET]);
  const warns = strip(out, 'WARN');
  if (warns.length) process.stderr.write(`Onboard-option-wording: WARN — long descriptions:\n${warns.join('\n')}\n`);
  const fails = strip(out, 'FAIL');
  assert.deepEqual(fails, [], `Onboard-option-wording: FAIL — say what happens to the user, not the mechanism:\n${fails.join('\n')}`);
});
