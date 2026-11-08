// Rules, allowlist and scope of the no-cwd-reads L1 lint, shared by its whole-tree test and file-lint.ts; scanFile checks one file without the whole-tree stale-entry check.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..', '..');
const ALLOWLIST_REL = 'tests/l1-lint/cwd-allowlist.tsv';
export const ALLOWLIST = join(ROOT, ALLOWLIST_REL);

const SH_CWD_RE = /\$PWD|\$\{PWD|(^|[^A-Za-z0-9_./-])pwd([^A-Za-z0-9_-]|$)|\.cwd([^A-Za-z0-9_]|$)|tmb_payload_cwd|tmb_cmd_cwd/;
const SH_GIT_RE = /(^|[;&|({!]|\$\(|(then|do|else|if|while|until|exec|command|time|env)\s)\s*git\s/;
const SH_GIT_C_RE = /git\s+-C\s/;
const DQ_TEXT_RE = /"([^"$\\]|\\.|\$[^(])*"/;
const SQ_TEXT_RE = /'[^']*'/;
const JOIN_RE = /(tmb_cmd_statements|tmb_cmd_write_paths|tmb_stmt_repo_root) "[^"]*" "\$\(tmb_payload_cwd "\$[A-Za-z_]+"\)"/g;
const CONCAT_RE = /"\$\(tmb_payload_cwd "\$[A-Za-z_]+"\)\//g;
const CANON_RE = /&& pwd( -P)?( \|\| [^)]*)?\)/g;
const TS_CWD_RE = /process.cwd/;
const TS_SPAWN_RE = /(^|[^A-Za-z0-9_.])(spawn|spawnSync|execFile|execFileSync)\(/;
const TS_ANCHOR_RE = /cwd|projectSpawnOptions[(]|'-C',/;
const CATEGORIES = ' self-location canonicalize join-base anchored-cd fallback test-harness not-location ';
const EXTENSIONS = /\.(sh|ts|mjs|js)$/;

function lines(path) {
  const out = readFileSync(path, 'utf8').split('\n');
  if (out.at(-1) === '') out.pop();
  return out;
}

function readFields(line, count) {
  const fields = [];
  let rest = line.replace(/^\t+/, '');
  for (let i = 0; i < count - 1; i++) {
    const tab = rest.indexOf('\t');
    fields.push(tab < 0 ? rest : rest.slice(0, tab));
    rest = tab < 0 ? '' : rest.slice(tab).replace(/^\t+/, '');
  }
  fields.push(rest.replace(/\t+$/, ''));
  return fields;
}

function readAllowlist(allowlist, errors) {
  const entries = [];
  if (!existsSync(allowlist)) return entries;
  for (const line of lines(allowlist)) {
    if (line === '' || line.startsWith('#')) continue;
    const [file, sub, category, reason] = readFields(line, 4);
    if (!file || !sub || !reason.replaceAll(' ', '')) {
      errors.push(`  ✗ ${allowlist}: entry '${line}' needs <path>\t<substring>\t<category>\t<reason>`);
      continue;
    }
    if (!CATEGORIES.includes(` ${category} `)) {
      errors.push(`  ✗ ${allowlist}: entry '${file}\t${sub}' has category '${category}', not one of${CATEGORIES}`);
      continue;
    }
    entries.push({ file, sub, used: false });
  }
  return entries;
}

function isComment(line, kind) {
  const trimmed = line.replace(/^\s+/, '');
  return kind === 'sh' ? trimmed.startsWith('#') : /^(\/\/|\/\*|\*)/.test(trimmed);
}

function codeOnly(line) {
  let s = line;
  for (const re of [DQ_TEXT_RE, SQ_TEXT_RE]) {
    let m;
    while ((m = re.exec(s))) s = s.slice(0, m.index) + 'Q' + s.slice(m.index + m[0].length);
  }
  return s;
}

function shellHits(path) {
  const hits = [];
  lines(path).forEach((line, i) => {
    if (isComment(line, 'sh')) return;
    if (SH_CWD_RE.test(line)) {
      const rest = line.replace(CANON_RE, '').replace(JOIN_RE, '').replace(CONCAT_RE, '');
      if (SH_CWD_RE.test(rest)) {
        hits.push({ n: i + 1, what: 'reads the cwd', line });
        return;
      }
    }
    if (!SH_GIT_RE.test(line)) return;
    const code = codeOnly(line);
    if (SH_GIT_RE.test(code) && !SH_GIT_C_RE.test(code)) hits.push({ n: i + 1, what: 'runs git with no -C', line });
  });
  return hits;
}

function tsHits(path) {
  const text = lines(path);
  const hits = [];
  text.forEach((t, i) => {
    if (/^(\/\/|\/\*|\*)/.test(t.replace(/^[ \t]+/, ''))) return;
    if (TS_CWD_RE.test(t)) {
      hits.push({ n: i + 1, what: 'reads process.cwd()', line: t });
      return;
    }
    if (TS_SPAWN_RE.test(t) && !text.slice(i, i + 4).some((l) => TS_ANCHOR_RE.test(l))) {
      hits.push({ n: i + 1, what: 'spawns with no cwd', line: t });
    }
  });
  return hits;
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) walk(path, out);
    else if (e.isFile() && EXTENSIONS.test(e.name)) out.push(path);
  }
}

