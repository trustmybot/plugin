// L1 lint: every mktemp in tests/ and scripts/ (*.sh) passes an explicit path template. BSD mktemp (macOS) puts a bare `mktemp`, `mktemp -d`, `mktemp -t X` or `mktemp -d -t X` under DARWIN_USER_TEMP_DIR and ignores TMPDIR, which the Bash sandbox does not let a command write; GNU mktemp honours TMPDIR. A template is honoured by both. macOS's TMPDIR ends in a slash, so the parent drops every trailing slash; a raw `${TMPDIR:-/tmp}/` parent yields a `//` that hooks normalise away and path comparisons then miss: D=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-<name>.XXXXXX"). A call is a mktemp in command position (line start, after `$(`, a backtick, or `;` `&` `|` and a space); its first non-flag argument must contain a `/` and `XXX`, and must not start its path at `${TMPDIR...}/`. `-t` and `-p`/`--tmpdir` consume their argument. Comment lines are skipped. Allowlist: tests/l1-lint/no-bare-mktemp.allowlist — <path><TAB><substring of the line><TAB><reason>; an entry with no reason or matching no hit fails. Every run also checks fixtures/no-bare-mktemp/: every `# VIOLATION` line of bad.txt is reported and nothing in good.txt (the fixtures are .txt so neither this scan nor a repo-wide grep of *.sh picks up their deliberate hits).
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOWLIST = 'tests/l1-lint/no-bare-mktemp.allowlist';
const FIXTURES = 'tests/l1-lint/fixtures/no-bare-mktemp';
const CALL = /(?:(?<!\\)\$\(\s*|`\s*|^\s*|[;&|]\s+)mktemp(?![\w.-])/g;
const TMPDIR_PARENT = /^["']?\$\{TMPDIR(?::?[-=+?][^}]*)?\}\//;

function read(rel) {
  try {
    return readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    return null;
  }
}

function lines(text) {
  const out = text.split('\n');
  if (out.at(-1) === '') out.pop();
  return out;
}

function firstArg(rest) {
  const tokens = [];
  let tok = '';
  let depth = 0;
  let q = '';
  const c = [...rest];
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (q) {
      tok += ch;
      if (ch === '\\' && q === '"') {
        tok += c[++i] ?? '';
        continue;
      }
      if (ch === '$' && c[i + 1] === '(') {
        depth++;
        tok += c[++i];
        continue;
      }
      if (ch === ')' && depth) {
        depth--;
        continue;
      }
      if (ch === q && !depth) q = '';
      continue;
    }
    if (ch === '$' && c[i + 1] === '(') {
      depth++;
      tok += '$(';
      i++;
      continue;
    }
    if (ch === ')' && depth) {
      depth--;
      tok += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      tok += ch;
      continue;
    }
    if (!depth && /[)`;|&#]/.test(ch)) break;
    if (!depth && /\s/.test(ch)) {
      if (tok.length) tokens.push(tok);
      tok = '';
      continue;
    }
    tok += ch;
  }
  if (tok.length) tokens.push(tok);
  while (tokens.length) {
    const t = tokens.shift();
    if (/^\d*[<>]/.test(t)) continue;
    if (/^-(?:t|p)$/.test(t) || t === '--tmpdir' || t === '--suffix') {
      tokens.shift();
      continue;
    }
    if (t.startsWith('-')) continue;
    return t;
  }
  return undefined;
}

export function scan(allowlist, files) {
  const out = [];
  const allow = [];
  const al = allowlist ? read(allowlist) : null;
  if (al !== null) {
    lines(al).forEach((line, idx) => {
      if (/^\s*(#|$)/.test(line)) return;
      const parts = line.split('\t');
      const [path, sub] = parts;
      const reason = parts.length > 2 ? parts.slice(2).join('\t') : undefined;
      if (sub === undefined || reason === undefined || !/\S/.test(reason)) {
        out.push(`ALLOWLIST ${allowlist}:${idx + 1}: needs <path><TAB><substring><TAB><reason>`);
        return;
      }
      allow.push({ path, sub, used: false });
    });
  }
  for (const file of files) {
    const text = read(file);
    if (text === null) continue;
    lines(text).forEach((l, idx) => {
      if (/^\s*#/.test(l)) return;
      for (const m of l.matchAll(CALL)) {
        const arg = firstArg(l.slice(m.index + m[0].length));
        if (arg !== undefined && arg.includes('/') && arg.includes('XXX') && !TMPDIR_PARENT.test(arg)) continue;
        const hit = allow.find((a) => a.path === file && l.includes(a.sub));
        if (hit) {
          hit.used = true;
          continue;
        }
        out.push(`${file}:${idx + 1}: ${l.replace(/^\s+/, '')}`);
      }
    });
  }
  for (const a of allow) if (!a.used) out.push(`ALLOWLIST ${allowlist}: stale entry (no hit): ${a.path}\t${a.sub}`);
  return out;
}

function shellFiles(dir, out) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') shellFiles(rel, out);
    } else if (entry.isFile() && entry.name.endsWith('.sh')) out.push(rel);
  }
  return out;
}

test('fixture bad.txt: every VIOLATION line is reported', () => {
  const bad = scan(null, [`${FIXTURES}/bad.txt`]);
  const expected = lines(read(`${FIXTURES}/bad.txt`)).filter((l) => l.includes('VIOLATION')).length;
  const ok = bad.filter((l) => l.includes('VIOLATION')).length === expected && bad.every((l) => l.includes('VIOLATION'));
  assert.ok(ok, `no-bare-mktemp self-test: expected ${expected} violations in bad.txt, got:\n${bad.join('\n')}`);
});

test('fixture good.txt: no violations', () => {
  const good = scan(null, [`${FIXTURES}/good.txt`]);
  assert.deepEqual(good, [], `no-bare-mktemp self-test: false positives in good.txt:\n${good.join('\n')}`);
});

test('no bare mktemp (explicit path template)', () => {
  const files = [];
  for (const dir of ['tests', 'scripts']) if (existsSync(join(ROOT, dir))) shellFiles(dir, files);
  const out = scan(ALLOWLIST, files.sort());
  assert.deepEqual(
    out,
    [],
    `No-bare-mktemp: FAIL — mktemp without a slash-stripped path template (BSD mktemp ignores TMPDIR and the sandbox denies its default dir; a raw \${TMPDIR:-/tmp}/ parent doubles macOS's trailing slash).\nUse: D=$(mktemp -d "$(printf %s "\${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-<name>.XXXXXX")\n${out.join('\n')}`,
  );
});
