// L1 lint: importing a trajectory-server module writes nothing to disk. A filesystem write that runs when the module is evaluated — a statement at module scope, inside a top-level try/if/for block, or in a top-level const/let initializer — fires for every script or test that merely imports the module, wherever it runs. Writes belong inside functions (memoized getters, first-write guards) or at server start in the entry points. Scans mcp/trajectory-server/src/**/*.ts, excluding src/test/ and the server entry point src/index.ts, whose module scope IS server start. Write calls: mkdirSync, writeFileSync, appendFileSync, rmSync, renameSync, copyFileSync, and openSync with a 'w' flag. A call is module-scope when no enclosing scope is a function body, arrow function, method, or class body (literal callbacks such as setTimeout(() => ...) count as functions). Every run also checks fixtures/no-module-load-writes/.
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = 'tests/l1-lint/fixtures/no-module-load-writes';
const ENTRY_POINTS = ['mcp/trajectory-server/src/index.ts'];
const WRITES = /^(?:mkdirSync|writeFileSync|appendFileSync|rmSync|renameSync|copyFileSync|openSync)$/;
const REGEX_PREV = /^(?:[(,=:[!&|?{};]|return)$/;
const TOKEN = /(?:(\n)|(=>)|(\w+)|([{}()[\];,])|([^\n\w{}()[\];,]))/y;
const WORD = /\w+/y;

const blank = (s) => s.replace(/[^\n]/g, ' ');

function strip(src) {
  let code = '';
  let i = 0;
  const n = src.length;
  let prev = '';
  while (i < n) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (two === '//') {
      let e = src.indexOf('\n', i);
      if (e < 0) e = n;
      code += ' '.repeat(e - i);
      i = e;
      continue;
    }
    if (two === '/*') {
      let e = src.indexOf('*/', i + 2);
      e = e < 0 ? n : e + 2;
      code += blank(src.slice(i, e));
      i = e;
      continue;
    }
    if (c === "'" || c === '"' || c === '`' || (c === '/' && REGEX_PREV.test(prev))) {
      const q = c;
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        const d = src[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (q === '`' && src.slice(j, j + 2) === '${') {
          depth++;
          j += 2;
          continue;
        }
        if (q === '`' && depth > 0 && d === '}') {
          depth--;
          j++;
          continue;
        }
        if (q === '/' && d === '[') {
          const k = src.indexOf(']', j);
          j = k < 0 ? n : k + 1;
          continue;
        }
        if (d === q && depth === 0) {
          j++;
          break;
        }
        if (d === '\n' && q !== '`') break;
        j++;
      }
      if (q === '/') while (j < n && /[a-z]/.test(src[j])) j++;
      code += `"${blank(src.slice(i + 1, j))}`;
      i = j;
      prev = 'x';
      continue;
    }
    code += c;
    if (/\w/.test(c)) {
      WORD.lastIndex = i;
      const w = WORD.exec(src)[0];
      code += w.slice(1);
      i += w.length;
      prev = w;
      continue;
    }
    if (/\S/.test(c)) prev = c;
    if (two === '=>') prev = '=>';
    i++;
  }
  return code;
}

export function scan(files) {
  const out = [];
  for (const file of files) {
    let src;
    try {
      src = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      continue;
    }
    const orig = src.split('\n');
    const code = strip(src);
    const stack = [];
    const parens = [];
    let lastClose = '';
    let header = '';
    let line = 1;
    const top = () => stack.at(-1);
    const exec = () => !stack.some((s) => s.kind === 'fn');
    TOKEN.lastIndex = 0;
    let m;
    while ((m = TOKEN.exec(code))) {
      const [, nl, arrow, word, punct, other] = m;
      const pos = TOKEN.lastIndex;
      if (nl !== undefined) {
        line++;
        continue;
      }
      if (arrow !== undefined) {
        if (!/^\s*\{/.test(code.slice(pos))) stack.push({ kind: 'fn', expr: true, paren: parens.length });
        header += ' =>';
        continue;
      }
      if (word !== undefined) {
        if (WRITES.test(word) && /^\s*\(/.test(code.slice(pos, pos + 200)) && exec()) {
          const text = orig[line - 1] ?? '';
          if (word !== 'openSync' || /openSync\s*\(.*["']w/.test(text)) out.push(`${file}:${line}: ${text.replace(/^\s+/, '')}`);
        }
        header += ` ${word}`;
        continue;
      }
      if (other !== undefined) {
        header += other;
        continue;
      }
      if (punct === '(' || punct === '[') {
        const w = /(\w+)\s*$/.exec(header);
        parens.push(punct === '(' ? (w ? w[1] : '') : '[');
        header += punct;
        continue;
      }
      if (punct === ')' || punct === ']') {
        while (stack.length && top().expr && top().paren >= parens.length) stack.pop();
        lastClose = parens.pop() ?? '';
        header += punct;
        continue;
      }
      if (punct === ';' || punct === ',') {
        while (stack.length && top().expr && top().paren === parens.length) stack.pop();
        if (punct === ';') header = '';
        continue;
      }
      if (punct === '{') {
        let kind;
        if (/=>\s*$/.test(header)) kind = 'fn';
        else if (/\)\s*$/.test(header)) kind = /^(?:if|for|while|catch|switch|with)$/.test(lastClose) ? 'blk' : 'fn';
        else if (/\b(?:try|else|finally|do)\s*$/.test(header)) kind = 'blk';
        else if (/(?:[<:,=([|&?!]|\breturn)\s*$/.test(header)) kind = 'obj';
        else if (/\b(?:function|class)\b/.test(header)) kind = 'fn';
        else kind = 'obj';
        stack.push({ kind, paren: parens.length, header });
        header = '';
        continue;
      }
      if (punct === '}') {
        while (stack.length && top().expr) stack.pop();
        const t = stack.pop();
        header = t && t.kind === 'obj' ? `${t.header}{}` : '';
      }
    }
  }
  return out;
}

function tsFiles(dir, out) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) tsFiles(rel, out);
    else if (entry.isFile() && entry.name.endsWith('.ts') && !rel.includes('/test/') && !ENTRY_POINTS.includes(rel)) out.push(rel);
  }
  return out;
}

function countViolations(rel) {
  return readFileSync(join(ROOT, rel), 'utf8').split('\n').filter((l) => l.includes('VIOLATION')).length;
}

test('fixture bad.ts: every VIOLATION line is reported', () => {
  const bad = scan([`${FIXTURES}/bad.ts`]);
  const expected = countViolations(`${FIXTURES}/bad.ts`);
  assert.equal(bad.length, expected, `no-module-load-writes self-test: expected ${expected} violations in bad.ts, got ${bad.length}\n${bad.join('\n')}`);
});

test('fixture good.ts: no violations', () => {
  const good = scan([`${FIXTURES}/good.ts`]);
  assert.deepEqual(good, [], `no-module-load-writes self-test: false positives in good.ts:\n${good.join('\n')}`);
});

test('no filesystem writes at module load', () => {
  const dir = 'mcp/trajectory-server/src';
  const files = existsSync(join(ROOT, dir)) ? tsFiles(dir, []).sort() : [];
  const out = scan(files);
  assert.deepEqual(out, [], `No-module-load-writes: FAIL — filesystem writes at module load (move them into a function or server start):\n${out.join('\n')}`);
});
