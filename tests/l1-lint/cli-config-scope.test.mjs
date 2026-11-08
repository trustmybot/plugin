// L1 lint: every config-changing `claude plugin` / `claude mcp` call runs at project scope. The CLI's defaults reach user scope (`plugin uninstall` defaults to user, `mcp add` to local — stored in ~/.claude.json — and `mcp remove` acts on whichever scope holds the name), so TMB pins the scope instead of relying on them. Config-changing subcommands, aliases included, from the help of Claude Code 2.1.303: with `-s, --scope` plugin install|i, uninstall|remove, enable, disable, update, prune|autoremove; mcp add, add-json, add-from-claude-desktop, remove. With `--scope` only: plugin marketplace add, remove|rm. No scope option: plugin configure, init|new; plugin marketplace update; mcp login, logout, reset-project-choices. A call passes only when its last scope flag (`--scope X`, `--scope=X`, and `-s X` / `-sX` where the subcommand takes `-s`) before any `--` is the literal `project`; a subcommand with no scope option is flagged outright. Read-only ones (list, get, details, validate, ...) pass; `plugins` is the CLI's alias for `plugin`. The program is `claude`, any path ending in `/claude`, or a variable (`$X`, `${X}`, quoted or not) whose name contains "claude" (any case) or that the file assigns a value naming `claude`, matched anywhere on a line. Global options may sit between the program and `plugin` / `mcp`. The call runs to the end of its command (`;`, `&&`, `||`, `|`, `&`, an unmatched `)` or backtick, the string it sits in, or an unescaped newline). TS/JS argv arrays (`['plugin', 'install', x]`, global options and a program element allowed before the group) are checked the same way. A non-literal subcommand fails closed: flagged unless the call is pinned to project scope. Comments are stripped only outside quotes: `#` at a word start in shell, `//` and `/* */` in TS/JS; heredoc bodies are scanned as commands. Scans every git-tracked *.sh, *.mjs, *.js and *.ts outside any tests/ or test/, dist/ and node_modules/ directory. Exempt: the Human-run repair tools on tests/l1-lint/no-home-writes.allowlist, and a call shown to the Human rather than run, marked with a `# cli-config-scope: printed` (or `//`) comment on its line; on a heredoc's opening line the comment covers the whole body. Every run also checks fixtures/cli-config-scope/: every line marked VIOLATION in a bad fixture is flagged, nothing else is, and the good fixtures produce no findings.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = 'tests/l1-lint/fixtures/cli-config-scope';
const ALLOWLIST = 'tests/l1-lint/no-home-writes.allowlist';

