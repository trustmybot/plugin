// L1 lint: every `sqlite3` CLI invocation in shipped shell sets a busy timeout. The sqlite3 CLI's default busy timeout is 0: while another session (a second trajectory server, the dashboard, a hook) writes the DB, any read or write without one fails at once with "database is locked", and the hook fails open or closed at random. Route reads through gateRead / sqliteRo / dbReadBudget (mcp/trajectory-server/src/hooks/lib/db.ts) and writes through dbWrite (mcp/trajectory-server/src/hooks/lib/audit.ts); where a helper does not fit, pass `-cmd ".timeout ${TMB_DB_WRITE_TIMEOUT_MS:-1500}"` yourself. Scanned: *.sh / *.bash / extensionless files under scripts/, skills/, hooks/ (node_modules skipped). Each file is lexed as shell: `\` continuations joined, quotes, `$( )`, backticks, `${ }`, process substitution and heredocs honoured, and the text split into simple commands at unquoted `;` `&` `|` `(` `)` and newlines, so a case arm `a)`, `{`, `then`, `do`, `else`, `!`, `&&`, `||`, `|`, `$(` and a backtick all start a command. A command invokes sqlite3 when, after leading keywords, VAR=x assignments and sudo / nice / env / command / exec / time / timeout N / gtimeout N / stdbuf / ionice / coproc [NAME {] / nohup / xargs wrappers (with their options), its name is `sqlite3`, a path ending in /sqlite3 (quoted or not), `$(command -v sqlite3 ...)`, or `$V` / `${V}` / `${V:?}` / `${V:-sqlite3}` for a variable the file assigns sqlite3, `${W:-sqlite3}` or `$(command -v sqlite3 ...)`; `"${A[@]}"` for an array whose first command word is sqlite3 counts unless the array holds a timeout. `find -exec sqlite3`, and the string run by `eval` or `sh|bash|zsh -c`, are lexed as commands too. `sqlite3` followed by an option anywhere in a command (`set -- sqlite3 -readonly ...`) counts too. The invocation passes when its own arguments, redirections or heredoc body (after the sqlite3 word, up to the end of that command), or an array expanded there, hold `.timeout` or `busy_timeout`. Comments, quoted messages and heredoc text are data, never commands. Allowlist: tests/l1-lint/sqlite3-needs-timeout.allowlist — <path><TAB><substring of the line><TAB><reason>, only for a DB that is not the trajectory DB (a private copy, a scratch DB); an entry with no reason or matching no hit fails. The fixture cases scan fixtures/sqlite3-needs-timeout/: every `# VIOLATION` line of bad.txt (among them a bare `sqlite3 "$DB" "SELECT 1"`) must be reported and nothing in good.txt; the repo scan runs those checks first.
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOWLIST = 'tests/l1-lint/sqlite3-needs-timeout.allowlist';
const FIXTURES = 'tests/l1-lint/fixtures/sqlite3-needs-timeout';

const NS = '[^ \\t\\n\\r\\f\\v]';
const SQLITE = new RegExp(`^(?:${NS}*/)?sqlite3\\n?$`);
const LOOKUP = '(?:command[ \\t]+-v|which|type[ \\t]+-P)[ \\t]+sqlite3\\b[^)`]*';
const SQLVAL = new RegExp(
  `^(?:(?:${NS}*/)?sqlite3|\\$\\{[A-Za-z_]\\w*:?[-=](?:${NS}*/)?sqlite3\\}|\\$\\([ \\t]*${LOOKUP}\\)|\`[ \\t]*${LOOKUP}\`)\\n?$`,
);
const TIMEOUT = /\.timeout\b|busy_timeout/;
const FIND = new RegExp(`^(?:${NS}*/)?find\\n?$`);
const SHELL = new RegExp(`^(?:${NS}*/)?(?:ba|z|da|k)?sh\\n?$`);

let s = '';
let i = 0;
let n = 0;
let cmds = [];
let pending = [];
let lost = '';
let vars = new Set();
let arrays = new Map();

const ch = (p) => s.charAt(p);
const loseAs = (why) => {
  if (!lost) lost = why;
};
const newlines = (text) => text.split('\n').length - 1;

function newcmd() {
  const c = { words: [], extra: [] };
  cmds.push(c);
  return c;
}

function skipws() {
  while (i < n) {
    const c = ch(i);
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '\\' && ch(i + 1) === '\n') {
      i += 2;
      continue;
    }
    break;
  }
}

