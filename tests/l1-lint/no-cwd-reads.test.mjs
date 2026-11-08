// L1 lint: nothing finds the project, a repo or an agent from the working directory (GH 1550, GH 1553). Claude Code gives bro and every subagent one working directory, and the MCP server inherits whatever directory it was started in, so the cwd says nothing about which project, repo or worktree a call is for. The project comes from the trajectory DB (tmb_project_root, the server's DB path), a repo from its repos row, an agent from its spawn transcript and the DB. Scope: scripts/ (scripts/hooks/ included), skills/*/scripts/, mcp/trajectory-server/src/ (src/test/ excluded) and tests/lib/; *.sh are read as shell, *.ts / *.mjs / *.js as TypeScript. Comment lines are skipped. Shell hits: $PWD, ${PWD…}, a bare `pwd`, the payload `.cwd`, tmb_payload_cwd, tmb_cmd_cwd; a `git` command with no `-C` on its line (git named inside quoted text, such as a deny message, is not a command). TypeScript hits: process.cwd(); a spawn( / spawnSync( / execFile( / execFileSync( call whose line and next 3 lines carry no `cwd`, projectSpawnOptions( or git's `'-C',`. Exempt without an entry: canonicalizing a named dir (`(cd <dir> … && pwd)`, `&& pwd -P)`, `&& pwd -P || <fallback>)`, which covers the self-location `cd "$(dirname …)" && pwd`), and the payload cwd as the join base of a command's relative paths (the <cwd> argument of tmb_cmd_statements / tmb_cmd_write_paths / tmb_stmt_repo_root, or `"$(tmb_payload_cwd "$IN")/<relative>"`). Any other hit needs a cwd-allowlist.tsv entry `<path from the root>\t<substring of the line>\t<category>\t<reason>`, category one of self-location, canonicalize, join-base, anchored-cd, fallback, test-harness, not-location (a command that reads no location, such as `gh auth status`, or the cwd recorded as data). An entry with an unknown category, no reason, or one no hit matches any more fails too. scan(root, allowlist) takes the tree and allowlist to check; the cases below plant trees through it.
import { strict as assert } from 'node:assert';
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ALLOWLIST = join(HERE, 'cwd-allowlist.tsv');

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
const FAIL_HINT =
  "no-cwd-reads: FAIL — find the project from the trajectory DB (tmb_project_root), a repo from its repos row (git -C <path>, spawn with cwd), an agent from its spawn transcript (src/hooks/lib/agent-context.ts); the cwd only joins a command's relative paths (GH 1553). A legitimate read takes a cwd-allowlist.tsv entry with its category and reason.";

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

function files(root) {
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
    for (const { n, what, line: raw } of path.endsWith('.sh') ? shellHits(path) : tsHits(path)) {
      const line = raw.replace(/^\t+/, '').replace(/\t+$/, '');
      let ok = false;
      for (const e of entries) {
        if (e.file !== rel || !line.includes(e.sub)) continue;
        ok = true;
        e.used = true;
      }
      if (ok) continue;
      errors.push(`  ✗ ${rel}:${n} ${what}: ${line.replace(/^\s+/, '')}`);
      hits++;
    }
  }
  for (const e of entries) {
    if (!e.used) errors.push(`  ✗ ${allowlist}: stale entry '${e.file}\t${e.sub}' matches no hit`);
  }
  return { ok: errors.length === 0 && hits === 0, out: errors.join('\n') };
}

test('nothing finds the project or a repo from the cwd', () => {
  const r = scan();
  assert.ok(r.ok, `${r.out}\n${FAIL_HINT}`);
});

