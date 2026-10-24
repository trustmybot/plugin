// README drift, dead references and the any-term search fallback on the world
// model (GH 1680), end to end through scan_run and the world_model_* handlers
// against git fixture repos.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pinScanEnv, tempDB } from './helpers.js';
import { GraphHolder, WorldModelGraph } from '../graph.js';
import { scanTools } from '../tools/scan.js';
import { trustOf, worldModelTools } from '../tools/world_model.js';
import { deadRefs, readmeDrift, readRepoHistory } from '../readme-drift.js';
import { toFtsOrQuery, toFtsQuery } from '../fts-query.js';
const scanPin = pinScanEnv();
after(() => scanPin.restore());
function git(root, ...args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}
function write(root, rel, body) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
}
function commit(root, message) {
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', message);
    return git(root, 'rev-parse', 'HEAD');
}
// app/: docs/README.md committed, then two commits under docs/; the root
// README, committed last, names a deleted script, an existing file, a ${VAR}
// template and `swe.md`, whose old/ copy was deleted while agents/ keeps one.
function fixture() {
    const ws = mkdtempSync(join(tmpdir(), 'wm-drift-'));
    const root = join(ws, 'app');
    mkdirSync(root, { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 't@t.io');
    git(root, 'config', 'user.name', 't');
    write(root, 'scripts/gone.sh', 'echo gone\n');
    write(root, 'scripts/keep.sh', 'echo keep\n');
    write(root, 'src/main.ts', 'export const main = 1;\n');
    write(root, 'docs/README.md', '# docs\n\nInvoice rendering guide; see `docs/a.md`.\n');
    write(root, 'docs/a.md', 'a\n');
    write(root, 'old/swe.md', 'old\n');
    write(root, 'agents/swe.md', 'swe\n');
    const docsReadmeSha = commit(root, 'docs readme');
    git(root, 'rm', '-q', 'scripts/gone.sh', 'old/swe.md');
    commit(root, 'drop gone.sh and old/swe.md');
    write(root, 'docs/b.md', 'b\n');
    commit(root, 'docs b');
    write(root, 'docs/a.md', 'a2\n');
    commit(root, 'docs a again');
    write(root, 'README.md', '# app\n\nRun `scripts/gone.sh` first, then `src/main.ts`. Output lands in `${VAR}/x`. Persona: `swe.md`.\n');
    const rootReadmeSha = commit(root, 'root readme');
    return { ws, root, docsReadmeSha, rootReadmeSha };
}
async function scan(db, holder, ws) {
    const r = (await scanTools(db, holder, ':memory:').handlers['scan_run']({ agent: 'bro', session_dir: ws }));
    assert.ok(!r.isError, r.content[0].text);
}
function parse(r) {
    return JSON.parse(r.content[0].text);
}
function rawDir(db, path) {
    return {
        ...db.get('SELECT summary_source, summary_sha, commits_behind, dead_refs FROM wm_directories WHERE repo = ? AND path = ?', ['app', path]),
    };
}
describe('scan_run writes README drift onto wm_directories (GH 1680)', () => {
    const f = fixture();
    const db = tempDB();
    const graph = new WorldModelGraph(db);
    const holder = GraphHolder.fixed(graph);
    after(() => {
        db.close();
        rmSync(f.ws, { recursive: true, force: true });
    });
    it('summary_sha is the README commit and commits_behind counts later commits under the dir', async () => {
        await scan(db, holder, f.ws);
        assert.deepEqual(rawDir(db, 'docs'), {
            summary_source: 'readme',
            summary_sha: f.docsReadmeSha,
            commits_behind: 2,
            dead_refs: '[]',
        });
    });
    it('dead_refs holds exactly the deleted path the README names, not a bare name still tracked elsewhere', () => {
        assert.deepEqual(rawDir(db, ''), {
            summary_source: 'readme',
            summary_sha: f.rootReadmeSha,
            commits_behind: 0,
            dead_refs: '["scripts/gone.sh"]',
        });
    });
    it('structural directories keep all three columns NULL', () => {
        assert.deepEqual(rawDir(db, 'src'), {
            summary_source: 'structural',
            summary_sha: null,
            commits_behind: null,
            dead_refs: null,
        });
    });
    it('world_model_get carries trust, summary_sha, commits_behind and dead_refs on every directory row', async () => {
        const tools = worldModelTools(db, holder);
        const out = parse(await tools.handlers['world_model_get']({ agent: 'bro', repo: 'app' }));
        assert.equal(out.root.trust, 'dead_refs(1)');
        assert.deepEqual(out.root.dead_refs, ['scripts/gone.sh']);
        assert.equal(out.root.summary_sha, f.rootReadmeSha);
        const byPath = new Map(out.root.children.map((c) => [c.path, c]));
        const docs = byPath.get('docs');
        assert.equal(docs.trust, 'drifting(2)');
        assert.equal(docs.commits_behind, 2);
        assert.deepEqual(docs.dead_refs, []);
        const src = byPath.get('src');
        for (const key of ['trust', 'summary_sha', 'commits_behind', 'dead_refs']) {
            assert.ok(key in src, `structural node carries ${key}`);
            assert.equal(src[key], null);
        }
    });
    it('world_model_search returns drift keys and match: all_terms when every term matches', async () => {
        const tools = worldModelTools(db, holder);
        const out = parse(await tools.handlers['world_model_search']({ agent: 'bro', query: 'invoice rendering', mode: 'keyword', repo: 'app' }));
        assert.equal(out.match, 'all_terms');
        const docs = out.results.find((r) => r.kind === 'dir' && r.path === 'docs');
        assert.ok(docs, JSON.stringify(out.results));
        assert.equal(docs.trust, 'drifting(2)');
        assert.equal(docs.summary_sha, f.docsReadmeSha);
        assert.equal(docs.commits_behind, 2);
        assert.deepEqual(docs.dead_refs, []);
    });
    it('a full-sentence query whose all-terms form matches nothing falls back to any term', async () => {
        const query = 'where does the invoice rendering code for refunds live';
        assert.equal(graph.keywordSearchDirectories('app', query, 5).match, 'any_term');
        const tools = worldModelTools(db, holder);
        const out = parse(await tools.handlers['world_model_search']({ agent: 'bro', query, mode: 'keyword', repo: 'app' }));
        assert.equal(out.match, 'any_term');
        assert.ok(out.results.length >= 1, 'the sentence query finds at least one hit');
        assert.ok(out.results.some((r) => r.kind === 'dir' && r.path === 'docs'), JSON.stringify(out.results));
    });
});
describe('README drift helpers (GH 1680)', () => {
    it('a non-git root yields no history, so drift stays NULL', () => {
        const dir = mkdtempSync(join(tmpdir(), 'wm-drift-nogit-'));
        try {
            assert.equal(readRepoHistory(dir, new Set()), null);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('an untracked README yields no drift', () => {
        const f = fixture();
        try {
            write(f.root, 'notes/README.md', '# notes\n');
            const history = readRepoHistory(f.root, new Set(['notes']));
            assert.equal(readmeDrift(history, 'notes', 'README.md', '# notes\n'), null);
        }
        finally {
            rmSync(f.ws, { recursive: true, force: true });
        }
    });
    function history(root, deleted, trackedDirs, trackedBasenames = []) {
        const deletedByBasename = new Map();
        for (const p of deleted)
            deletedByBasename.set(p.slice(p.lastIndexOf('/') + 1), [p]);
        return {
            root,
            deleted: new Set(deleted),
            deletedByBasename,
            trackedBasenames: new Set(trackedBasenames),
            trackedDirs: new Set(trackedDirs),
        };
    }
    it('flags a missing markdown link without a deletion, skips .., dist/, * and untracked first segments', () => {
        const root = mkdtempSync(join(tmpdir(), 'wm-drift-refs-'));
        try {
            write(root, 'docs/here.md', 'x\n');
            const readme = [
                '<untrusted-content source="readme">',
                '[here](here.md) [gone](./missing.md) [site](https://example.com/x.md) [top](#usage)',
                '[up](../other.md) `dist/index.js` `src/*.ts` `vendor/old.sh` `src/old.ts:12`',
                '</untrusted-content>',
            ].join('\n');
            const h = history(root, ['vendor/old.sh', 'src/old.ts', 'dist/index.js'], ['docs', 'src']);
            assert.deepEqual(deadRefs(readme, 'docs', h), ['docs/missing.md', 'src/old.ts']);
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('a bare backtick name is dead only when git deleted a file with that basename', () => {
        const root = mkdtempSync(join(tmpdir(), 'wm-drift-base-'));
        try {
            const h = history(root, ['tools/old-run.mjs'], []);
            assert.deepEqual(deadRefs('Use `old-run.mjs`, not `process.env`.', '', h), ['tools/old-run.mjs']);
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('a bare backtick name is not dead while a file with that basename is tracked today', () => {
        const root = mkdtempSync(join(tmpdir(), 'wm-drift-live-'));
        try {
            const h = history(root, ['.claude/agents/swe.md', 'rows/01/run.sh'], [], ['swe.md', 'run.sh']);
            assert.deepEqual(deadRefs('See `swe.md` and `run.sh`.', 'tests', h), []);
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('a ref with a slash is not dead when only its basename was deleted elsewhere', () => {
        const root = mkdtempSync(join(tmpdir(), 'wm-drift-slash-'));
        try {
            const h = history(root, ['old/tool.sh'], ['scripts']);
            assert.deepEqual(deadRefs('Run `scripts/tool.sh`.', '', h), []);
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('trust joins drifting and dead_refs, reads current when clean, null when unknown', () => {
        assert.equal(trustOf({ commits_behind: 0, dead_refs: [] }), 'current');
        assert.equal(trustOf({ commits_behind: 3, dead_refs: [] }), 'drifting(3)');
        assert.equal(trustOf({ commits_behind: 3, dead_refs: ['a', 'b'] }), 'drifting(3), dead_refs(2)');
        assert.equal(trustOf({ commits_behind: 0, dead_refs: ['a'] }), 'dead_refs(1)');
        assert.equal(trustOf({ commits_behind: null, dead_refs: null }), null);
    });
});
describe('toFtsOrQuery (GH 1680)', () => {
    it('ORs the non-stopword tokens and leaves toFtsQuery unchanged', () => {
        assert.equal(toFtsOrQuery('Where does the invoice code live?'), '"invoice" OR "code" OR "live?"');
        assert.equal(toFtsQuery('Where does the invoice code live?'), '"Where" "does" "the" "invoice" "code" "live?"');
    });
    it('returns null when only stopwords or punctuation remain', () => {
        assert.equal(toFtsOrQuery('what is the ?'), null);
        assert.equal(toFtsOrQuery(''), null);
    });
});
//# sourceMappingURL=world-model-drift.test.js.map