export function files(root = ROOT) {
  const skills = isDir(join(root, 'skills'))
    ? readdirSync(join(root, 'skills'))
        .filter((n) => !n.startsWith('.'))
        .sort()
        .map((n) => join(root, 'skills', n, 'scripts'))
    : [];
  const out = [];
  for (const d of [join(root, 'scripts'), ...skills, join(root, 'mcp/trajectory-server/src'), join(root, 'tests/lib')]) {
    if (!isDir(d) || lstatSync(d).isSymbolicLink()) continue;
    walk(d, out);
  }
  const testDir = join(root, 'mcp/trajectory-server/src/test') + '/';
  return [...new Set(out)].filter((p) => !p.startsWith(testDir) && !p.includes('/node_modules/')).sort();
}

export function scan(root = ROOT, allowlist = ALLOWLIST) {
  if (!isDir(root)) throw new Error(`no-cwd-reads: no root ${root}`);
  const errors = [];
  const entries = readAllowlist(allowlist, errors);
  let hits = 0;
  for (const path of files(root)) {
    const rel = path.slice(root.length + 1);
    for (const { n, what, line } of unallowed(root, rel, entries)) {
      errors.push(`  ✗ ${rel}:${n} ${what}: ${line}`);
      hits++;
    }
  }
  for (const e of entries) {
    if (!e.used) errors.push(`  ✗ ${allowlist}: stale entry '${e.file}\t${e.sub}' matches no hit`);
  }
  return { ok: errors.length === 0 && hits === 0, out: errors.join('\n') };
}

function unallowed(root, rel, entries) {
  const out = [];
  for (const { n, what, line: raw } of rel.endsWith('.sh') ? shellHits(join(root, rel)) : tsHits(join(root, rel))) {
    const line = raw.replace(/^\t+/, '').replace(/\t+$/, '');
    let ok = false;
    for (const e of entries) {
      if (e.file !== rel || !line.includes(e.sub)) continue;
      ok = true;
      e.used = true;
    }
    if (!ok) out.push({ n, what, line: line.replace(/^\s+/, '') });
  }
  return out;
}

export function scope() {
  return (rel) =>
    EXTENSIONS.test(rel) &&
    !`/${rel}`.includes('/node_modules/') &&
    (rel.startsWith('scripts/') ||
      /^skills\/[^./][^/]*\/scripts\//.test(rel) ||
      (rel.startsWith('mcp/trajectory-server/src/') && !rel.startsWith('mcp/trajectory-server/src/test/')) ||
      rel.startsWith('tests/lib/'));
}

export function scanFile(root, rel, allowlist = join(root, ALLOWLIST_REL)) {
  return unallowed(root, rel, readAllowlist(allowlist, [])).map(({ n, what, line }) => `${rel}:${n}: ${what}: ${line}`);
}