describe('planted trees', () => {
  let tmp;
  before(() => {
    tmp = mkdtempSync(join((process.env.TMPDIR || tmpdir()).replace(/\/+$/, ''), 'tmb-no-cwd-reads.'));
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  const lint = (root, allow = join(root, 'allow.tsv')) => scan(root, allow);

  function fixture(name, rel, line) {
    const root = join(tmp, name);
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), `${line}\n`);
    writeFileSync(join(root, 'allow.tsv'), '');
    return root;
  }

  for (const [label, name, rel, line, phrase] of [
    ['a planted process.cwd()', 'ts-cwd', 'mcp/trajectory-server/src/root.ts', 'const root = process.cwd();', 'mcp/trajectory-server/src/root.ts:1 reads process.cwd()'],
    ['a planted $PWD', 'sh-pwd', 'scripts/root.sh', 'ROOT="$PWD"', 'scripts/root.sh:1 reads the cwd'],
    ['a bare git status', 'sh-git', 'scripts/st.sh', 'git status --porcelain', 'scripts/st.sh:1 runs git with no -C'],
    ['a spawnSync with no cwd', 'ts-spawn', 'mcp/trajectory-server/src/run.ts', "const r = spawnSync('x', []);", 'mcp/trajectory-server/src/run.ts:1 spawns with no cwd'],
  ]) {
    test(`fails on ${label}, naming the file and line`, () => {
      const r = lint(fixture(name, rel, line));
      assert.equal(r.ok, false, r.out);
      assert.ok(r.out.includes(phrase), r.out);
    });
  }

  for (const [label, name, rel, line] of [
    ['git -C <repo>', 'sh-git-c', 'scripts/st.sh', 'git -C "$REPO" status --porcelain'],
    ['git named inside a quoted message', 'sh-git-msg', 'scripts/msg.sh', 'echo "BLOCKED: run git status in the worktree" >&2'],
    ['a spawnSync with cwd', 'ts-spawn-cwd', 'mcp/trajectory-server/src/run.ts', "const r = spawnSync('x', [], { cwd: root });"],
    ['the self-location form', 'sh-self', 'scripts/self.sh', 'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"'],
  ]) {
    test(`passes ${label}`, () => {
      const r = lint(fixture(name, rel, line));
      assert.ok(r.ok, r.out);
    });
  }

  test('passes a hit matched by an allowlist entry', () => {
    const root = fixture('sh-allowed', 'scripts/walk.sh', 'DIR="${1:-$PWD}"');
    writeFileSync(join(root, 'allow.tsv'), 'scripts/walk.sh\tDIR="${1:-$PWD}"\tfallback\tonly a manual run with no argument\n');
    const r = lint(root);
    assert.ok(r.ok, r.out);
  });

  test('fails on a stale allowlist entry, naming it', () => {
    const root = fixture('stale', 'scripts/clean.sh', 'echo ok');
    writeFileSync(join(root, 'allow.tsv'), 'scripts/clean.sh\tDIR="${1:-$PWD}"\tfallback\tremoved long ago\n');
    const r = lint(root);
    assert.equal(r.ok, false, r.out);
    assert.ok(r.out.includes('stale entry'), r.out);
  });

  test('fails on an entry with no reason or an unknown category', () => {
    const root = fixture('no-reason', 'scripts/walk.sh', 'DIR="${1:-$PWD}"');
    writeFileSync(join(root, 'allow.tsv'), 'scripts/walk.sh\tDIR="${1:-$PWD}"\tfallback\n');
    assert.equal(lint(root).ok, false, 'an entry with no reason fails');
    writeFileSync(join(root, 'allow.tsv'), 'scripts/walk.sh\tDIR="${1:-$PWD}"\twhatever\tsome reason\n');
    const r = lint(root);
    assert.equal(r.ok, false, r.out);
    assert.ok(r.out.includes("has category 'whatever'"), r.out);
  });

  test('passes on a copy of the plugin and fails on an injected hook cwd read', () => {
    const m = join(tmp, 'mirror');
    for (const rel of ['scripts', 'skills', 'mcp/trajectory-server/src', 'tests/lib']) {
      cpSync(join(ROOT, rel), join(m, rel), { recursive: true });
    }
    let r = lint(m, ALLOWLIST);
    assert.ok(r.ok, r.out);

    const hooks = join(m, 'scripts/hooks');
    const injected = join(hooks, 'swe-boundary.sh');
    writeFileSync(injected, 'case "$PWD" in */.claude/worktrees/*) WT="${PWD%%/.claude/worktrees/*}" ;; esac\n');
    r = lint(m, ALLOWLIST);
    assert.equal(r.ok, false, 'an injected $PWD read fails');
    assert.ok(r.out.includes('swe-boundary.sh'), r.out);
    rmSync(injected);

    appendFileSync(join(hooks, 'containment-guard.sh'), 'ROOT=$(jq -r .cwd <<<"$INPUT")\n');
    r = lint(m, ALLOWLIST);
    assert.equal(r.ok, false, 'the payload .cwd as a root fails');
    assert.ok(r.out.includes('containment-guard.sh'), r.out);
  });
});