function readHeredocs() {
  let h;
  while ((h = pending.shift())) {
    let body = '';
    while (i < n) {
      let e = s.indexOf('\n', i);
      if (e < 0) e = n;
      const line = s.slice(i, e);
      i = e + 1;
      if (line.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, '') === h.delim) break;
      body += `${line}\n`;
    }
    if (i > n) i = n;
    h.cmd.extra.push(body);
  }
}

function arith(depth) {
  let d = depth;
  while (i < n && d > 0) {
    const c = ch(i++);
    if (c === '(') d++;
    if (c === ')') d--;
  }
  if (d > 0) loseAs('unterminated $((');
}

function dollarParen() {
  if (s.slice(i, i + 3) === '$((') {
    i += 3;
    arith(2);
    return;
  }
  i += 2;
  parse(')');
}

function squote() {
  let e = s.indexOf("'", i + 1);
  if (e < 0) {
    loseAs("unterminated '");
    e = n;
  }
  const v = s.slice(i + 1, e);
  i = e + 1;
  return v;
}

function dquote() {
  let v = '';
  while (i < n) {
    const c = ch(i);
    if (c === '\\') {
      const d = ch(i + 1);
      v += d === '\n' ? '' : /[$`"\\]/.test(d) ? d : `\\${d}`;
      i += 2;
      continue;
    }
    if (c === '"') {
      i++;
      return v;
    }
    if (c === '`') {
      const st = i++;
      parse('`');
      v += s.slice(st, i);
      continue;
    }
    if (c === '$' && ch(i + 1) === '(') {
      const st = i;
      dollarParen();
      v += s.slice(st, i);
      continue;
    }
    if (c === '$' && ch(i + 1) === '{') {
      const st = i;
      i += 2;
      brace(true);
      v += s.slice(st, i);
      continue;
    }
    v += c;
    i++;
  }
  loseAs('unterminated "');
  return v;
}

function brace(inq) {
  let d = 1;
  while (i < n) {
    const c = ch(i);
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '}') {
      i++;
      if (--d === 0) return;
      continue;
    }
    if (c === '$' && ch(i + 1) === '{') {
      i += 2;
      d++;
      continue;
    }
    if (c === '$' && ch(i + 1) === '(') {
      dollarParen();
      continue;
    }
    if (c === '"') {
      i++;
      dquote();
      continue;
    }
    if (c === "'" && !inq) {
      squote();
      continue;
    }
    if (c === '`') {
      i++;
      parse('`');
      continue;
    }
    i++;
  }
  loseAs('unterminated ${');
}

function lexWord(term) {
  const start = i;
  let val = '';
  while (i < n) {
    const c = ch(i);
    if (c === '\\') {
      const d = ch(i + 1);
      i += 2;
      if (d !== '\n') val += d;
      continue;
    }
    if (/[ \t\r\n;&|<>()]/.test(c)) break;
    if (c === '`') {
      if (term === '`') break;
      const st = i++;
      parse('`');
      val += s.slice(st, i);
      continue;
    }
    if (c === "'") {
      val += squote();
      continue;
    }
    if (c === '"') {
      i++;
      val += dquote();
      continue;
    }
    if (c === '$') {
      const d = ch(i + 1);
      if (d === "'") {
        i += 2;
        while (i < n) {
          const x = ch(i);
          if (x === '\\') {
            val += ch(i + 1);
            i += 2;
            continue;
          }
          if (x === "'") break;
          val += x;
          i++;
        }
        i++;
        continue;
      }
      if (d === '(') {
        const st = i;
        dollarParen();
        val += s.slice(st, i);
        continue;
      }
      if (d === '{') {
        const st = i;
        i += 2;
        brace(false);
        val += s.slice(st, i);
        continue;
      }
    }
    if (c === '=' && ch(i + 1) === '(' && /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?\n?$/.test(val)) {
      const st = i;
      i += 2;
      for (;;) {
        while (i < n && /[ \t\r\n]/.test(ch(i))) i++;
        if (i < n && ch(i) === '#') {
          const e = s.indexOf('\n', i);
          i = e < 0 ? n : e;
          continue;
        }
        if (i >= n) {
          loseAs('unterminated array');
          break;
        }
        if (ch(i) === ')') {
          i++;
          break;
        }
        if (!lexWord('')) i++;
      }
      val += s.slice(st, i);
      continue;
    }
    val += c;
    i++;
  }
  if (i === start) return null;
  return { raw: s.slice(start, i), val, pos: start };
}

