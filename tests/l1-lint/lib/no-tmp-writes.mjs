// Rules, allowlist and scope of the no-tmp-writes L1 lint, shared by its whole-tree test and file-lint.ts.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ALLOWLIST = 'tests/l1-lint/no-tmp-writes.allowlist';
const TMP = String.raw`(?<![\w.$}/-])/(?:private/|var/)?tmp(?![\w.-])`;
const TMP_START = new RegExp(String.raw`^\s*["'\x60]?${TMP}`);
const TMPDIR_ASSIGN = new RegExp(String.raw`(?:^|[\s;&|(])(?:export\s+)?TMPDIR=["']?${TMP}`);
const WRITE_FN =
  /\b(?:writeFileSync|mkdirSync|mkdtempSync|appendFileSync|cpSync|copyFileSync|renameSync|symlinkSync|createWriteStream|writeFile|mkdir|mkdtemp|appendFile)\s*\(([^;]*)/g;
const COMMENT = /^\s*(#|\/\/|\*)/;
const SH_REDIRECT = /(?<![0-9&<>])>>?\s*("[^"]*"|'[^']*'|[^\s;|&)]+)/g;
const PROSE_DIRS = ['scripts', 'skills', 'agents', 'commands'];
const PROSE_EXT = /\.(?:js|mjs|cjs|ts|py|md)$/;
const SERVER_SRC = 'mcp/trajectory-server/src';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function rawLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function scan(files, root = ROOT) {
  const out = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    const code = /\.(?:[cm]?js|ts|py)$/.test(file);
    const lines = rawLines(text).map((l) =>
      l.replace(/\$\{TMPDIR:?-\/(?:private\/|var\/)?tmp\}/g, '$$TMPDIR').replace(code ? /\s+(?:\/\/|#)\s.*(?=\n?$)/ : /\s+#\s.*(?=\n?$)/, ''),
    );
    const taint = new Set();
    const refTaint = (s, t) =>
      (code ? new RegExp(String.raw`^\s*["'\x60]?\$?\{?${escapeRe(t)}\b`) : new RegExp(String.raw`^\s*"?\$\{?${escapeRe(t)}\b`)).test(s);
    let changed = true;
    while (changed) {
      changed = false;
      for (const l of lines) {
        if (COMMENT.test(l)) continue;
        const m = code
          ? /^\s*(?:(?:const|let|var)\s+)?([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)\s*(.*)/.exec(l)
          : /^\s*(?:local\s+|export\s+|readonly\s+)?([A-Za-z_]\w*)=(.*)/.exec(l);
        if (!m) continue;
        const [, name, rhs] = m;
        if (taint.has(name)) continue;
        if (TMP_START.test(rhs) || [...taint].some((t) => refTaint(rhs, t))) {
          taint.add(name);
          changed = true;
        }
      }
    }
    const refs = (s) => TMP_START.test(s) || [...taint].some((t) => refTaint(s, t));
    lines.forEach((l, idx) => {
      if (COMMENT.test(l)) return;
      let bad = false;
      if (code) {
        for (const m of l.matchAll(WRITE_FN)) if (refs(m[1])) bad = true;
        const o = /\bopen\s*\(([^,]*),\s*["'][wax]/.exec(l);
        if (o && refs(o[1])) bad = true;
      } else {
        for (const m of l.matchAll(SH_REDIRECT)) {
          if (/^\/dev\/null$|^&/.test(m[1])) continue;
          if (refs(m[1])) bad = true;
        }
        if (TMPDIR_ASSIGN.test(l)) bad = true;
        for (const seg of l.split(/&&|\|\||;|\|/)) {
          const w = /(?:^|[\s(])(mkdir|tee|touch|mktemp)\s+(.*)/.exec(seg);
          if (w) {
            const args = w[2].split(/\s+|=/).filter((a) => a !== '' && !/^-[^-]*$/.test(a));
            for (const a of args) if (refs(a)) bad = true;
            continue;
          }
          const c = /(?:^|[\s(])(cp|mv|ln|install|rsync)\s+(.*)/.exec(seg);
          if (c) {
            const args = c[2].split(/\s+/).filter((a) => a !== '' && !a.startsWith('-') && !/^\d*>/.test(a));
            if (args.length && refs(args.at(-1))) bad = true;
          }
        }
      }
      if (bad) out.push(`${file}:${idx + 1}: ${l.replace(/\n$/, '').replace(/^\s+/, '')}`);
    });
  }
  return out;
}

function find(root, dir, match, out) {
  if (!existsSync(join(root, dir))) return out;
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') find(root, rel, match, out);
    } else if (entry.isFile() && match(rel)) out.push(rel);
  }
  return out;
}

function allowed(root) {
  return new Set(
    existsSync(join(root, ALLOWLIST)) ? readFileSync(join(root, ALLOWLIST), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)) : [],
  );
}

export function scope(root = ROOT) {
  const allow = allowed(root);
  return (rel) =>
    !allow.has(rel) &&
    !rel.split('/').includes('node_modules') &&
    ((PROSE_DIRS.some((d) => rel.startsWith(`${d}/`)) && PROSE_EXT.test(rel)) || (rel.startsWith(`${SERVER_SRC}/`) && rel.endsWith('.ts')));
}

export function files(root = ROOT) {
  const allow = allowed(root);
  return [
    ...PROSE_DIRS.flatMap((d) => find(root, d, (rel) => PROSE_EXT.test(rel), [])).sort(),
    ...find(root, SERVER_SRC, (rel) => rel.endsWith('.ts'), []).sort(),
  ].filter((f) => !allow.has(f));
}
