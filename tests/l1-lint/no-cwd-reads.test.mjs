// L1 lint: nothing finds the project, a repo or an agent from the working directory (GH 1550, GH 1553). Claude Code gives bro and every subagent one working directory, and the MCP server inherits whatever directory it was started in, so the cwd says nothing about which project, repo or worktree a call is for. The project comes from the trajectory DB (tmb_project_root, the server's DB path), a repo from its repos row, an agent from its spawn transcript and the DB. Scope: scripts/ (scripts/hooks/ included), skills/*/scripts/, mcp/trajectory-server/src/ (src/test/ excluded) and tests/lib/; *.sh are read as shell, *.ts / *.mjs / *.js as TypeScript. Comment lines are skipped. Shell hits: $PWD, ${PWD…}, a bare `pwd`, the payload `.cwd`, tmb_payload_cwd, tmb_cmd_cwd; a `git` command with no `-C` on its line (git named inside quoted text, such as a deny message, is not a command). TypeScript hits: process.cwd(); a spawn( / spawnSync( / execFile( / execFileSync( call whose line and next 3 lines carry no `cwd`, projectSpawnOptions( or git's `'-C',`. Exempt without an entry: canonicalizing a named dir (`(cd <dir> … && pwd)`, `&& pwd -P)`, `&& pwd -P || <fallback>)`, which covers the self-location `cd "$(dirname …)" && pwd`), and the payload cwd as the join base of a command's relative paths (the <cwd> argument of tmb_cmd_statements / tmb_cmd_write_paths / tmb_stmt_repo_root, or `"$(tmb_payload_cwd "$IN")/<relative>"`). Any other hit needs a cwd-allowlist.tsv entry `<path from the root>\t<substring of the line>\t<category>\t<reason>`, category one of self-location, canonicalize, join-base, anchored-cd, fallback, test-harness, not-location (a command that reads no location, such as `gh auth status`, or the cwd recorded as data). An entry with an unknown category, no reason, or one no hit matches any more fails too. The rules live in lib/no-cwd-reads.mjs: scan(root, allowlist) takes the tree and allowlist to check, scanFile(root, rel, allowlist) checks one file without the stale-entry check; the cases below plant trees through both.
import { strict as assert } from 'node:assert';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { ALLOWLIST, ROOT, scan, scanFile } from './lib/no-cwd-reads.mjs';

const FAIL_HINT =
  "no-cwd-reads: FAIL — find the project from the trajectory DB (tmb_project_root), a repo from its repos row (git -C <path>, spawn with cwd), an agent from its spawn transcript (src/hooks/lib/agent-context.ts); the cwd only joins a command's relative paths (GH 1553). A legitimate read takes a cwd-allowlist.tsv entry with its category and reason.";

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

describe('one file (scanFile)', () => {
  let tmp;
  before(() => {
    tmp = mkdtempSync(join((process.env.TMPDIR || tmpdir()).replace(/\/+$/, ''), 'tmb-no-cwd-reads-file.'));
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  function tree(name, files, allow = '') {
    const root = join(tmp, name);
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), `${text}\n`);
    }
    mkdirSync(join(root, 'tests/l1-lint'), { recursive: true });
    writeFileSync(join(root, 'tests/l1-lint/cwd-allowlist.tsv'), allow);
    return root;
  }

  test('flags a cwd read in the one file, naming its line', () => {
    const root = tree('flag', { 'scripts/root.sh': 'echo hi\nROOT="$PWD"', 'scripts/other.sh': 'ROOT="$PWD"' });
    assert.deepEqual(scanFile(root, 'scripts/root.sh'), ['scripts/root.sh:2: reads the cwd: ROOT="$PWD"']);
  });

  test('honors a cwd-allowlist.tsv entry for that file', () => {
    const root = tree('allowed', { 'scripts/walk.sh': 'DIR="${1:-$PWD}"' }, 'scripts/walk.sh\tDIR="${1:-$PWD}"\tfallback\tonly a manual run with no argument\n');
    assert.deepEqual(scanFile(root, 'scripts/walk.sh'), []);
  });

  test('an entry for the same line in another file does not exempt it', () => {
    const root = tree('other-entry', { 'scripts/walk.sh': 'DIR="${1:-$PWD}"' }, 'scripts/run.sh\tDIR="${1:-$PWD}"\tfallback\tanother file\n');
    assert.equal(scanFile(root, 'scripts/walk.sh').length, 1);
  });

  test('a stale entry for another file does not fail the one-file check', () => {
    const root = tree('stale', { 'scripts/clean.sh': 'echo ok' }, 'scripts/gone.sh\tDIR="${1:-$PWD}"\tfallback\tremoved long ago\n');
    assert.deepEqual(scanFile(root, 'scripts/clean.sh'), []);
  });

  test('every file the real allowlist names passes alone against it', () => {
    const named = new Set(
      readFileSync(ALLOWLIST, 'utf8')
        .split('\n')
        .filter((l) => l !== '' && !l.startsWith('#'))
        .map((l) => l.split('\t')[0]),
    );
    assert.ok(named.size > 0);
    for (const rel of named) assert.deepEqual(scanFile(ROOT, rel), [], rel);
  });
});
