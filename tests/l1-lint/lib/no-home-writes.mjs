// Rules, allowlist and scope of the no-home-writes L1 lint, shared by its whole-tree test and file-lint.ts.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ALLOWLIST = 'tests/l1-lint/no-home-writes.allowlist';
const HOME_SH = /\$\{?HOME\b\}?|(?:^|[\s"=:(])~\//;
const HOME_TS = /\bhomedir\s*\(\s*\)|process\.env(?:\.HOME\b|\[\s*["']HOME["']\s*\])/;
const COMMENT = /^\s*(#|\/\/|\*)/;
const TS_WRITE = /\b(?:writeFileSync|mkdirSync|appendFileSync|cpSync|renameSync|symlinkSync|writeFile|mkdir|appendFile)\s*\(([^;]*)/g;
const SH_REDIRECT = /(?<![0-9&<>])>>?\s*("[^"]*"|'[^']*'|[^\s;|&)]+)/g;

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
    const ts = file.endsWith('.ts');
    const lines = rawLines(text).map((l) => l.replace(ts ? /\s+\/\/\s.*(?=\n?$)/ : /\s+#\s.*(?=\n?$)/, ''));
    const home = ts ? HOME_TS : HOME_SH;
    const taint = new Set();
    const mentions = (s, t) => (ts ? new RegExp(String.raw`\b${t}\b`) : new RegExp(String.raw`\$\{?${t}\b`)).test(s);
    if (ts) {
      taint.add('homeDir');
      let fn;
      for (const l of lines) {
        const m = /\bfunction\s+([A-Za-z_]\w*)\s*\(/.exec(l);
        if (m) fn = m[1];
        if (fn !== undefined && /\breturn\b/.test(l) && home.test(l) && !l.includes('TMB_MODEL_CACHE_DIR')) taint.add(fn);
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const l of lines) {
        if (COMMENT.test(l) || l.includes('TMB_MODEL_CACHE_DIR')) continue;
        const m = ts
          ? /\b(?:const|let|var)\s+([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*(.*)/.exec(l)
          : /^\s*(?:local\s+|export\s+|readonly\s+)?([A-Za-z_]\w*)=(.*)/.exec(l);
        if (!m) continue;
        const [, name, rhs] = m;
        if (taint.has(name)) continue;
        if (ts && /\b(?:readFileSync|readdirSync|existsSync|statSync|lstatSync|JSON\.parse)\b/.test(rhs)) continue;
        if (!ts && /\$\((?!\s*dirname\b)/.test(rhs)) continue;
        if (home.test(rhs) || [...taint].some((t) => mentions(rhs, t))) {
          taint.add(name);
          changed = true;
        }
      }
    }
    const refs = (s) => home.test(s) || [...taint].some((t) => mentions(s, t));
    lines.forEach((l, idx) => {
      if (COMMENT.test(l) || l.includes('TMB_MODEL_CACHE_DIR')) return;
      let bad = false;
      if (ts) {
        for (const m of l.matchAll(TS_WRITE)) if (refs(m[1])) bad = true;
      } else {
        for (const m of l.matchAll(SH_REDIRECT)) {
          if (/^\/dev\/null$|^&/.test(m[1])) continue;
          if (refs(m[1])) bad = true;
        }
        for (const seg of l.split(/&&|\|\||;|\|/)) {
          const w = /(?:^|\s)(mkdir|tee|touch)\s+(.*)/.exec(seg);
          if (w) {
            if (refs(w[2])) bad = true;
            continue;
          }
          const c = /(?:^|\s)(cp|mv|ln|install)\s+(.*)/.exec(seg);
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

function find(root, dir, match, out, depth = Infinity) {
  if (!existsSync(join(root, dir))) return out;
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (depth > 1) find(root, rel, match, out, depth - 1);
    } else if (entry.isFile() && match(rel)) out.push(rel);
  }
  return out;
}

function allowed(root) {
  return new Set(
    existsSync(join(root, ALLOWLIST)) ? readFileSync(join(root, ALLOWLIST), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)) : [],
  );
}

const l5l6Ts = (rel) => rel.endsWith('.ts') && !rel.endsWith('.test.ts');
const serverTs = (rel) => rel.endsWith('.ts') && !rel.includes('/test/');

export function scope(root = ROOT) {
  const allow = allowed(root);
  return (rel) =>
    !allow.has(rel) &&
    ((/^tests\/l5-l6\/(lib\/)?[^/]+$/.test(rel) && l5l6Ts(rel)) ||
      (rel.startsWith('mcp/trajectory-server/src/') && serverTs(rel)));
}

export function files(root = ROOT) {
  const allow = allowed(root);
  return [
    ...[...find(root, 'tests/l5-l6', l5l6Ts, [], 1), ...find(root, 'tests/l5-l6/lib', l5l6Ts, [], 1)].sort(),
    ...find(root, 'mcp/trajectory-server/src', serverTs, []).sort(),
  ].filter((f) => !allow.has(f));
}
