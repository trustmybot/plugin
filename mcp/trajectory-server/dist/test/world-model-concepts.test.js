import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorldModelGraph, GraphHolder } from '../graph.js';
import { scanTools } from '../tools/scan.js';
import { worldModelTools } from '../tools/world_model.js';
import { insertAudit } from '../tools/audit.js';
import { applyConceptProposals } from '../world-model/concepts.js';
import { pinScanEnv, tempDB } from './helpers.js';
const scanPin = pinScanEnv();
after(() => scanPin.restore());
const WORKTREE = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const LANE = /(^|\/)(tests?|__tests__|(__)?fixtures(__)?)\/|\.test\.[a-z]+$/;
function text(r) {
    return r.content[0].text;
}
function parse(r) {
    assert.ok(!r.isError, text(r));
    return JSON.parse(text(r));
}
async function scan(db, holder, sessionDir) {
    return parse((await scanTools(db, holder, ':memory:').handlers['scan_run']({ agent: 'bro', session_dir: sessionDir })));
}
const SCAN_FLOW = (repo) => ({
    agent: 'bro',
    repo,
    name: 'scan to index',
    kind: 'flow',
    body: 'How a scan run reaches the parser.',
    steps: [
        { path: 'mcp/trajectory-server/src/tools/scan.ts', kind: 'function', qualified_name: 'persistScan', description: 'Writes the walked tree to the DB.', handoff: 'calls' },
        { path: 'mcp/trajectory-server/src/symbol-index.ts', kind: 'function', qualified_name: 'indexRepoSymbols', description: 'Reparses stale files, a lighthouse for drift.', handoff: 'calls' },
        { path: 'mcp/trajectory-server/src/symbol-index.ts', kind: 'function', qualified_name: 'isTestPath', description: 'Keeps tests out of the lane.', handoff: 'calls' },
    ],
    claims: [
        {
            claim: 'calls',
            args: {
                from: { path: 'mcp/trajectory-server/src/tools/scan.ts', qualified_name: 'persistScan' },
                to: { path: 'mcp/trajectory-server/src/symbol-index.ts', qualified_name: 'indexRepoSymbols' },
            },
        },
    ],
});
describe('L2 concepts over this worktree (GH 1680)', () => {
    const db = tempDB();
    const holder = GraphHolder.fixed(new WorldModelGraph(db));
    let repo = '';
    let conceptId = 0;
    const wm = () => worldModelTools(db, holder).handlers;
    before(async () => {
        repo = (await scan(db, holder, WORKTREE)).repos[0].name;
    });
    after(() => db.close());
    it('upserts a verified 3-step concept with a passing calls claim, searchable by a step-only word', async () => {
        const out = parse((await wm()['world_model_concept_upsert'](SCAN_FLOW(repo))));
        conceptId = out.id;
        assert.equal(out.status, 'verified');
        const concepts = db.all(`SELECT status, verified_sha, verified_by FROM wm_concepts`);
        assert.equal(concepts.length, 1);
        assert.equal(concepts[0].status, 'verified');
        assert.equal(concepts[0].verified_by, 'bro');
        assert.equal(concepts[0].verified_sha, execFileSync('git', ['-C', WORKTREE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
        const steps = db.all(`SELECT ordinal, handoff, trust FROM wm_concept_steps WHERE concept_id = ? ORDER BY ordinal`, [conceptId]);
        assert.deepEqual(steps.map((s) => Number(s.ordinal)), [1, 2, 3]);
        assert.equal(steps[2].handoff, null, 'the last step hands off to nothing');
        assert.ok(steps.every((s) => s.trust === 'verified'));
        const claim = db.get(`SELECT claim, last_result FROM wm_concept_claims WHERE concept_id = ?`, [conceptId]);
        assert.deepEqual({ ...claim }, { claim: 'calls', last_result: 'pass' });
        const found = parse((await wm()['world_model_concepts']({ agent: 'bro', repo, query: 'lighthouse' })));
        assert.equal(found.available, true);
        assert.equal(found.derived, null);
        assert.equal(found.concepts.length, 1);
        assert.deepEqual(found.concepts[0], {
            id: conceptId,
            name: 'scan to index',
            body: 'How a scan run reaches the parser.',
            step_count: 3,
            trust: { verified: 3, suspect: 0, broken: 0 },
            rank: 1,
        });
    });
    it('concept_get returns steps in ordinal order with their symbols resolved now', async () => {
        const got = parse((await wm()['world_model_concept_get']({ agent: 'bro', id: conceptId })));
        assert.equal(got.status, 'verified');
        assert.deepEqual(got.steps.map((s) => s.ordinal), [1, 2, 3]);
        assert.deepEqual(got.steps.map((s) => s.symbol?.qualified_name), ['persistScan', 'indexRepoSymbols', 'isTestPath']);
        assert.deepEqual(got.steps.map((s) => s.handoff), ['calls', 'calls', null]);
    });
    it('only bro and consultants write concepts', async () => {
        const r = (await wm()['world_model_concept_upsert']({ ...SCAN_FLOW(repo), agent: 'swe' }));
        assert.ok(r.isError, text(r));
    });
    it('SessionStart hooks carry strictly increasing run_order in file order and an exact runs edge each', () => {
        const hooks = db.all(`SELECT id, qualified_name, run_order FROM wm_symbols
        WHERE repo = ? AND kind = 'hook' AND qualified_name LIKE 'SessionStart#%' ORDER BY start_line`, [repo]);
        const declared = JSON.parse(readFileSync(join(WORKTREE, 'hooks/hooks.json'), 'utf8')).hooks.SessionStart.flatMap((g) => g.hooks);
        assert.equal(hooks.length, declared.length);
        for (const [i, h] of hooks.entries()) {
            assert.notEqual(h.run_order, null, h.qualified_name);
            if (i > 0)
                assert.ok(Number(h.run_order) > Number(hooks[i - 1].run_order), `${h.qualified_name} after ${hooks[i - 1].qualified_name}`);
            const runs = db.all(`SELECT resolution, dst_name FROM wm_edges WHERE src_id = ? AND kind = 'runs'`, [h.id]);
            assert.ok(runs.length > 0, `${h.qualified_name} has a runs edge`);
            for (const r of runs)
                assert.equal(r.resolution, 'exact', `${h.qualified_name} -> ${r.dst_name}`);
        }
        const stray = db.get(`SELECT COUNT(*) AS n FROM wm_symbols WHERE kind <> 'hook' AND run_order IS NOT NULL`).n;
        assert.equal(stray, 0, 'run_order is null for every non-hook symbol');
    });
    it('doc keeps the full leading comment block and a symbol\'s description strings, capped at 1000 characters', () => {
        const doc = (path, name) => db.get(`SELECT doc FROM wm_symbols WHERE repo = ? AND path = ? AND qualified_name = ?`, [repo, path, name]).doc;
        assert.match(doc('mcp/trajectory-server/src/tools/world_model.ts', 'tipIntegratedInto'), /Twin of clean-merged-branch.*PR closed unmerged looks the same/s);
        assert.match(doc('mcp/trajectory-server/src/tools/world_model.ts', 'worldModelTools'), /Primary navigation surface/);
        const longest = db.get(`SELECT MAX(LENGTH(doc)) AS n FROM wm_symbols WHERE repo = ? AND kind <> 'module'`, [repo]).n;
        assert.ok(longest <= 1000, String(longest));
    });
    it('a query no concept matches returns a derived, unverified chain off the index with no test paths', async () => {
        const out = parse((await wm()['world_model_concepts']({ agent: 'bro', repo, query: 'migrateV43toV44' })));
        assert.deepEqual(out.concepts, []);
        assert.ok(out.derived, 'derived chain present');
        assert.equal(out.derived.label, 'derived, unverified');
        assert.ok(out.derived.steps.length >= 2, JSON.stringify(out.derived.steps));
        assert.ok(out.derived.steps.length <= 8);
        assert.deepEqual(out.derived.steps.map((s) => s.ordinal), out.derived.steps.map((_, i) => i + 1));
        for (const s of out.derived.steps) {
            assert.ok(s.symbol && !LANE.test(s.symbol.path), `no test path: ${s.symbol?.path}`);
            assert.equal(s.trust, null);
            assert.match(s.description, /^<untrusted-content source="symbol-doc">/);
        }
        assert.equal(out.derived.steps.at(-1).handoff, null);
    });
    it('a file anchor resolves to a file shape named by its path and keeps its trust', async () => {
        const adr = 'docs/architecture/adr/0002-world-model-concept-layer.md';
        const parsedFile = 'mcp/trajectory-server/src/symbol-index.ts';
        const out = parse((await wm()['world_model_concept_upsert']({
            agent: 'bro',
            repo,
            name: 'file anchors',
            body: 'A concept over whole files.',
            steps: [
                { path: adr, description: 'The design record.', handoff: 'calls' },
                { path: parsedFile, description: 'The L1 index.' },
            ],
        })));
        const got = parse((await wm()['world_model_concept_get']({ agent: 'bro', id: out.id })));
        assert.deepEqual(got.steps.map((s) => s.trust), ['verified', 'verified']);
        for (const [i, path] of [adr, parsedFile].entries()) {
            assert.deepEqual(got.steps[i].symbol, {
                id: null,
                repo,
                path,
                kind: 'file',
                qualified_name: path,
                signature: null,
                doc: null,
                line_start: null,
                line_end: null,
            });
        }
    });
});
describe('L2 concept drift and re-resolution on a temp copy of the repo (GH 1680)', () => {
    const ws = mkdtempSync(join(tmpdir(), 'wm-concepts-'));
    const root = join(ws, 'plugin');
    const db = tempDB();
    const holder = GraphHolder.fixed(new WorldModelGraph(db));
    const wm = () => worldModelTools(db, holder).handlers;
    const SYMBOL_INDEX = join(root, 'mcp/trajectory-server/src/symbol-index.ts');
    const IS_TEST_PATH = /export function isTestPath\(path: string\): boolean \{\n[^}]*\}\n/;
    let repo = '';
    let original = '';
    const commit = () => {
        execFileSync('git', ['add', '-A'], { cwd: root });
        execFileSync('git', ['commit', '-qm', 'change', '--allow-empty'], { cwd: root });
    };
    const getConcept = async (id) => parse((await wm()['world_model_concept_get']({ agent: 'bro', id })));
    const rowCounts = () => db.get(`SELECT (SELECT COUNT(*) FROM wm_concepts) AS concepts, (SELECT COUNT(*) FROM wm_concept_steps) AS steps,
              (SELECT COUNT(*) FROM wm_concept_claims) AS claims`);
    before(async () => {
        execFileSync('git', ['clone', '-q', WORKTREE, root]);
        execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
        original = readFileSync(SYMBOL_INDEX, 'utf8');
        assert.match(original, IS_TEST_PATH);
        repo = (await scan(db, holder, ws)).repos[0].name;
    });
    after(() => {
        db.close();
        rmSync(ws, { recursive: true, force: true });
    });
    let id = 0;
    it('editing an anchored body makes the step and concept suspect, naming the step', async () => {
        id = parse((await wm()['world_model_concept_upsert'](SCAN_FLOW(repo)))).id;
        writeFileSync(SYMBOL_INDEX, original.replace(IS_TEST_PATH, 'export function isTestPath(path: string): boolean {\n  return path.includes("/test/");\n}\n'));
        commit();
        const out = await scan(db, holder, ws);
        assert.equal(out.symbols.files_parsed, 1);
        const got = await getConcept(id);
        assert.equal(got.status, 'suspect');
        assert.match(String(got.status_reason), /step 3 isTestPath: changed since verification/);
        assert.deepEqual(got.steps.map((s) => s.trust), ['verified', 'verified', 'suspect']);
        assert.equal(got.steps[2].trust_reason, 'changed since verification');
    });
    it('deleting the anchored function breaks the step and concept, and concept_get gives symbol null', async () => {
        writeFileSync(SYMBOL_INDEX, original.replace(IS_TEST_PATH, ''));
        commit();
        await scan(db, holder, ws);
        const got = await getConcept(id);
        assert.equal(got.status, 'broken');
        assert.match(String(got.status_reason), /step 3 isTestPath: anchor gone/);
        assert.equal(got.steps[2].trust, 'broken');
        assert.equal(got.steps[2].symbol, null);
        assert.notEqual(got.steps[0].symbol, null);
    });
    it('re-upserting over the restored function restores verified and keeps the id', async () => {
        writeFileSync(SYMBOL_INDEX, original);
        commit();
        await scan(db, holder, ws);
        const again = parse((await wm()['world_model_concept_upsert'](SCAN_FLOW(repo))));
        assert.deepEqual(again, { id, status: 'verified', steps: 3, claims: 1 });
        const got = await getConcept(id);
        assert.equal(got.status, 'verified');
        assert.equal(got.status_reason, null);
        assert.ok(got.steps.every((s) => s.trust === 'verified' && s.symbol !== null));
    });
    it('an unknown anchor or a failing claim is an error and writes no rows', async () => {
        const before = rowCounts();
        const unknown = SCAN_FLOW(repo);
        unknown.name = 'unknown anchor';
        unknown.steps[1].qualified_name = 'noSuchFunction';
        const r1 = (await wm()['world_model_concept_upsert'](unknown));
        assert.ok(r1.isError);
        assert.match(text(r1), /anchor not found: step 2 noSuchFunction/);
        const failing = SCAN_FLOW(repo);
        failing.name = 'failing claim';
        failing.claims[0].args = { from: failing.claims[0].args.to, to: failing.claims[0].args.from };
        const r2 = (await wm()['world_model_concept_upsert'](failing));
        assert.ok(r2.isError);
        assert.match(text(r2), /claim fails at write time/);
        const lane = SCAN_FLOW(repo);
        lane.name = 'test anchor';
        lane.steps[0].path = 'mcp/trajectory-server/src/test/helpers.ts';
        const r3 = (await wm()['world_model_concept_upsert'](lane));
        assert.ok(r3.isError);
        assert.deepEqual({ ...rowCounts() }, { ...before });
    });
    it('a caller left unresolved resolves exactly once its callee lands in another file, without re-parsing the caller', async () => {
        mkdirSync(join(root, 'src/rr'), { recursive: true });
        writeFileSync(join(root, 'src/rr/caller.ts'), "import { brandNewHelper } from './callee.js';\n\nexport function useHelper(): number {\n  return brandNewHelper(2);\n}\n");
        commit();
        await scan(db, holder, ws);
        const edge = () => db.get(`SELECT e.rowid AS rowid, e.resolution, e.dst_id FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id
          WHERE s.qualified_name = 'useHelper' AND e.kind = 'calls' AND e.dst_name = 'brandNewHelper'`);
        const first = { ...edge() };
        assert.equal(first.resolution, 'unresolved');
        assert.equal(first.dst_id, null);
        writeFileSync(join(root, 'src/rr/callee.ts'), 'export function brandNewHelper(n: number): number {\n  return n * 2;\n}\n');
        commit();
        const out = await scan(db, holder, ws);
        assert.equal(out.symbols.files_parsed, 1, 'only the new file parses');
        const second = { ...edge() };
        const callee = db.get(`SELECT id FROM wm_symbols WHERE qualified_name = 'brandNewHelper' AND path = 'src/rr/callee.ts'`);
        assert.equal(second.rowid, first.rowid, 'the caller edge row was not rewritten');
        assert.equal(second.resolution, 'exact');
        assert.equal(second.dst_id, callee.id);
    });
    const edgeTo = (target, srcName, kind, dstName) => target.get(`SELECT e.rowid AS rowid, e.resolution, e.dst_id, t.path AS dst_path, t.kind AS dst_kind
         FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id LEFT JOIN wm_symbols t ON t.id = e.dst_id
        WHERE s.qualified_name = ? AND e.kind = ? AND e.dst_name = ?`, [srcName, kind, dstName]);
    it('a caller of a shell function moved to another sourced file resolves exactly after one rescan', async () => {
        mkdirSync(join(root, 'src/rr'), { recursive: true });
        writeFileSync(join(root, 'src/rr/caller.sh'), '#!/usr/bin/env bash\nsource ./one.sh\nsource ./two.sh\n\nrr_run_it() {\n  rr_moved_helper\n}\n');
        writeFileSync(join(root, 'src/rr/one.sh'), '#!/usr/bin/env bash\nrr_moved_helper() {\n  echo one\n}\n\nrr_keep_one() {\n  echo keep\n}\n');
        writeFileSync(join(root, 'src/rr/two.sh'), '#!/usr/bin/env bash\nrr_keep_two() {\n  echo two\n}\n');
        commit();
        await scan(db, holder, ws);
        const first = { ...edgeTo(db, 'rr_run_it', 'calls', 'rr_moved_helper') };
        assert.deepEqual([first.resolution, first.dst_path], ['exact', 'src/rr/one.sh']);
        writeFileSync(join(root, 'src/rr/one.sh'), '#!/usr/bin/env bash\nrr_keep_one() {\n  echo keep\n}\n');
        writeFileSync(join(root, 'src/rr/two.sh'), '#!/usr/bin/env bash\nrr_keep_two() {\n  echo two\n}\n\nrr_moved_helper() {\n  echo moved\n}\n');
        commit();
        const out = await scan(db, holder, ws);
        assert.equal(out.symbols.files_parsed, 2, 'caller.sh is not re-parsed');
        const second = { ...edgeTo(db, 'rr_run_it', 'calls', 'rr_moved_helper') };
        assert.equal(second.rowid, first.rowid, 'the caller edge row was not rewritten');
        assert.equal(second.resolution, 'exact');
        assert.notEqual(second.dst_id, null);
        assert.equal(second.dst_path, 'src/rr/two.sh');
    });
    it('an importer of a function re-created as a class in the same file resolves exactly after one rescan', async () => {
        mkdirSync(join(root, 'src/rr'), { recursive: true });
        writeFileSync(join(root, 'src/rr/a.ts'), 'export function RrWidgetThing(): number {\n  return 1;\n}\n');
        writeFileSync(join(root, 'src/rr/b.ts'), "import { RrWidgetThing } from './a.js';\n\nexport function rrBuildWidget(): unknown {\n  return RrWidgetThing();\n}\n");
        commit();
        await scan(db, holder, ws);
        const call = () => ({ ...edgeTo(db, 'rrBuildWidget', 'calls', 'RrWidgetThing') });
        const first = call();
        assert.deepEqual([first.resolution, first.dst_kind], ['exact', 'function']);
        writeFileSync(join(root, 'src/rr/a.ts'), 'export class RrWidgetThing {\n  size = 1;\n}\n');
        commit();
        const out = await scan(db, holder, ws);
        assert.equal(out.symbols.files_parsed, 1, 'b.ts is not re-parsed');
        const second = call();
        assert.equal(second.rowid, first.rowid, 'the caller edge row was not rewritten');
        assert.equal(second.resolution, 'exact');
        assert.notEqual(second.dst_id, null);
        assert.deepEqual([second.dst_path, second.dst_kind], ['src/rr/a.ts', 'class']);
    });
    it('the incrementally re-resolved edges match a fresh full index of the same tree', async () => {
        const edgesOf = (target) => target
            .all(`SELECT s.path, s.qualified_name AS src, e.kind, e.dst_name, e.line, e.resolution,
                  t.path AS dst_path, t.kind AS dst_kind, t.qualified_name AS dst_qn
             FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id LEFT JOIN wm_symbols t ON t.id = e.dst_id
            WHERE s.path LIKE 'src/rr/%'
            ORDER BY s.path, s.qualified_name, e.kind, e.dst_name, e.line`)
            .map((r) => ({ ...r }));
        const fresh = tempDB();
        try {
            await scan(fresh, GraphHolder.fixed(new WorldModelGraph(fresh)), ws);
            const incremental = edgesOf(db);
            assert.ok(incremental.length > 0);
            assert.deepEqual(incremental, edgesOf(fresh));
        }
        finally {
            fresh.close();
        }
    });
});
describe('concepts proposed at close, applied by scan once reviewed (GH 1680)', () => {
    const ws = mkdtempSync(join(tmpdir(), 'wm-proposals-'));
    const root = join(ws, 'fixture');
    const db = tempDB();
    const holder = GraphHolder.fixed(new WorldModelGraph(db));
    const DAY = 86_400_000;
    let repo = '';
    let branches = 0;
    const proposal = (name, finisher = 'finishRun') => ({
        name,
        kind: 'flow',
        body: 'How a run starts and finishes.',
        steps: [
            { path: 'src/start.ts', kind: 'function', qualified_name: 'startRun', description: 'Starts the run.', handoff: 'calls' },
            { path: 'src/finish.ts', kind: 'function', qualified_name: finisher, description: 'Finishes the run.' },
        ],
    });
    const closedTask = (concepts, opts) => {
        const closedAt = opts.closedAt.toISOString();
        const branch = `feat/1-proposals-${++branches}`;
        db.run(`INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, files, verification, commit_sha, repo,
                          completion_report, created_at, updated_at)
       VALUES (1, ?, 't', 'd', 'closed', '', '[]', '[]', 'abc1234', ?, ?, ?, ?)`, [branch, repo, JSON.stringify({ criteria: [{ id: 'SC1', status: 'met' }], concepts }), closedAt, closedAt]);
        const id = db.get('SELECT MAX(id) AS id FROM tasks').id;
        if (opts.reviewed) {
            insertAudit(db, {
                issue_id: 1,
                branch_id: branch,
                from_node: 'bro',
                event_type: 'bro_verification_pass',
                summary: 'verified',
                content_json: JSON.stringify({ task_id: id, commit_sha: 'abc1234' }),
                created_at: new Date(opts.closedAt.getTime() - 2 * 60_000).toISOString(),
                repo,
            });
            db.run(`INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, created_at) VALUES (?, 1, 'pr-reviewer', 'pass', 1, ?)`, [id, new Date(opts.closedAt.getTime() - 60_000).toISOString()]);
        }
        return id;
    };
    const rows = (event) => db
        .all(`SELECT content_json FROM audit WHERE event_type = ? ORDER BY id`, [event])
        .map((r) => JSON.parse(r.content_json));
    before(async () => {
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'src/start.ts'), "import { finishRun } from './finish.js';\n\nexport function startRun(): number {\n  return finishRun(1);\n}\n");
        writeFileSync(join(root, 'src/finish.ts'), 'export function finishRun(n: number): number {\n  return n + 1;\n}\n');
        execFileSync('git', ['init', '-q'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
        execFileSync('git', ['add', '-A'], { cwd: root });
        execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
        repo = (await scan(db, holder, ws)).repos[0].name;
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
       VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
    });
    after(() => {
        db.close();
        rmSync(ws, { recursive: true, force: true });
    });
    let reviewed = 0;
    it('a scan applies a reviewed task\'s proposal as a verified concept and writes one applied row', async () => {
        reviewed = closedTask([proposal('run flow')], { reviewed: true, closedAt: new Date() });
        closedTask([proposal('unreviewed flow')], { reviewed: false, closedAt: new Date() });
        await scan(db, holder, ws);
        const concepts = db.all(`SELECT id, name, status, verified_by FROM wm_concepts WHERE repo = ?`, [repo]);
        assert.deepEqual(concepts.map((c) => ({ ...c })), [{ id: concepts[0].id, name: 'run flow', status: 'verified', verified_by: 'swe' }]);
        assert.deepEqual(rows('concept_proposal_applied'), [{ task_id: reviewed, concept_id: concepts[0].id, name: 'run flow' }]);
        assert.deepEqual(rows('concept_proposal_rejected'), []);
    });
    it('a second scan does not re-apply, and the unreviewed proposal stays unapplied', async () => {
        await scan(db, holder, ws);
        assert.equal(rows('concept_proposal_applied').length, 1);
        assert.equal(db.get(`SELECT COUNT(*) AS n FROM wm_concepts WHERE name = 'unreviewed flow'`).n, 0);
    });
    it('an unresolved anchor stays pending without a row until 14 days after close, then writes one rejected row', () => {
        const now = new Date();
        const fresh = closedTask([proposal('fresh broken', 'noSuchFunction')], { reviewed: true, closedAt: now });
        const old = closedTask([proposal('old broken', 'noSuchFunction')], { reviewed: true, closedAt: new Date(now.getTime() - 15 * DAY) });
        assert.deepEqual(applyConceptProposals(db, repo, root, now), { applied: 0, rejected: 1, pending: 1 });
        const rejected = rows('concept_proposal_rejected');
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0]['task_id'], old);
        assert.equal(rejected[0]['name'], 'old broken');
        assert.match(String(rejected[0]['error']), /anchor not found: step 2 noSuchFunction/);
        assert.deepEqual(applyConceptProposals(db, repo, root, now), { applied: 0, rejected: 0, pending: 1 });
        assert.equal(rows('concept_proposal_rejected').length, 1, 'a settled proposal is not retried');
        assert.deepEqual(applyConceptProposals(db, repo, root, new Date(now.getTime() + 14 * DAY)), { applied: 0, rejected: 1, pending: 0 });
        assert.deepEqual(rows('concept_proposal_rejected').map((r) => r['task_id']), [old, fresh]);
        assert.equal(rows('concept_proposal_applied').length, 1);
    });
});
//# sourceMappingURL=world-model-concepts.test.js.map