const set = (s) => new Set(s.split(' '));
const PLUGIN_PIN = set('install i uninstall remove enable disable update prune autoremove');
const PLUGIN_BARE = set('configure init new');
const MKT_PIN = set('add remove rm');
const MKT_BARE = set('update');
const MCP_PIN = set('add add-json add-from-claude-desktop remove');
const MCP_BARE = set('login logout reset-project-choices');
const REGEX_PREV = /[(,=:[!&|?{};+\-*%<>~^]/;
const HEREDOC = /^-?[ \t]*(["']?)([A-Za-z_]\w*)\1/;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const delimLine = (d) => new RegExp(String.raw`^\t*${escapeRe(d)}\s*$`);

function lex(s, js) {
  const n = s.length;
  const out = [...s];
  const map = new Array(n).fill('.');
  const st = [];
  let here = [];
  const toks = [];
  let tpl = 0;
  let sig = '';
  let oend = -1;
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const toEol = (p) => {
    const e = s.indexOf('\n', p);
    return e < 0 ? n : e;
  };
  const emitStr = (f, i) => {
    if (tpl) return;
    let v = s.slice(f[1] + 1, i);
    const lit = f[0] !== '`' || !v.includes('${');
    v = v.replace(/\\([\s\S])/g, '$1');
    toks.push(['s', v, lit, f[1]]);
  };
  let i = 0;
  while (i < n) {
    const c = s[i];
    const two = s.slice(i, i + 2);
    const top = st.length ? st.at(-1)[0] : '';
    map[i] = top === '' ? '.' : top;
    if (js) {
      if (top === "'" || top === '"') {
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === top) {
          emitStr(st.pop(), i);
          sig = 'x';
        } else if (c === '\n') st.pop();
        i++;
        continue;
      }
      if (top === '`') {
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '`') {
          const f = st.pop();
          tpl--;
          emitStr(f, i);
          sig = 'x';
          i++;
          continue;
        }
        if (two === '${') {
          st.push(['{', i]);
          i += 2;
          continue;
        }
        i++;
        continue;
      }
      if (top === '/' || top === '[') {
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '\n') {
          while (st.length && (st.at(-1)[0] === '/' || st.at(-1)[0] === '[')) st.pop();
          i++;
          continue;
        }
        if (top === '[') {
          if (c === ']') st.pop();
        } else if (c === '[') st.push(['[', i]);
        else if (c === '/') {
          st.pop();
          sig = 'x';
        }
        i++;
        continue;
      }
      if (two === '//' || (i === 0 && two === '#!')) {
        const e = toEol(i);
        blank(i, e);
        i = e;
        continue;
      }
      if (two === '/*') {
        let e = s.indexOf('*/', i + 2);
        e = e < 0 ? n : e + 2;
        blank(i, e);
        i = e;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        st.push([c, i]);
        if (c === '`') tpl++;
        i++;
        continue;
      }
      if (c === '/' && (sig === '' || REGEX_PREV.test(sig))) {
        st.push(['/', i]);
        i++;
        continue;
      }
      if (c === '{') st.push(['{', i]);
      else if (c === '}' && top === '{') st.pop();
      if (!tpl) {
        if (/[[\](){},]/.test(c)) toks.push(['p', c, false, i]);
        else if (/\S/.test(c)) {
          if (oend === i - 1 && toks.length && toks.at(-1)[0] === 'o') toks.at(-1)[1] += c;
          else toks.push(['o', c, false, i]);
          oend = i;
        }
      }
      if (/\S/.test(c)) sig = c;
      i++;
      continue;
    }
    if (c === '\n' && here.length) {
      let j = i + 1;
      for (const d of here) {
        const re = delimLine(d);
        while (j < n) {
          const e = toEol(j);
          const line = s.slice(j, e);
          j = e + 1;
          if (re.test(line)) break;
        }
      }
      here = [];
      i = j < n ? j : n;
      continue;
    }
    if (top === "'") {
      if (c === "'") st.pop();
      i++;
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (top === '"') {
      if (c === '"') st.pop();
      else if (two === '$(') {
        st.push(['(', i]);
        i++;
      } else if (c === '`') st.push(['`', i]);
      i++;
      continue;
    }
    if (top === 'A') {
      if (two === '))') {
        st.pop();
        i += 2;
      } else i++;
      continue;
    }
    if (c === '#' && (i === 0 || /[\s;&|(]/.test(s[i - 1]))) {
      const e = toEol(i);
      blank(i, e);
      i = e;
      continue;
    }
    if (c === "'" || c === '"') {
      st.push([c, i]);
      i++;
      continue;
    }
    if (c === '`') {
      if (top === '`') st.pop();
      else st.push(['`', i]);
      i++;
      continue;
    }
    if (s.slice(i, i + 3) === '$((') {
      st.push(['A', i]);
      i += 3;
      continue;
    }
    if (two === '((') {
      st.push(['A', i]);
      i += 2;
      continue;
    }
    if (two === '$(') {
      st.push(['(', i]);
      i += 2;
      continue;
    }
    if (two === '${') {
      st.push(['{', i]);
      i += 2;
      continue;
    }
    if (s.slice(i, i + 3) === '<<<') {
      i += 3;
      continue;
    }
    if (two === '<<') {
      const m = HEREDOC.exec(s.slice(i + 2, i + 82));
      if (m) {
        here.push(m[2]);
        i += 2;
        continue;
      }
    }
    if (c === '(') st.push(['(', i]);
    else if (c === ')' && top === '(') st.pop();
    else if (c === '}' && top === '{') st.pop();
    i++;
  }
  return { text: out.join(''), map, toks };
}

function words(s, p, q) {
  const n = s.length;
  const w = [];
  const st = [];
  let cur = '';
  let lit = true;
  let inWord = false;
  const flush = () => {
    if (inWord) w.push([cur, lit]);
    cur = '';
    lit = true;
    inWord = false;
  };
  while (p < n) {
    const c = s[p];
    const top = st.length ? st.at(-1) : '';
    if (c === '\n') break;
    if (top === "'") {
      if (c === "'") st.pop();
      else cur += c;
      p++;
      continue;
    }
    if (c === '\\') {
      const nx = s[p + 1] ?? '';
      if (nx === '\n') {
        if (top === '') flush();
        p += 2;
        continue;
      }
      cur += nx;
      inWord = true;
      p += 2;
      continue;
    }
    if (top === '"') {
      if (c === '"') {
        st.pop();
        p++;
        continue;
      }
      if (c === '$') {
        lit = false;
        const nx = s[p + 1] ?? '';
        if (nx === '(' || nx === '{') {
          st.push(nx);
          cur += c + nx;
          p += 2;
          continue;
        }
      }
      cur += c;
      p++;
      continue;
    }
    if (top === '') {
      if (q !== '' && c === q) break;
      if (c === ' ' || c === '\t') {
        flush();
        p++;
        continue;
      }
      if (/[;|)`]/.test(c)) break;
      if (c === '&' && !((p && /[<>]/.test(s[p - 1])) || s[p + 1] === '>')) break;
    }
    inWord = true;
    if (c === "'" || c === '"') {
      st.push(c);
      p++;
      continue;
    }
    if (c === '$') {
      lit = false;
      const nx = s[p + 1] ?? '';
      if (nx === '(' || nx === '{') {
        st.push(nx);
        cur += c + nx;
        p += 2;
        continue;
      }
    } else if (c === '(') st.push('(');
    else if (c === ')' && top === '(') st.pop();
    else if (c === '}' && top === '{') st.pop();
    cur += c;
    p++;
  }
  flush();
  return [w, p];
}

function findGroup(t, argv) {
  let val = false;
  for (let i = 0; i < t.length; i++) {
    const [v, lit] = t[i];
    if (lit && /^(?:plugins?|mcp)$/.test(v)) return i;
    if (!lit) {
      val = true;
      continue;
    }
    if (v.startsWith('-') && v !== '--') {
      val = !v.includes('=');
      continue;
    }
    if (val) {
      val = false;
      continue;
    }
    if (argv && i === 0 && /(?:^|\/)claude$/.test(v)) continue;
    return -1;
  }
  return -1;
}

function pinned(t, short) {
  let scope;
  for (let i = 0; i < t.length; i++) {
    const [v, lit] = t[i];
    if (lit && v === '--') break;
    let m;
    if (lit && (v === '--scope' || (short && v === '-s'))) {
      const val = t[++i];
      scope = val && val[1] ? val[0] : '';
    } else if ((m = /^--scope=([\s\S]*)/.exec(v)) || (short && (m = /^-s([\s\S]+)/.exec(v)))) {
      scope = lit ? m[1] : '';
    }
  }
  return scope === 'project';
}

function verdict(t, pin, bare, short) {
  const [v, lit] = t[0];
  if (!lit) return !pinned(t, true);
  if (/^(?:-h|--help|help)$/.test(v)) return false;
  if (v.startsWith('-')) return !pinned(t, true);
  if (bare.has(v)) return true;
  if (pin.has(v)) return !pinned(t.slice(1), short);
  return false;
}

function check(group, t) {
  if (!t.length) return false;
  if (group === 'mcp') return verdict(t, MCP_PIN, MCP_BARE, true);
  if (t[0][1] && t[0][0] === 'marketplace') {
    const rest = t.slice(1);
    return rest.length ? verdict(rest, MKT_PIN, MKT_BARE, false) : false;
  }
  return verdict(t, PLUGIN_PIN, PLUGIN_BARE, true);
}

function element(c) {
  if (!c.length) return ['', false];
  if (c.length === 1 && c[0][0] === 's') return [c[0][1], c[0][2]];
  return [c[0][0] === 's' ? c[0][1] : c.map((x) => x[1]).join(' '), false];
}

function arrays(toks) {
  const out = [];
  const fr = [];
  const open = { ']': '[', ')': '(', '}': '{' };
  for (const t of toks) {
    const [k, v] = t;
    const f = fr.at(-1);
    if (k === 'p' && /^[[({]$/.test(v)) {
      if (f && f.t === '[') f.cur.push(['o', v]);
      fr.push({ t: v, elems: [], cur: [], pos: t[3] });
      continue;
    }
    if (k === 'p' && open[v]) {
      if (!(f && f.t === open[v])) continue;
      fr.pop();
      if (v !== ']') continue;
      if (f.cur.length) f.elems.push(f.cur);
      out.push([f.pos, f.elems.map(element)]);
      continue;
    }
    if (!(f && f.t === '[')) continue;
    if (k === 'p') {
      f.elems.push(f.cur);
      f.cur = [];
      continue;
    }
    f.cur.push(t);
  }
  return out;
}

export function scan(files) {
  const report = [];
  for (const file of files) {
    let raw;
    try {
      raw = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      continue;
    }
    const js = /\.(?:[cm]?js|[cm]?ts)$/.test(file);
    const printed = new Set();
    const rawLines = raw.split('\n');
    for (let k = 0; k < rawLines.length; k++) {
      if (!/(?:#|\/\/)\s*cli-config-scope: printed\b/.test(rawLines[k])) continue;
      printed.add(k + 1);
      const h = /<<-?[ \t]*(["']?)([A-Za-z_]\w*)\1/.exec(rawLines[k]);
      if (!h) continue;
      const re = delimLine(h[2]);
      for (let m = k + 1; m < rawLines.length; m++) {
        printed.add(m + 1);
        if (re.test(rawLines[m])) break;
      }
    }
    const { text, map, toks } = lex(raw, js);
    const prog = new Set();
    for (const m of text.matchAll(/(?<![\w$])([A-Za-z_]\w*)[ \t]*=(?![=~])[ \t]*([^\n;]*)/g)) {
      if (/(?<![\w.-])claude(?![\w.-])/.test(m[2])) prog.add(m[1]);
    }
    const seen = new Set();
    const emit = (pos, call) => {
      const n = 1 + (text.slice(0, pos).match(/\n/g) ?? []).length;
      if (printed.has(n) || seen.has(n)) return;
      seen.add(n);
      report.push(`${file}:${n}: ${call.replace(/\s+/g, ' ').replace(/^ | $/g, '')}`);
    };
    const quote = (p) => {
      const q = p < map.length ? map[p] : '';
      return q === '"' || q === "'" || (js && q === '`') ? q : '';
    };
    for (const m of text.matchAll(/(?<![\w.-])claude(?![\w.-])|\$\{(\w+)[^}\n]*\}|\$(\w+)/g)) {
      const s = m.index;
      let e = s + m[0].length;
      const name = m[1] ?? m[2];
      if (name !== undefined && !(/claude/i.test(name) || prog.has(name))) continue;
      let q = quote(e);
      if (q !== '' && text[e] === q) {
        e++;
        q = quote(e);
      }
      const [w, end] = words(text, e, q);
      const g = findGroup(w, false);
      if (g < 0) continue;
      if (!check(w[g][0], w.slice(g + 1))) continue;
      emit(s, text.slice(s, end));
    }
    if (!js) continue;
    for (const [pos, el] of arrays(toks)) {
      const g = findGroup(el, true);
      if (g < 0) continue;
      if (!check(el[g][0], el.slice(g + 1))) continue;
      emit(pos, `[${el.map((x) => x[0]).join(', ')}]`);
    }
  }
  return report;
}

const fixtures = existsSync(join(ROOT, FIXTURES)) ? readdirSync(join(ROOT, FIXTURES)).sort() : [];

for (const name of fixtures.filter((f) => f.startsWith('bad.'))) {
  test(`fixture ${name}: exactly the VIOLATION lines are flagged`, () => {
    const rel = `${FIXTURES}/${name}`;
    const expected = readFileSync(join(ROOT, rel), 'utf8')
      .split('\n')
      .flatMap((l, i) => (l.includes('VIOLATION') ? [i + 1] : []))
      .join(' ');
    const got = scan([rel])
      .map((l) => Number(/^[^:]+:(\d+):/.exec(l)[1]))
      .sort((a, b) => a - b)
      .join(' ');
    assert.ok(got !== '' && got === expected, `cli-config-scope self-test: ${name} — expected lines [${expected}], flagged [${got}]`);
  });
}

for (const name of fixtures.filter((f) => f.startsWith('good.'))) {
  test(`fixture ${name}: no findings`, () => {
    const out = scan([`${FIXTURES}/${name}`]);
    assert.deepEqual(out, [], `cli-config-scope self-test: false positives in ${name}:\n${out.join('\n')}`);
  });
}

test('claude CLI config calls pinned to project scope', () => {
  const allowed = new Set(
    existsSync(join(ROOT, ALLOWLIST))
      ? readFileSync(join(ROOT, ALLOWLIST), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l))
      : [],
  );
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files', '--', '*.sh', '*.mjs', '*.js', '*.ts'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    assert.fail('Cli-config-scope: FAIL — git ls-files failed; run from a git checkout');
  }
  const files = tracked
    .split('\n')
    .filter((f) => f !== '' && !/(^|\/)(tests?|dist|node_modules)\//.test(f) && !allowed.has(f))
    .sort();
  const out = scan(files);
  assert.deepEqual(
    out,
    [],
    `Cli-config-scope: FAIL — config-changing claude plugin/mcp calls not pinned to project scope (the CLI default can reach user scope):\n${out.join('\n')}`,
  );
});