function redirect(cmd) {
  if (/^[<>]\(/.test(s.slice(i, i + 2))) {
    const st = i;
    i += 2;
    parse(')');
    cmd.words.push({ raw: s.slice(st, i), val: '', pos: st });
    return;
  }
  if (s.slice(i, i + 3) === '<<<') {
    i += 3;
    skipws();
    const w = lexWord('');
    if (w) cmd.extra.push(w.raw);
    return;
  }
  if (s.slice(i, i + 2) === '<<') {
    i += 2;
    if (ch(i) === '-') i++;
    skipws();
    const w = lexWord('');
    if (w && /^[A-Za-z_][\w.-]*\n?$/.test(w.val)) pending.push({ delim: w.val, cmd });
    return;
  }
  while (i < n && /[<>&|]/.test(ch(i))) i++;
  if (ch(i) === '-') i++;
  skipws();
  const w = lexWord('');
  if (w) cmd.extra.push(w.raw);
}

function parse(term) {
  let cmd = newcmd();
  let depth = 0;
  let inCase = 0;
  while (i < n) {
    const c = ch(i);
    if (c === '\\' && ch(i + 1) === '\n') {
      i += 2;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      i++;
      cmd = newcmd();
      if (pending.length) readHeredocs();
      continue;
    }
    if (c === '#') {
      const e = s.indexOf('\n', i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === '`' && term === '`') {
      i++;
      return;
    }
    if (c === ')') {
      i++;
      if (depth > 0) depth--;
      else if (term === ')' && !inCase) return;
      cmd = newcmd();
      continue;
    }
    if (c === '(') {
      i++;
      depth++;
      cmd = newcmd();
      continue;
    }
    if (c === '&' && ch(i + 1) === '>') {
      i++;
      redirect(cmd);
      continue;
    }
    if (/[;&|]/.test(c)) {
      i++;
      cmd = newcmd();
      continue;
    }
    if (c === '<' || c === '>') {
      redirect(cmd);
      continue;
    }
    const w = lexWord(term);
    if (!w) {
      i++;
      continue;
    }
    if (/^\d+\n?$/.test(w.raw) && /[<>]/.test(ch(i))) continue;
    if (!cmd.words.length) {
      if (w.val === 'case') inCase++;
      if (w.val === 'esac' && inCase) inCase--;
    }
    cmd.words.push(w);
  }
  if (term !== '') loseAs(`unterminated ${term === '`' ? 'backtick' : '$( or ('}`);
}

function cmdName(w) {
  let k = 0;
  const m = w.length;
  const opts = (withArg) => {
    while (k < m && w[k].val.startsWith('-')) {
      const o = w[k++].val;
      if (withArg.test(o)) k++;
    }
  };
  const none = /^\n?$/;
  while (k < m) {
    const v = w[k].val;
    if (/^(?:if|then|elif|else|do|while|until|!|\{|nohup)\n?$/.test(v) || /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/.test(w[k].raw)) {
      k++;
      continue;
    }
    if (v === 'time') {
      k++;
      opts(none);
      continue;
    }
    if (v === 'exec') {
      k++;
      opts(/^-a\n?$/);
      continue;
    }
    if (v === 'nice') {
      k++;
      opts(/^-n\n?$/);
      continue;
    }
    if (v === 'sudo') {
      k++;
      opts(/^-[ugCDprtUT]\n?$/);
      continue;
    }
    if (v === 'xargs') {
      k++;
      opts(/^-[IdEnLPsa]\n?$/);
      continue;
    }
    if (v === 'stdbuf') {
      k++;
      opts(/^-[ioe]\n?$/);
      continue;
    }
    if (v === 'ionice') {
      k++;
      opts(/^-[cnp]\n?$/);
      continue;
    }
    if (/^g?timeout\n?$/.test(v)) {
      k++;
      opts(/^-[sk]\n?$/);
      k++;
      continue;
    }
    if (v === 'coproc') {
      k++;
      if (k + 1 < m && /^[A-Za-z_]\w*\n?$/.test(w[k].val) && w[k + 1].val === '{') k++;
      continue;
    }
    if (v === 'command') {
      if (k + 1 < m && /^-[vV]/.test(w[k + 1].val)) break;
      k++;
      opts(none);
      continue;
    }
    if (v === 'env') {
      k++;
      while (k < m) {
        const o = w[k].val;
        if (/^-[uCS]\n?$/.test(o)) {
          k += 2;
          continue;
        }
        if (o.startsWith('-') || /^[A-Za-z_]\w*=/.test(w[k].raw)) {
          k++;
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }
  return k;
}

function isSqlite(w) {
  if (SQLVAL.test(w.val)) return true;
  let m = /^"?\$\{([A-Za-z_]\w*)\[([^\]]*)\]\}"?\n?$/.exec(w.raw);
  if (m) {
    const a = arrays.get(m[1]);
    if (!a) return false;
    return Boolean(a.sqlite && !(/^[@*]\n?$/.test(m[2]) && a.timeout));
  }
  m = /^"?\$\{?([A-Za-z_]\w*)(?:(:?[-=?+])([^}]*))?\}?"?\n?$/.exec(w.raw);
  return Boolean(m && (vars.has(m[1]) || arrays.get(m[1])?.sqlite));
}

function arrayTimeout(raw) {
  const m = /\$\{([A-Za-z_]\w*)\[[@*]\]\}/.exec(raw);
  return Boolean(m && arrays.get(m[1])?.timeout);
}

const lineOf = (w) => w.ln ?? 1 + newlines(s.slice(0, w.pos));

function subparse(src, ln) {
  const saved = [s, i, n, cmds, pending, lost];
  [s, i, n, cmds, pending, lost] = [src, 0, src.length, [], [], ''];
  while (i < n) parse('');
  for (const c of cmds) for (const w of c.words) w.ln = ln + newlines(s.slice(0, w.pos));
  const out = cmds;
  [s, i, n, cmds, pending, lost] = saved;
  return out;
}

function nestedSource(w, k) {
  const v = w[k].val;
  if (v === 'eval' && k + 1 < w.length) {
    return [w.slice(k + 1).map((x) => x.val).join(' '), lineOf(w[k + 1])];
  }
  if (!SHELL.test(v)) return null;
  for (let j = k + 1; j < w.length - 1 && w[j].val.startsWith('-'); j++) {
    if (/^-[a-z]*c[a-z]*\n?$/.test(w[j].val)) return [w[j + 1].val, lineOf(w[j + 1])];
  }
  return null;
}

function readAllowlist(allowlist, out) {
  const allow = [];
  let bad = false;
  if (!allowlist) return { allow, bad };
  let text;
  try {
    text = readFileSync(resolve(ROOT, allowlist), 'utf8');
  } catch {
    return { allow, bad };
  }
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  lines.forEach((line, idx) => {
    if (/^[ \t\n\r\f\v]*(#|$)/.test(line)) return;
    const t1 = line.indexOf('\t');
    const t2 = t1 < 0 ? -1 : line.indexOf('\t', t1 + 1);
    const path = t1 < 0 ? line : line.slice(0, t1);
    const sub = t1 < 0 ? undefined : t2 < 0 ? line.slice(t1 + 1) : line.slice(t1 + 1, t2);
    const reason = t2 < 0 ? undefined : line.slice(t2 + 1);
    if (!sub || reason === undefined || !/[^ \t\n\r\f\v]/.test(reason)) {
      out.push(`ALLOWLIST ${allowlist}:${idx + 1}: needs <path><TAB><substring><TAB><reason>`);
      bad = true;
      return;
    }
    allow.push({ path, sub, used: false });
  });
  return { allow, bad };
}

export function scan(allowlist, files) {
  const out = [];
  const { allow, bad: allowBad } = readAllowlist(allowlist, out);
  let bad = allowBad;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(resolve(ROOT, file), 'utf8');
    } catch {
      continue;
    }
    [s, i, n, cmds, pending, lost] = [text, 0, text.length, [], [], ''];
    while (i < n) parse('');
    if (lost) {
      out.push(`${file}: the lint could not lex this file (${lost}); fix the file or teach the lexer the construct`);
      bad = true;
      continue;
    }
    for (let ci = 0; ci < cmds.length; ci++) {
      const w = cmds[ci].words;
      if (!w.length) continue;
      const k = cmdName(w);
      if (k >= w.length) continue;
      const nested = nestedSource(w, k);
      if (nested && nested[0].length) cmds.push(...subparse(nested[0], nested[1]));
    }
    vars = new Set();
    arrays = new Map();
    for (const c of cmds) {
      for (const w of c.words) {
        const m = /^([A-Za-z_]\w*)=(.*)\n?$/s.exec(w.val);
        if (m && SQLVAL.test(m[2])) vars.add(m[1]);
      }
    }
    for (const c of cmds) {
      for (const w of c.words) {
        const m = /^([A-Za-z_]\w*)(\+?)=\((.*)\)\n?$/s.exec(w.raw);
        if (!m) continue;
        const [, name, plus, body] = m;
        if (!arrays.has(name)) arrays.set(name, {});
        const a = arrays.get(name);
        a.timeout ||= TIMEOUT.test(body);
        if (plus) continue;
        const first = subparse(body, 1).find((x) => x.words.length);
        a.sqlite ||= Boolean(first && isSqlite(first.words[cmdName(first.words)] ?? { val: '', raw: '' }));
      }
    }
    const lines = s.split('\n');
    const seen = new Set();
    const hits = new Map();
    for (const c of cmds) {
      const w = c.words;
      if (!w.length) continue;
      const k = cmdName(w);
      const at = [];
      if (k < w.length && isSqlite(w[k])) at.push(k);
      const find = k < w.length && FIND.test(w[k].val);
      for (let j = k + 1; j <= w.length - 2; j++) {
        if (find) {
          if (!/^-(?:exec|execdir|ok|okdir)\n?$/.test(w[j].val)) continue;
          const e = j + 1 + cmdName(w.slice(j + 1));
          if (e < w.length && isSqlite(w[e])) at.push(e);
        } else if (SQLITE.test(w[j].val) && w[j + 1].val.startsWith('-')) {
          at.push(j);
        }
      }
      for (const j of at) {
        const rest = w.slice(j + 1);
        const own = [...rest.map((x) => x.raw), ...c.extra].join('\n');
        if (TIMEOUT.test(own) || rest.some((x) => arrayTimeout(x.raw))) continue;
        const ln = lineOf(w[j]);
        if (seen.has(ln)) continue;
        seen.add(ln);
        const l = lines[ln - 1] ?? '';
        const hit = allow.find((a) => a.path === file && l.includes(a.sub));
        if (hit) {
          hit.used = true;
          continue;
        }
        hits.set(ln, `${file}:${ln}: ${l.replace(/^[ \t\n\r\f\v]+/, '')}`);
        bad = true;
      }
    }
    out.push(...[...hits.keys()].sort((a, b) => a - b).map((ln) => hits.get(ln)));
  }
  for (const a of allow.filter((x) => !x.used)) {
    out.push(`ALLOWLIST ${allowlist}: stale entry (no hit): ${a.path}\t${a.sub}`);
    bad = true;
  }
  return { out, bad };
}

function expectedLines(file) {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const cont = lines.map((l) => /\\[ \t]*$/.test(l));
  const want = [];
  lines.forEach((l, idx) => {
    if (!/ # VIOLATION$/.test(l)) return;
    let k = idx;
    while (k > 0 && cont[k - 1]) k--;
    want.push(k + 1);
  });
  return want;
}

const hitLines = (out) => out.flatMap((l) => {
  const m = /^[^:]*:([0-9]+):/.exec(l);
  return m ? [Number(m[1])] : [];
});

function selfTestFailures() {
  const failures = [];
  const bad = scan(null, [`${FIXTURES}/bad.txt`]);
  const got = hitLines(bad.out);
  const expected = expectedLines(`${FIXTURES}/bad.txt`);
  if (got.join(' ') !== expected.join(' ')) {
    failures.push(`sqlite3-needs-timeout self-test: bad.txt expected hits on lines [${expected.join(' ')}], got [${got.join(' ')}]:\n${bad.out.join('\n')}`);
  }
  if (got.length !== expected.length) {
    failures.push(`sqlite3-needs-timeout self-test: bad.txt has ${expected.length} VIOLATION lines, ${got.length} reported`);
  }
  if (!bad.out.some((l) => l.includes('sqlite3 "$DB" "SELECT 1"'))) {
    failures.push('sqlite3-needs-timeout self-test: the bare sqlite3 "$DB" "SELECT 1" in bad.txt was not reported');
  }
  const good = scan(null, [`${FIXTURES}/good.txt`]);
  if (good.bad) failures.push(`sqlite3-needs-timeout self-test: false positives in good.txt:\n${good.out.join('\n')}`);
  return failures;
}

function walk(rel, acc) {
  let entries;
  try {
    entries = readdirSync(join(ROOT, rel), { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const path = `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(path, acc);
    } else if (e.isFile() && (e.name.endsWith('.sh') || e.name.endsWith('.bash') || !e.name.includes('.'))) {
      acc.push(path);
    }
  }
  return acc;
}

export const targets = () => ['scripts', 'skills', 'hooks'].flatMap((d) => walk(d, [])).sort();

function withTmp(fn) {
  const tmp = mkdtempSync(join((process.env.TMPDIR || tmpdir()).replace(/\/+$/, ''), 'tmb-sqlite3-needs-timeout.'));
  try {
    fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('bad.txt hits fall exactly on its VIOLATION lines, continuation lines counted at the command start', () => {
  const bad = scan(null, [`${FIXTURES}/bad.txt`]);
  assert.deepEqual(hitLines(bad.out), expectedLines(`${FIXTURES}/bad.txt`), bad.out.join('\n'));
});

test('bad.txt reports one hit per VIOLATION line', () => {
  const expected = expectedLines(`${FIXTURES}/bad.txt`);
  const got = scan(null, [`${FIXTURES}/bad.txt`]).out.filter((l) => /^[^:]*:[0-9]+:/.test(l));
  assert.equal(got.length, expected.length, `bad.txt has ${expected.length} VIOLATION lines, ${got.length} reported`);
});

test('the bare sqlite3 "$DB" "SELECT 1" in bad.txt is reported', () => {
  const { out } = scan(null, [`${FIXTURES}/bad.txt`]);
  assert.ok(out.some((l) => l.includes('sqlite3 "$DB" "SELECT 1"')), out.join('\n'));
});

test('good.txt yields no hit', () => {
  const good = scan(null, [`${FIXTURES}/good.txt`]);
  assert.equal(good.bad, false, `false positives in good.txt:\n${good.out.join('\n')}`);
  assert.deepEqual(good.out, []);
});

test('an allowlist entry with no reason fails', () => {
  withTmp((tmp) => {
    const file = join(tmp, 'x.sh');
    writeFileSync(file, 'sqlite3 "$SCRATCH" "SELECT 1"\n');
    writeFileSync(join(tmp, 'a.allowlist'), `# header\n${file}\tsqlite3 "$SCRATCH"\n`);
    const r = scan(join(tmp, 'a.allowlist'), [file]);
    assert.equal(r.bad, true);
    assert.ok(r.out.includes(`ALLOWLIST ${join(tmp, 'a.allowlist')}:2: needs <path><TAB><substring><TAB><reason>`), r.out.join('\n'));
    writeFileSync(join(tmp, 'b.allowlist'), `${file}\tsqlite3 "$SCRATCH"\t  \n`);
    assert.equal(scan(join(tmp, 'b.allowlist'), [file]).bad, true);
  });
});

test('an allowlist entry with a reason covers its hit, and a stale entry fails', () => {
  withTmp((tmp) => {
    const file = join(tmp, 'x.sh');
    writeFileSync(file, 'sqlite3 "$SCRATCH" "SELECT 1"\n');
    writeFileSync(join(tmp, 'ok.allowlist'), `${file}\tsqlite3 "$SCRATCH"\tscratch DB no other process opens\n`);
    assert.deepEqual(scan(join(tmp, 'ok.allowlist'), [file]), { out: [], bad: false });
    writeFileSync(join(tmp, 'stale.allowlist'), `${file}\tsqlite3 "$GONE"\tscratch DB\n`);
    const r = scan(join(tmp, 'stale.allowlist'), [file]);
    assert.equal(r.bad, true);
    assert.deepEqual(r.out, [
      `${file}:1: sqlite3 "$SCRATCH" "SELECT 1"`,
      `ALLOWLIST ${join(tmp, 'stale.allowlist')}: stale entry (no hit): ${file}\tsqlite3 "$GONE"`,
    ]);
  });
});

test('every sqlite3 call in scripts/, skills/ and hooks/ sets a busy timeout', () => {
  const failures = selfTestFailures();
  assert.deepEqual(failures, [], failures.join('\n'));
  assert.ok(existsSync(join(ROOT, ALLOWLIST)), `${ALLOWLIST} is missing`);
  const files = targets();
  const { out, bad } = scan(ALLOWLIST, files);
  assert.ok(
    !bad,
    `Sqlite3-needs-timeout: FAIL — sqlite3 invoked without a busy timeout (the CLI default of 0 fails at once under a concurrent writer):\n${out.join('\n')}\n` +
      `  Read through tmb_gate_read / tmb_sqlite_ro / tmb_db_read_budget, write through tmb_db_write,\n  or pass -cmd ".timeout \${TMB_DB_WRITE_TIMEOUT_MS:-1500}". A DB that is not the trajectory DB goes in ${ALLOWLIST} with a reason.`,
  );
});
