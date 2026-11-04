/**
 * Self-tests for four tests/l1-lint scripts (GH 1692), each run as
 * `bash tests/l1-lint/<script>.sh` on the plugin and on planted fixture trees:
 *   1. no-cwd-reads.sh fails on process.cwd(), $PWD, a bare git, a spawnSync
 *      with no cwd, a stale allowlist entry and a malformed one, and passes the
 *      self-location form, git -C, a spawn with cwd and an allowlisted line (GH 1553);
 *   2. legacy-reviewer-name.sh passes on the real allowlist and fails on a new
 *      tracked file using the old name (GH 2134);
 *   3. no-directories-table-refs.sh fails on new directories-table DML and
 *      exempts only its exact bundle paths (GH 2134);
 *   4. prompt-explicit-paths.sh fails on a relative .claude/ path or a git
 *      push/switch/checkout/pull without -C in a prompt.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makeSandbox, PLUGIN_ROOT } from './hook-sandbox.js';
const L1 = join(PLUGIN_ROOT, 'tests/l1-lint');
let sb;
before(() => {
    sb = makeSandbox('l1-lint-scripts');
});
after(() => sb.remove());
function bash(script, args = [], env = {}) {
    const r = spawnSync('bash', [script, ...args], { cwd: sb.dir, env: { ...sb.env, ...env }, encoding: 'utf8', timeout: 120_000 });
    if (r.error)
        throw r.error;
    return { rc: r.status, out: r.stdout + r.stderr };
}
function put(path, body) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
}
function git(cwd, ...args) {
    const r = spawnSync('git', ['-C', cwd, ...args], { cwd, env: sb.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
}
describe('no-cwd-reads.sh', () => {
    const LINT = join(L1, 'no-cwd-reads.sh');
    const ALLOW = join(L1, 'cwd-allowlist.tsv');
    const lint = (root, allow = join(root, 'allow.tsv')) => bash(LINT, [root, allow], { TRAJECTORY_DB_PATH: join(sb.dir, 'no-such.db') });
    function fixture(name, rel, line) {
        const root = join(sb.dir, 'cwd', name);
        put(join(root, rel), `${line}\n`);
        writeFileSync(join(root, 'allow.tsv'), '');
        return root;
    }
    it('passes on the plugin with cwd-allowlist.tsv', () => {
        const r = lint(PLUGIN_ROOT, ALLOW);
        assert.equal(r.rc, 0, r.out);
    });
    for (const [label, name, rel, line, phrase] of [
        ['a planted process.cwd()', 'ts-cwd', 'mcp/trajectory-server/src/root.ts', 'const root = process.cwd();', 'mcp/trajectory-server/src/root.ts:1 reads process.cwd()'],
        ['a planted $PWD', 'sh-pwd', 'scripts/root.sh', 'ROOT="$PWD"', 'scripts/root.sh:1 reads the cwd'],
        ['a bare git status', 'sh-git', 'scripts/st.sh', 'git status --porcelain', 'scripts/st.sh:1 runs git with no -C'],
        ['a spawnSync with no cwd', 'ts-spawn', 'mcp/trajectory-server/src/run.ts', "const r = spawnSync('x', []);", 'mcp/trajectory-server/src/run.ts:1 spawns with no cwd'],
    ]) {
        it(`fails on ${label}, naming the file and line`, () => {
            const r = lint(fixture(name, rel, line));
            assert.equal(r.rc, 1, r.out);
            assert.ok(r.out.includes(phrase), r.out);
        });
    }
    for (const [label, name, rel, line] of [
        ['git -C <repo>', 'sh-git-c', 'scripts/st.sh', 'git -C "$REPO" status --porcelain'],
        ['git named inside a quoted message', 'sh-git-msg', 'scripts/msg.sh', 'echo "BLOCKED: run git status in the worktree" >&2'],
        ['a spawnSync with cwd', 'ts-spawn-cwd', 'mcp/trajectory-server/src/run.ts', "const r = spawnSync('x', [], { cwd: root });"],
        ['the self-location form', 'sh-self', 'scripts/self.sh', 'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"'],
    ]) {
        it(`passes ${label}`, () => {
            const r = lint(fixture(name, rel, line));
            assert.equal(r.rc, 0, r.out);
        });
    }
    it('passes a hit matched by an allowlist entry', () => {
        const root = fixture('sh-allowed', 'scripts/walk.sh', 'DIR="${1:-$PWD}"');
        writeFileSync(join(root, 'allow.tsv'), 'scripts/walk.sh\tDIR="${1:-$PWD}"\tfallback\tonly a manual run with no argument\n');
        const r = lint(root);
        assert.equal(r.rc, 0, r.out);
    });
    it('fails on a stale allowlist entry, naming it', () => {
        const root = fixture('stale', 'scripts/clean.sh', 'echo ok');
        writeFileSync(join(root, 'allow.tsv'), 'scripts/clean.sh\tDIR="${1:-$PWD}"\tfallback\tremoved long ago\n');
        const r = lint(root);
        assert.equal(r.rc, 1, r.out);
        assert.ok(r.out.includes('stale entry'), r.out);
    });
    it('fails on an entry with no reason or an unknown category', () => {
        const root = fixture('no-reason', 'scripts/walk.sh', 'DIR="${1:-$PWD}"');
        writeFileSync(join(root, 'allow.tsv'), 'scripts/walk.sh\tDIR="${1:-$PWD}"\tfallback\n');
        assert.equal(lint(root).rc, 1, 'an entry with no reason fails');
        writeFileSync(join(root, 'allow.tsv'), 'scripts/walk.sh\tDIR="${1:-$PWD}"\twhatever\tsome reason\n');
        const r = lint(root);
        assert.equal(r.rc, 1, r.out);
        assert.ok(r.out.includes("has category 'whatever'"), r.out);
    });
    it('passes on a copy of the plugin and fails on an injected hook cwd read', () => {
        const m = join(sb.dir, 'cwd', 'mirror');
        for (const rel of ['scripts', 'skills', 'mcp/trajectory-server/src', 'tests/lib']) {
            cpSync(join(PLUGIN_ROOT, rel), join(m, rel), { recursive: true });
        }
        let r = lint(m, ALLOW);
        assert.equal(r.rc, 0, r.out);
        const hooks = join(m, 'scripts/hooks');
        const injected = join(hooks, 'swe-boundary.sh');
        writeFileSync(injected, 'case "$PWD" in */.claude/worktrees/*) WT="${PWD%%/.claude/worktrees/*}" ;; esac\n');
        r = lint(m, ALLOW);
        assert.equal(r.rc, 1, 'an injected $PWD read fails');
        assert.ok(r.out.includes('swe-boundary.sh'), r.out);
        rmSync(injected);
        appendFileSync(join(hooks, 'containment-guard.sh'), 'ROOT=$(jq -r .cwd <<<"$INPUT")\n');
        r = lint(m, ALLOW);
        assert.equal(r.rc, 1, 'the payload .cwd as a root fails');
        assert.ok(r.out.includes('containment-guard.sh'), r.out);
    });
});
describe('legacy-reviewer-name.sh', () => {
    const OLD_NAME = 'pr-' + 'reviewer';
    let repo;
    const lint = () => bash(join(repo, 'tests/l1-lint/legacy-reviewer-name.sh'));
    function copyTracked(rel) {
        mkdirSync(dirname(join(repo, rel)), { recursive: true });
        copyFileSync(join(PLUGIN_ROOT, rel), join(repo, rel));
    }
    function plant(rel) {
        put(join(repo, rel), `agent = "${OLD_NAME}"\n`);
        git(repo, 'add', '--', rel);
    }
    before(() => {
        repo = join(sb.dir, 'legacy-repo');
        mkdirSync(repo);
        git(repo, 'init', '-q');
        const hits = git(PLUGIN_ROOT, 'grep', '-il', 'pr[-_]reviewer').split('\n').filter((l) => l !== '');
        for (const rel of [...hits, 'tests/l1-lint/legacy-reviewer-name.sh', 'tests/l1-lint/legacy-reviewer-name.allowlist', 'docs/reference/UPGRADE.md']) {
            copyTracked(rel);
        }
        git(repo, 'add', '-A');
    });
    it('passes when every current hit is allowlisted', () => {
        const r = lint();
        assert.equal(r.rc, 0, r.out);
    });
    for (const [label, rel] of [
        ['a new tracked file using the old name', 'scripts/new-agent.sh'],
        ['a file beside the exactly allowlisted research question', 'research/gh1346-ab/m3/other-questions.ts'],
    ]) {
        it(`fails on ${label}, naming it`, () => {
            plant(rel);
            try {
                const r = lint();
                assert.equal(r.rc, 1, r.out);
                assert.ok(r.out.includes(`legacy reviewer name in ${rel}`), r.out);
            }
            finally {
                git(repo, 'rm', '-qf', '--', rel);
            }
        });
    }
});
describe('no-directories-table-refs.sh', () => {
    const LINT = join(L1, 'no-directories-table-refs.sh');
    const DML = 'INSERT INTO ' + "directories (path) VALUES ('x');";
    function fixture(name, ...rels) {
        const root = join(sb.dir, 'dirs', name);
        const lint = join(root, 'tests/l1-lint/no-directories-table-refs.sh');
        mkdirSync(dirname(lint), { recursive: true });
        copyFileSync(LINT, lint);
        for (const rel of rels)
            put(join(root, rel), `${DML}\n`);
        return lint;
    }
    it('passes on the plugin tree', () => {
        const r = bash(LINT);
        assert.equal(r.rc, 0, r.out);
    });
    it('passes on a tree with no DML', () => {
        const r = bash(fixture('clean'));
        assert.equal(r.rc, 0, r.out);
    });
    it('passes on the two exactly listed bundles', () => {
        const r = bash(fixture('listed', 'dashboard/dist/server.mjs', 'mcp/trajectory-server/dist/run-scan.js'));
        assert.equal(r.rc, 0, r.out);
    });
    for (const [label, name, rel, phrase] of [
        ['a new source file holding the DML', 'new-file', 'scripts/new-migration.sh', 'scripts/new-migration.sh contains SQLite directories-table DML/DDL'],
        ['an unlisted bundle in the trajectory-server dist', 'unlisted-server', 'mcp/trajectory-server/dist/new-bundle.js', 'mcp/trajectory-server/dist/new-bundle.js contains'],
        ['an unlisted bundle in the dashboard dist', 'unlisted-dashboard', 'dashboard/dist/client.mjs', 'dashboard/dist/client.mjs contains'],
        ['a listed basename under another directory', 'wrong-dir', 'dashboard/dist/run-scan.js', 'dashboard/dist/run-scan.js contains'],
    ]) {
        it(`fails on ${label}, naming it`, () => {
            const r = bash(fixture(name, rel));
            assert.equal(r.rc, 1, r.out);
            assert.ok(r.out.includes(phrase), r.out);
        });
    }
});
describe('prompt-explicit-paths.sh', () => {
    const LINT = join(L1, 'prompt-explicit-paths.sh');
    function plant(name, rel, line) {
        const root = join(sb.dir, 'prompts', name);
        put(join(root, rel), `---\nname: x\n---\n\n${line}\n`);
        return root;
    }
    for (const [label, name, rel, line, phrase] of [
        ['a relative .claude/ path in a command', 'rel-claude', 'commands/x.md', 'Write the file to `.claude/x`.', 'commands/x.md:5: relative .claude/ path'],
        ['a bare git push in a skill', 'bare-push', 'skills/tmb_x/SKILL.md', 'Then `git push origin <feature>`.', 'skills/tmb_x/SKILL.md:5: git command without -C'],
        ['bare git switch, checkout and pull in an agent', 'bare-verbs', 'agents/a.md', 'Run `git switch dev`, `git checkout -b x` and `git pull --ff-only`.', 'agents/a.md:5: git command without -C'],
    ]) {
        it(`fails on ${label}, naming the file and line`, () => {
            const r = bash(LINT, [plant(name, rel, line)]);
            assert.equal(r.rc, 1, r.out);
            assert.ok(r.out.includes(phrase), r.out);
        });
    }
    for (const [label, name, rel, line] of [
        ['<project>/.claude/x, ~/.claude/y and $HOME/.claude/z', 'anchored-claude', 'commands/x.md', 'Write the file to `<project>/.claude/x`, `~/.claude/y` or `$HOME/.claude/z`.'],
        ['git -C <repo path> push and pull', 'anchored-push', 'skills/tmb_x/SKILL.md', 'Then `git -C <repo path> push origin <feature>` and `git -C <repo path> pull --ff-only`.'],
    ]) {
        it(`passes ${label}`, () => {
            const r = bash(LINT, [plant(name, rel, line)]);
            assert.equal(r.rc, 0, r.out);
        });
    }
    it('passes on the shipped prompts', () => {
        const r = bash(LINT, [PLUGIN_ROOT]);
        assert.equal(r.rc, 0, r.out);
    });
});
//# sourceMappingURL=l1-lint-scripts.test.js.map