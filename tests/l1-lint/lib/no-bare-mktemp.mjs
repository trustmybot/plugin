// Rules, allowlist and scope of the no-bare-mktemp L1 lint, shared by its whole-tree test and file-lint.ts.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const ALLOWLIST = 'tests/l1-lint/no-bare-mktemp.allowlist';
const DIRS = ['tests', 'scripts'];
const CALL = /(?:(?<!\\)\$\(\s*|`\s*|^\s*|[;&|]\s+)mktemp(?![\w.-])/g;
const TMPDIR_PARENT = /^["']?\$\{TMPDIR(?::?[-=+?][^}]*)?\}\//;

export function read(rel, root = ROOT) {
  try {
    return readFileSync(join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

export function lines(text) {
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

export function scan(allowlist, files, root = ROOT) {
  const out = [];
  const allow = [];
  const al = allowlist ? read(allowlist, root) : null;
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
    const text = read(file, root);
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

function shellFiles(root, dir, out) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') shellFiles(root, rel, out);
    } else if (entry.isFile() && entry.name.endsWith('.sh')) out.push(rel);
  }
  return out;
}

export function scope() {
  return (rel) => DIRS.some((d) => rel.startsWith(`${d}/`)) && !rel.split('/').includes('node_modules') && rel.endsWith('.sh');
}

export function files(root = ROOT) {
  const out = [];
  for (const dir of DIRS) if (existsSync(join(root, dir))) shellFiles(root, dir, out);
  return out.sort();
}
