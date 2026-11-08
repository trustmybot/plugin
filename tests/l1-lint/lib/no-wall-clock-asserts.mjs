// Rules, allowlist and scope of the no-wall-clock-asserts L1 lint, shared by its whole-tree test and file-lint.ts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const ALLOWLIST = 'tests/l1-lint/no-wall-clock-asserts.allowlist';
const DIRS = ['tests', 'dashboard/test', 'mcp/trajectory-server/src/test'];
const EXTS = ['.sh', '.ts', '.tsx', '.js', '.mjs'];

const VAR = String.raw`[A-Za-z_]\w*`;
const NUM = String.raw`\d[\d_]*(?:\.\d+)?`;
const SH_DIFF = String.raw`(?:\bSECONDS|date\s+\+%s\)?)\s*-\s*\$?\{?${VAR}`;
const TS_DIFF = String.raw`(?:Date\.now|performance\.now)\(\)\s*-\s*[A-Za-z_$][\w.$]*`;
const TS_CMP = String.raw`(?:<=?|>=?)\s*${NUM}\b`;
const TS_RCMP = String.raw`\b${NUM}\s*(?:<=?|>=?)`;
const TS_MATCHER = String.raw`\.to(?:BeLessThan|BeLessThanOrEqual|BeGreaterThan|BeGreaterThanOrEqual)\(\s*${NUM}\s*\)`;

const COMMENT = /^\s*(?:#|\/\/|\*|\/\*)/;
const SH_FILE = /\.sh(?:\.txt)?$/;
const SH_ASSIGN = new RegExp(String.raw`^\s*(?:local\s+|export\s+|readonly\s+)?(${VAR})=.*${SH_DIFF}`);
const SH_DIFF_RE = new RegExp(SH_DIFF);
const SH_TEST_CMP = /\s-(?:lt|le|gt|ge)\s/;
const SH_ARITH_CMP = /\(\(.*[<>]/;
const TS_ASSIGN = new RegExp(String.raw`\b(?:const|let|var)\s+(${VAR})\s*(?::\s*\w+\s*)?=\s*${TS_DIFF}`);
const TS_INLINE = [
  new RegExp(String.raw`${TS_DIFF}\s*\)?\s*${TS_CMP}`),
  new RegExp(String.raw`${TS_RCMP}\s*\(?\s*${TS_DIFF}`),
  new RegExp(String.raw`expect\(\s*\(?\s*${TS_DIFF}\s*\)?\s*\)${TS_MATCHER}`),
];

function shVarHits(v) {
  return [new RegExp(String.raw`\$\{?${v}\b`), new RegExp(String.raw`\(\(.*\b${v}\b\s*[<>]`)];
}

function tsVarHits(v) {
  return [
    new RegExp(String.raw`(?<![\w.$])${v}\s*${TS_CMP}`),
    new RegExp(String.raw`${TS_RCMP}\s*${v}\b`),
    new RegExp(String.raw`expect\(\s*${v}\s*\)${TS_MATCHER}`),
  ];
}

export function readLines(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function loadAllowlist(allowlist, out, root) {
  const allow = [];
  let lines;
  try {
    lines = readLines(allowlist.startsWith('/') ? allowlist : join(root, allowlist));
  } catch {
    return { allow, bad: false };
  }
  let bad = false;
  lines.forEach((line, i) => {
    if (/^\s*(?:#|$)/.test(line)) return;
    const t1 = line.indexOf('\t');
    const t2 = t1 < 0 ? -1 : line.indexOf('\t', t1 + 1);
    const reason = t2 < 0 ? '' : line.slice(t2 + 1);
    if (t2 < 0 || !/\S/.test(reason)) {
      out.push(`ALLOWLIST ${allowlist}:${i + 1}: needs <path><TAB><substring><TAB><reason>`);
      bad = true;
      return;
    }
    allow.push({ path: line.slice(0, t1), sub: line.slice(t1 + 1, t2), used: false });
  });
  return { allow, bad };
}

function isHit(line, sh, elapsed) {
  if (sh) {
    if (!SH_TEST_CMP.test(line) && !SH_ARITH_CMP.test(line)) return false;
    if (SH_DIFF_RE.test(line)) return true;
    return [...elapsed].some((v) => shVarHits(v).some((re) => re.test(line)));
  }
  if (TS_INLINE.some((re) => re.test(line))) return true;
  return [...elapsed].some((v) => tsVarHits(v).some((re) => re.test(line)));
}

export function scan(allowlist, files, root = ROOT) {
  const out = [];
  const { allow, bad: allowBad } = loadAllowlist(allowlist, out, root);
  let bad = allowBad;
  for (const file of files) {
    const sh = SH_FILE.test(file);
    const elapsed = new Set();
    let lines;
    try {
      lines = readLines(join(root, file));
    } catch {
      continue;
    }
    lines.forEach((line, i) => {
      if (COMMENT.test(line)) return;
      const assigned = (sh ? SH_ASSIGN : TS_ASSIGN).exec(line);
      if (assigned) elapsed.add(assigned[1]);
      if (!isHit(line, sh, elapsed)) return;
      const ok = allow.find((a) => a.path === file && line.includes(a.sub));
      if (ok) {
        ok.used = true;
        return;
      }
      out.push(`${file}:${i + 1}: ${line.replace(/^\s+/, '')}`);
      bad = true;
    });
  }
  for (const a of allow.filter((x) => !x.used)) {
    out.push(`ALLOWLIST ${allowlist}: stale entry (no hit): ${a.path}\t${a.sub}`);
    bad = true;
  }
  return { ok: !bad, out };
}

function walk(root, dir, out) {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(root, rel, out);
    } else if (e.isFile() && EXTS.some((x) => e.name.endsWith(x))) {
      out.push(rel);
    }
  }
}

export function scope() {
  return (rel) => DIRS.some((d) => rel.startsWith(`${d}/`)) && !rel.split('/').includes('node_modules') && EXTS.some((x) => rel.endsWith(x));
}

export function testFiles(root = ROOT) {
  const out = [];
  for (const d of DIRS) {
    let dir = false;
    try {
      dir = statSync(join(root, d)).isDirectory();
    } catch {}
    if (dir) walk(root, d, out);
  }
  return out.sort();
}
