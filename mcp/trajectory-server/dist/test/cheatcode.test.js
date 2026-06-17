import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDB } from './helpers.js';
import { cheatcodeTools } from '../tools/cheatcode.js';
function parse(r) {
    return JSON.parse(r.content[0].text);
}
async function call(handlers, name, args) {
    const h = handlers[name];
    assert.ok(h, `handler not found: ${name}`);
    return h(args);
}
// Mixed-tier fixture. The curated (tier 2) candidate is given STRICTLY MORE
// relevance than the official (tier 1) one, so a tier-blind ranker would float
// it to the top. Tier dominance (200 base vs 100) must keep official first.
const FIXTURE = JSON.stringify([
    {
        name: 'curated-pdf',
        kind: 'skill',
        source_url: 'https://example.test/curated-pdf',
        description: 'extract pdf table data from documents',
        registry: 'pulsemcp',
        tier: 2,
    },
    {
        name: 'official-pdf',
        kind: 'skill',
        source_url: 'https://example.test/official-pdf',
        description: 'pdf tooling',
        registry: 'mcp-official',
        tier: 1,
    },
    {
        name: 'unrelated-thing',
        kind: 'mcp',
        source_url: 'https://example.test/unrelated',
        description: 'manages kubernetes clusters',
        registry: 'mcp-official',
        tier: 1,
    },
]);
describe('cheatcode_search', () => {
    function withFixture() {
        const dir = mkdtempSync(join(tmpdir(), 'tmb-cheatcode-'));
        const path = join(dir, 'candidates.json');
        writeFileSync(path, FIXTURE);
        return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    }
    it('ranks official (tier 1) above curated (tier 2) even when curated is more relevant', async () => {
        const db = tempDB();
        const { path, cleanup } = withFixture();
        process.env['TMB_CHEATCODE_SEARCH_FIXTURE'] = path;
        try {
            const tools = cheatcodeTools(db);
            const r = await call(tools.handlers, 'cheatcode_search', {
                agent: 'bro',
                capability_query: 'pdf table extraction',
            });
            const out = parse(r);
            const candidates = out['candidates'];
            assert.ok(candidates.length >= 2, 'at least two candidates returned');
            for (let i = 1; i < candidates.length; i++) {
                assert.ok(candidates[i - 1].score >= candidates[i].score, `score order violated at index ${i}`);
            }
            // official-pdf (tier 1, relevance 1) must beat curated-pdf (tier 2, relevance 2):
            // tier dominance (200 base) outweighs the curated candidate's extra relevance.
            assert.equal(candidates[0].name, 'official-pdf');
            assert.equal(candidates[0].signals.tier, 1);
            const official = candidates.find((c) => c.name === 'official-pdf');
            const curated = candidates.find((c) => c.name === 'curated-pdf');
            assert.ok(curated.signals.relevance > official.signals.relevance, 'curated is more relevant');
            assert.ok(official.score > curated.score, 'official still outscores curated by tier');
            assert.equal(official.signals.registry, 'mcp-official');
            assert.equal(curated.signals.registry, 'pulsemcp');
        }
        finally {
            delete process.env['TMB_CHEATCODE_SEARCH_FIXTURE'];
            cleanup();
        }
    });
    it('filters candidates by kind', async () => {
        const db = tempDB();
        const { path, cleanup } = withFixture();
        process.env['TMB_CHEATCODE_SEARCH_FIXTURE'] = path;
        try {
            const tools = cheatcodeTools(db);
            const r = await call(tools.handlers, 'cheatcode_search', {
                agent: 'bro',
                capability_query: 'pdf',
                kind: 'skill',
            });
            const out = parse(r);
            const candidates = out['candidates'];
            assert.ok(candidates.every((c) => c.kind === 'skill'), 'all candidates are skills');
            assert.equal(out['kind'], 'skill');
        }
        finally {
            delete process.env['TMB_CHEATCODE_SEARCH_FIXTURE'];
            cleanup();
        }
    });
    it('writes a cheatcode_search audit row', async () => {
        const db = tempDB();
        const { path, cleanup } = withFixture();
        process.env['TMB_CHEATCODE_SEARCH_FIXTURE'] = path;
        try {
            const tools = cheatcodeTools(db);
            await call(tools.handlers, 'cheatcode_search', {
                agent: 'bro',
                capability_query: 'pdf table extraction',
            });
            const row = db.get(`SELECT event_type, content_json FROM audit WHERE event_type = 'cheatcode_search' ORDER BY id DESC LIMIT 1`);
            assert.ok(row, 'cheatcode_search audit row exists');
            const content = JSON.parse(row.content_json);
            assert.equal(content.query, 'pdf table extraction');
            assert.ok(typeof content.candidate_count === 'number');
        }
        finally {
            delete process.env['TMB_CHEATCODE_SEARCH_FIXTURE'];
            cleanup();
        }
    });
    it('rejects a non-bro caller', async () => {
        const db = tempDB();
        const tools = cheatcodeTools(db);
        const r = await call(tools.handlers, 'cheatcode_search', {
            agent: 'swe',
            capability_query: 'pdf',
        });
        assert.equal(r.isError, true);
        const out = parse(r);
        assert.equal(out['error'], 'forbidden');
    });
});
// Vet fixtures stub the network exactly as TMB_CHEATCODE_VET_FIXTURE intends:
// the {repo, contents} object stands in for the best-effort GitHub responses.
const VET_OFFICIAL = JSON.stringify({
    repo: {
        stargazers_count: 1200,
        forks_count: 80,
        pushed_at: '2026-05-01T00:00:00Z',
        archived: false,
        license: { spdx_id: 'MIT' },
        owner: { login: 'anthropics', type: 'Organization' },
    },
    contents: ['README.md', 'LICENSE'],
});
const VET_EXEC = JSON.stringify({
    repo: {
        stargazers_count: 9000,
        forks_count: 800,
        pushed_at: '2026-06-01T00:00:00Z',
        archived: false,
        license: { spdx_id: 'Apache-2.0' },
        owner: { login: 'someorg', type: 'Organization' },
    },
    contents: ['README.md', 'hooks', 'scripts'],
});
const VET_ARCHIVED = JSON.stringify({
    repo: {
        stargazers_count: 50,
        forks_count: 2,
        pushed_at: '2022-01-01T00:00:00Z',
        archived: true,
        license: { spdx_id: 'MIT' },
        owner: { login: 'x', type: 'User' },
    },
});
const VET_EMPTY = JSON.stringify({});
describe('cheatcode_vet', () => {
    function withFixture(body) {
        const dir = mkdtempSync(join(tmpdir(), 'tmb-cheatcode-vet-'));
        const path = join(dir, 'signals.json');
        writeFileSync(path, body);
        return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    }
    async function vet(body, candidate) {
        const db = tempDB();
        const { path, cleanup } = withFixture(body);
        process.env['TMB_CHEATCODE_VET_FIXTURE'] = path;
        try {
            const tools = cheatcodeTools(db);
            const r = await call(tools.handlers, 'cheatcode_vet', { agent: 'bro', candidate });
            assert.notEqual(r.isError, true, `vet errored: ${r.content[0]?.text}`);
            return parse(r);
        }
        finally {
            delete process.env['TMB_CHEATCODE_VET_FIXTURE'];
            cleanup();
        }
    }
    it('classifies an official tier-1 candidate with no exec surface as trusted', async () => {
        const out = await vet(VET_OFFICIAL, {
            name: 'official-pdf',
            kind: 'skill',
            source_url: 'https://github.com/anthropics/pdf',
            tier: 1,
        });
        assert.equal(out.trust_tier, 'trusted');
        assert.deepEqual(out.capabilities, []);
        assert.equal(out.signals.reputation.registry_tier, 1);
        assert.equal(out.signals.reputation.stars, 1200);
        assert.equal(out.signals.license, 'MIT');
        assert.equal(out.signals.maintainer.login, 'anthropics');
    });
    it('orders tiers: trusted > caution > untrusted > unknown by signal strength', async () => {
        const trusted = await vet(VET_OFFICIAL, {
            name: 'a',
            kind: 'skill',
            source_url: 'https://github.com/anthropics/pdf',
            tier: 1,
        });
        const caution = await vet(VET_EXEC, {
            name: 'b',
            kind: 'skill',
            source_url: 'https://github.com/someorg/hooky',
        });
        const untrusted = await vet(VET_ARCHIVED, {
            name: 'c',
            kind: 'skill',
            source_url: 'https://github.com/x/old',
            tier: 2,
        });
        const unknown = await vet(VET_EMPTY, {
            name: 'd',
            kind: 'skill',
            source_url: 'https://gitlab.com/x/y',
        });
        assert.equal(trusted.trust_tier, 'trusted');
        assert.equal(caution.trust_tier, 'caution');
        assert.equal(untrusted.trust_tier, 'untrusted');
        assert.equal(unknown.trust_tier, 'unknown');
    });
    it('flags code_execution for a candidate that ships hooks/scripts and never trusts it on popularity', async () => {
        const out = await vet(VET_EXEC, {
            name: 'hooky',
            kind: 'skill',
            source_url: 'https://github.com/someorg/hooky',
        });
        assert.ok(out.capabilities.includes('code_execution'), 'code_execution flagged');
        assert.equal(out.signals.security_surface.code_execution, true);
        assert.notEqual(out.trust_tier, 'trusted', 'popular code-executing cheatcode is never trusted');
        assert.equal(out.trust_tier, 'caution');
    });
    it('degrades to unknown on an empty/failed signal set and never throws', async () => {
        const out = await vet(VET_EMPTY, {
            name: 'mystery',
            kind: 'skill',
            source_url: 'https://gitlab.com/x/y',
        });
        assert.equal(out.trust_tier, 'unknown');
        assert.equal(out.signals.reputation.stars, null);
        assert.equal(out.signals.maintainer.login, null);
    });
    it('is deterministic: identical input yields identical output', async () => {
        const cand = { name: 'hooky', kind: 'skill', source_url: 'https://github.com/someorg/hooky' };
        const a = await vet(VET_EXEC, cand);
        const b = await vet(VET_EXEC, cand);
        assert.deepEqual(a, b);
    });
    it('writes a cheatcode_vet audit row carrying the candidate + tier', async () => {
        const db = tempDB();
        const { path, cleanup } = withFixture(VET_OFFICIAL);
        process.env['TMB_CHEATCODE_VET_FIXTURE'] = path;
        try {
            const tools = cheatcodeTools(db);
            await call(tools.handlers, 'cheatcode_vet', {
                agent: 'bro',
                candidate: { name: 'official-pdf', kind: 'skill', source_url: 'https://github.com/anthropics/pdf', tier: 1 },
            });
            const row = db.get(`SELECT event_type, content_json FROM audit WHERE event_type = 'cheatcode_vet' ORDER BY id DESC LIMIT 1`);
            assert.ok(row, 'cheatcode_vet audit row exists');
            const content = JSON.parse(row.content_json);
            assert.equal(content.candidate.name, 'official-pdf');
            assert.equal(content.trust_tier, 'trusted');
            assert.ok(Array.isArray(content.capabilities));
        }
        finally {
            delete process.env['TMB_CHEATCODE_VET_FIXTURE'];
            cleanup();
        }
    });
    it('rejects a non-bro caller', async () => {
        const db = tempDB();
        const tools = cheatcodeTools(db);
        const r = await call(tools.handlers, 'cheatcode_vet', {
            agent: 'swe',
            candidate: { name: 'x', kind: 'skill', source_url: 'https://github.com/x/y' },
        });
        assert.equal(r.isError, true);
        const out = parse(r);
        assert.equal(out['error'], 'forbidden');
    });
});
// Install fixtures stub the marketplace exactly as TMB_CHEATCODE_INSTALL_FIXTURE
// intends: the {installed, version} object stands in for the marketplace call.
const INSTALL_OK = JSON.stringify({ installed: true, version: '1.2.3' });
describe('cheatcode_install', () => {
    function withFixture(body) {
        const dir = mkdtempSync(join(tmpdir(), 'tmb-cheatcode-install-'));
        const path = join(dir, 'install.json');
        writeFileSync(path, body);
        return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    }
    it('writes one cheatcodes row + its attachment row in a single transaction', async () => {
        const db = tempDB();
        const { path, cleanup } = withFixture(INSTALL_OK);
        process.env['TMB_CHEATCODE_INSTALL_FIXTURE'] = path;
        try {
            const tools = cheatcodeTools(db);
            const r = await call(tools.handlers, 'cheatcode_install', {
                agent: 'bro',
                candidate: { name: 'pdf-plugin', kind: 'plugin', source_url: 'https://github.com/x/pdf', tier: 1 },
                trust_tier: 'trusted',
            });
            assert.notEqual(r.isError, true, `install errored: ${r.content[0]?.text}`);
            const out = parse(r);
            assert.equal(out['installed'], true);
            const codes = db.all(`SELECT id, name, trust_tier, version, status FROM cheatcodes WHERE origin = 'installed'`);
            assert.equal(codes.length, 1, 'exactly one cheatcodes row');
            assert.equal(codes[0].name, 'pdf-plugin');
            assert.equal(codes[0].trust_tier, 'trusted');
            assert.equal(codes[0].version, '1.2.3');
            assert.equal(codes[0].status, 'installed');
            const atts = db.all(`SELECT cheatcode_id, target, artifact FROM cheatcode_attachments`);
            assert.ok(atts.length >= 1, 'at least one attachment row');
            assert.equal(atts[0].cheatcode_id, codes[0].id, 'attachment FKs the cheatcode');
            assert.equal(atts[0].target, 'plugin');
        }
        finally {
            delete process.env['TMB_CHEATCODE_INSTALL_FIXTURE'];
            cleanup();
        }
    });
    it('defaults install scope to local, persisting project-local on the unified row (#101)', async () => {
        const db = tempDB();
        const { path, cleanup } = withFixture(INSTALL_OK);
        process.env['TMB_CHEATCODE_INSTALL_FIXTURE'] = path;
        try {
            const tools = cheatcodeTools(db);
            const r = await call(tools.handlers, 'cheatcode_install', {
                agent: 'bro',
                candidate: { name: 'pdf-plugin', kind: 'plugin', source_url: 'https://github.com/x/pdf' },
            });
            assert.notEqual(r.isError, true, `install errored: ${r.content[0]?.text}`);
            const out = parse(r);
            assert.equal(out['scope'], 'project-local', 'response echoes the mapped placement scope');
            const row = db.get(`SELECT scope, origin FROM cheatcodes WHERE origin = 'installed' LIMIT 1`);
            assert.equal(row.scope, 'project-local', 'local install maps to project-local placement');
            assert.equal(row.origin, 'installed', 'installed cheatcodes carry origin=installed');
        }
        finally {
            delete process.env['TMB_CHEATCODE_INSTALL_FIXTURE'];
            cleanup();
        }
    });
    it('persists scope=global when requested', async () => {
        const db = tempDB();
        const { path, cleanup } = withFixture(INSTALL_OK);
        process.env['TMB_CHEATCODE_INSTALL_FIXTURE'] = path;
        try {
            const tools = cheatcodeTools(db);
            const r = await call(tools.handlers, 'cheatcode_install', {
                agent: 'bro',
                candidate: { name: 'pdf-plugin', kind: 'plugin', source_url: 'https://github.com/x/pdf' },
                scope: 'global',
            });
            assert.notEqual(r.isError, true, `install errored: ${r.content[0]?.text}`);
            assert.equal(parse(r)['scope'], 'global');
            const row = db.get(`SELECT scope FROM cheatcodes WHERE origin = 'installed' LIMIT 1`);
            assert.equal(row.scope, 'global', 'global install persists global placement');
        }
        finally {
            delete process.env['TMB_CHEATCODE_INSTALL_FIXTURE'];
            cleanup();
        }
    });
    it('routes two install candidates to distinct per-agent attachment targets', async () => {
        const db = tempDB();
        const tools = cheatcodeTools(db);
        // The fixture carries the attachment target: feature-dev → swe,
        // code-review → pr-reviewer. The script passes it through, the handler
        // records it on cheatcode_attachments.target.
        const featureDev = withFixture(JSON.stringify({
            installed: true,
            version: '1.0.0',
            attachments: [{ target: 'swe', artifact: 'marketplace-plugin:feature-dev' }],
        }));
        process.env['TMB_CHEATCODE_INSTALL_FIXTURE'] = featureDev.path;
        let featureId;
        try {
            const r = await call(tools.handlers, 'cheatcode_install', {
                agent: 'bro',
                candidate: { name: 'feature-dev', kind: 'plugin', source_url: 'https://github.com/x/feature-dev' },
            });
            assert.notEqual(r.isError, true, `feature-dev install errored: ${r.content[0]?.text}`);
            featureId = parse(r)['cheatcode_id'];
        }
        finally {
            delete process.env['TMB_CHEATCODE_INSTALL_FIXTURE'];
            featureDev.cleanup();
        }
        const codeReview = withFixture(JSON.stringify({
            installed: true,
            version: '1.0.0',
            attachments: [{ target: 'pr-reviewer', artifact: 'marketplace-plugin:code-review' }],
        }));
        process.env['TMB_CHEATCODE_INSTALL_FIXTURE'] = codeReview.path;
        let reviewId;
        try {
            const r = await call(tools.handlers, 'cheatcode_install', {
                agent: 'bro',
                candidate: { name: 'code-review', kind: 'plugin', source_url: 'https://github.com/x/code-review' },
            });
            assert.notEqual(r.isError, true, `code-review install errored: ${r.content[0]?.text}`);
            reviewId = parse(r)['cheatcode_id'];
        }
        finally {
            delete process.env['TMB_CHEATCODE_INSTALL_FIXTURE'];
            codeReview.cleanup();
        }
        const featureTarget = db.get(`SELECT target FROM cheatcode_attachments WHERE cheatcode_id = ?`, [featureId]);
        const reviewTarget = db.get(`SELECT target FROM cheatcode_attachments WHERE cheatcode_id = ?`, [reviewId]);
        assert.equal(featureTarget.target, 'swe', 'feature-dev routes to swe');
        assert.equal(reviewTarget.target, 'pr-reviewer', 'code-review routes to pr-reviewer');
        assert.notEqual(featureTarget.target, reviewTarget.target, 'targets are distinct per candidate');
    });
    it('per-candidate keyed fixture routes two installs from ONE file to distinct targets', async () => {
        const db = tempDB();
        const tools = cheatcodeTools(db);
        // A SINGLE fixture file keyed by candidate name. Both installs read the same
        // file; each candidate's own entry selects its attachment target.
        const keyed = withFixture(JSON.stringify({
            'feature-dev': {
                installed: true,
                version: '1.0.0',
                attachments: [{ target: 'swe', artifact: 'marketplace-plugin:feature-dev' }],
            },
            'code-review': {
                installed: true,
                version: '1.0.0',
                attachments: [{ target: 'pr-reviewer', artifact: 'marketplace-plugin:code-review' }],
            },
        }));
        process.env['TMB_CHEATCODE_INSTALL_FIXTURE'] = keyed.path;
        try {
            const rf = await call(tools.handlers, 'cheatcode_install', {
                agent: 'bro',
                candidate: { name: 'feature-dev', kind: 'plugin', source_url: 'https://github.com/x/feature-dev' },
            });
            assert.notEqual(rf.isError, true, `feature-dev install errored: ${rf.content[0]?.text}`);
            const featureId = parse(rf)['cheatcode_id'];
            const rr = await call(tools.handlers, 'cheatcode_install', {
                agent: 'bro',
                candidate: { name: 'code-review', kind: 'plugin', source_url: 'https://github.com/x/code-review' },
            });
            assert.notEqual(rr.isError, true, `code-review install errored: ${rr.content[0]?.text}`);
            const reviewId = parse(rr)['cheatcode_id'];
            const featureTarget = db.get(`SELECT target FROM cheatcode_attachments WHERE cheatcode_id = ?`, [featureId]);
            const reviewTarget = db.get(`SELECT target FROM cheatcode_attachments WHERE cheatcode_id = ?`, [reviewId]);
            assert.equal(featureTarget.target, 'swe', 'feature-dev entry routes to swe');
            assert.equal(reviewTarget.target, 'pr-reviewer', 'code-review entry routes to pr-reviewer');
            assert.notEqual(featureTarget.target, reviewTarget.target, 'targets are distinct per candidate');
        }
        finally {
            delete process.env['TMB_CHEATCODE_INSTALL_FIXTURE'];
            keyed.cleanup();
        }
    });
    it('is idempotent — re-installing the same candidate no-ops', async () => {
        const db = tempDB();
        const { path, cleanup } = withFixture(INSTALL_OK);
        process.env['TMB_CHEATCODE_INSTALL_FIXTURE'] = path;
        try {
            const tools = cheatcodeTools(db);
            const cand = { name: 'pdf-plugin', kind: 'plugin', source_url: 'https://github.com/x/pdf', tier: 1 };
            await call(tools.handlers, 'cheatcode_install', { agent: 'bro', candidate: cand });
            const r2 = await call(tools.handlers, 'cheatcode_install', { agent: 'bro', candidate: cand });
            const out2 = parse(r2);
            assert.equal(out2['idempotent'], true);
            assert.equal(out2['installed'], false);
            const n = db.get(`SELECT COUNT(*) AS n FROM cheatcodes WHERE origin = 'installed'`);
            assert.equal(n.n, 1, 're-install did not duplicate the row');
            const an = db.get(`SELECT COUNT(*) AS n FROM cheatcode_attachments`);
            assert.equal(an.n, 1, 're-install did not duplicate the attachment');
        }
        finally {
            delete process.env['TMB_CHEATCODE_INSTALL_FIXTURE'];
            cleanup();
        }
    });
    it('skill-kind returns a proposed-PR payload and writes no cheatcode_attachments md', async () => {
        const db = tempDB();
        // Skill kind with no fixture installs nothing at the marketplace; the
        // attachment is the proposed-PR payload only.
        const tools = cheatcodeTools(db);
        const r = await call(tools.handlers, 'cheatcode_install', {
            agent: 'bro',
            candidate: { name: 'pdf-skill', kind: 'skill', source_url: 'https://github.com/x/pdf-skill' },
        });
        assert.notEqual(r.isError, true, `install errored: ${r.content[0]?.text}`);
        const out = parse(r);
        const proposed = out['proposed_pr'];
        assert.ok(proposed, 'proposed_pr payload present for skill kind');
        assert.equal(proposed['kind'], 'agent-frontmatter');
        assert.equal(out['method'], 'skill-proposed-pr');
        assert.equal(out['installed'], false, 'no marketplace install for a standalone skill');
        // The attachment record describes the proposed PR — no agent md is touched.
        const atts = db.all(`SELECT target, artifact FROM cheatcode_attachments`);
        assert.ok(atts.some((a) => a.target === 'proposed-pr'), 'attachment is the proposed-PR plan');
    });
    it('writes cheatcode_install + cheatcode_installed audit rows', async () => {
        const db = tempDB();
        const { path, cleanup } = withFixture(INSTALL_OK);
        process.env['TMB_CHEATCODE_INSTALL_FIXTURE'] = path;
        try {
            const tools = cheatcodeTools(db);
            await call(tools.handlers, 'cheatcode_install', {
                agent: 'bro',
                candidate: { name: 'pdf-plugin', kind: 'plugin', source_url: 'https://github.com/x/pdf', tier: 1 },
            });
            const install = db.get(`SELECT event_type FROM audit WHERE event_type = 'cheatcode_install' ORDER BY id DESC LIMIT 1`);
            const installed = db.get(`SELECT content_json FROM audit WHERE event_type = 'cheatcode_installed' ORDER BY id DESC LIMIT 1`);
            assert.ok(install, 'cheatcode_install audit row exists');
            assert.ok(installed, 'cheatcode_installed audit row exists');
            const content = JSON.parse(installed.content_json);
            assert.equal(content.name, 'pdf-plugin');
            assert.ok(typeof content.cheatcode_id === 'number');
        }
        finally {
            delete process.env['TMB_CHEATCODE_INSTALL_FIXTURE'];
            cleanup();
        }
    });
    it('rejects a non-bro caller', async () => {
        const db = tempDB();
        const tools = cheatcodeTools(db);
        const r = await call(tools.handlers, 'cheatcode_install', {
            agent: 'swe',
            candidate: { name: 'x', kind: 'plugin', source_url: 'https://github.com/x/y' },
        });
        assert.equal(r.isError, true);
        const out = parse(r);
        assert.equal(out['error'], 'forbidden');
    });
    it('cheatcode_approve writes a per-candidate cheatcode_approved audit row', async () => {
        const db = tempDB();
        const tools = cheatcodeTools(db);
        const r = await call(tools.handlers, 'cheatcode_approve', {
            agent: 'bro',
            candidate: { name: 'pdf-plugin', kind: 'plugin', source_url: 'https://github.com/x/pdf' },
        });
        assert.notEqual(r.isError, true);
        const out = parse(r);
        assert.equal(out['approved'], true);
        const row = db.get(`SELECT content_json FROM audit WHERE event_type = 'cheatcode_approved' ORDER BY id DESC LIMIT 1`);
        assert.ok(row, 'cheatcode_approved audit row exists');
        const content = JSON.parse(row.content_json);
        assert.equal(content.source_url, 'https://github.com/x/pdf');
    });
    it('cheatcode_approve rejects a non-bro caller', async () => {
        const db = tempDB();
        const tools = cheatcodeTools(db);
        const r = await call(tools.handlers, 'cheatcode_approve', {
            agent: 'swe',
            candidate: { name: 'x', kind: 'plugin', source_url: 'https://github.com/x/y' },
        });
        assert.equal(r.isError, true);
        const out = parse(r);
        assert.equal(out['error'], 'forbidden');
    });
});
// Uninstall fixtures stub the marketplace exactly as TMB_CHEATCODE_UNINSTALL_FIXTURE
// intends: the {removed} object stands in for the marketplace uninstall call.
const UNINSTALL_OK = JSON.stringify({ removed: true, error: null });
describe('cheatcode_uninstall', () => {
    function withFixture(body) {
        const dir = mkdtempSync(join(tmpdir(), 'tmb-cheatcode-uninstall-'));
        const path = join(dir, 'uninstall.json');
        writeFileSync(path, body);
        return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    }
    // Install a plugin cheatcode and return its id, so uninstall has a real
    // install (+ attachment) to reverse.
    async function seedInstall(tools, candidate) {
        const dir = mkdtempSync(join(tmpdir(), 'tmb-cheatcode-seed-'));
        const path = join(dir, 'install.json');
        writeFileSync(path, INSTALL_OK);
        process.env['TMB_CHEATCODE_INSTALL_FIXTURE'] = path;
        try {
            const r = await call(tools.handlers, 'cheatcode_install', { agent: 'bro', candidate });
            assert.notEqual(r.isError, true, `seed install errored: ${r.content[0]?.text}`);
            return parse(r)['cheatcode_id'];
        }
        finally {
            delete process.env['TMB_CHEATCODE_INSTALL_FIXTURE'];
            rmSync(dir, { recursive: true, force: true });
        }
    }
    it('reverses the install in one transaction: deletes the cheatcodes + attachment rows and emits a cheatcode_uninstalled audit row', async () => {
        const db = tempDB();
        const tools = cheatcodeTools(db);
        const id = await seedInstall(tools, {
            name: 'pdf-plugin',
            kind: 'plugin',
            source_url: 'https://github.com/x/pdf',
            tier: 1,
        });
        assert.equal(db.get(`SELECT COUNT(*) AS n FROM cheatcodes WHERE origin = 'installed'`).n, 1);
        assert.equal(db.get(`SELECT COUNT(*) AS n FROM cheatcode_attachments`).n, 1);
        const { path, cleanup } = withFixture(UNINSTALL_OK);
        process.env['TMB_CHEATCODE_UNINSTALL_FIXTURE'] = path;
        try {
            const r = await call(tools.handlers, 'cheatcode_uninstall', { agent: 'bro', cheatcode_id: id });
            assert.notEqual(r.isError, true, `uninstall errored: ${r.content[0]?.text}`);
            const out = parse(r);
            assert.equal(out['uninstalled'], true);
            assert.equal(out['removed'], true);
            assert.equal(out['method'], 'marketplace');
            assert.equal(db.get(`SELECT COUNT(*) AS n FROM cheatcodes WHERE origin = 'installed'`).n, 0, 'cheatcodes row deleted');
            assert.equal(db.get(`SELECT COUNT(*) AS n FROM cheatcode_attachments`).n, 0, 'attachment row deleted');
            const audit = db.get(`SELECT content_json FROM audit WHERE event_type = 'cheatcode_uninstalled' ORDER BY id DESC LIMIT 1`);
            assert.ok(audit, 'cheatcode_uninstalled audit row exists');
            const content = JSON.parse(audit.content_json);
            assert.equal(content.cheatcode_id, id);
            assert.equal(content.name, 'pdf-plugin');
            assert.equal(content.removed, true);
            assert.ok(Array.isArray(content.attachments), 'audit records what was reversed');
        }
        finally {
            delete process.env['TMB_CHEATCODE_UNINSTALL_FIXTURE'];
            cleanup();
        }
    });
    it('is idempotent — uninstalling an absent install no-ops without error', async () => {
        const db = tempDB();
        const tools = cheatcodeTools(db);
        const r = await call(tools.handlers, 'cheatcode_uninstall', { agent: 'bro', cheatcode_id: 9999 });
        assert.notEqual(r.isError, true, `absent uninstall errored: ${r.content[0]?.text}`);
        const out = parse(r);
        assert.equal(out['uninstalled'], false);
        assert.equal(out['idempotent'], true);
        // No audit row written for a no-op teardown.
        const audit = db.get(`SELECT COUNT(*) AS n FROM audit WHERE event_type = 'cheatcode_uninstalled'`);
        assert.equal(audit.n, 0, 'no audit row for a no-op uninstall');
    });
    it('is idempotent — a second uninstall of the same cheatcode no-ops', async () => {
        const db = tempDB();
        const tools = cheatcodeTools(db);
        const id = await seedInstall(tools, {
            name: 'pdf-plugin',
            kind: 'plugin',
            source_url: 'https://github.com/x/pdf',
        });
        const { path, cleanup } = withFixture(UNINSTALL_OK);
        process.env['TMB_CHEATCODE_UNINSTALL_FIXTURE'] = path;
        try {
            const r1 = await call(tools.handlers, 'cheatcode_uninstall', { agent: 'bro', cheatcode_id: id });
            assert.equal(parse(r1)['uninstalled'], true);
            const r2 = await call(tools.handlers, 'cheatcode_uninstall', { agent: 'bro', cheatcode_id: id });
            assert.notEqual(r2.isError, true);
            assert.equal(parse(r2)['idempotent'], true);
            assert.equal(parse(r2)['uninstalled'], false);
        }
        finally {
            delete process.env['TMB_CHEATCODE_UNINSTALL_FIXTURE'];
            cleanup();
        }
    });
    it('rejects a missing cheatcode_id', async () => {
        const db = tempDB();
        const tools = cheatcodeTools(db);
        const r = await call(tools.handlers, 'cheatcode_uninstall', { agent: 'bro' });
        assert.equal(r.isError, true);
        assert.ok(parse(r)['error']);
    });
    it('rejects a non-bro caller', async () => {
        const db = tempDB();
        const tools = cheatcodeTools(db);
        const r = await call(tools.handlers, 'cheatcode_uninstall', { agent: 'swe', cheatcode_id: 1 });
        assert.equal(r.isError, true);
        assert.equal(parse(r)['error'], 'forbidden');
    });
});
describe('cheatcode_activate', () => {
    async function seedInstall(tools, candidate) {
        const dir = mkdtempSync(join(tmpdir(), 'tmb-cheatcode-act-seed-'));
        const path = join(dir, 'install.json');
        writeFileSync(path, INSTALL_OK);
        process.env['TMB_CHEATCODE_INSTALL_FIXTURE'] = path;
        try {
            const r = await call(tools.handlers, 'cheatcode_install', { agent: 'bro', candidate });
            assert.notEqual(r.isError, true, `seed install errored: ${r.content[0]?.text}`);
            return parse(r)['cheatcode_id'];
        }
        finally {
            delete process.env['TMB_CHEATCODE_INSTALL_FIXTURE'];
            rmSync(dir, { recursive: true, force: true });
        }
    }
    it('returns activated for a skill-kind cheatcode (usable in-session)', async () => {
        const db = tempDB();
        const tools = cheatcodeTools(db);
        // Skill kind with no fixture installs nothing at the marketplace but still
        // records the cheatcodes row, which activate keys off.
        const r0 = await call(tools.handlers, 'cheatcode_install', {
            agent: 'bro',
            candidate: { name: 'pdf-skill', kind: 'skill', source_url: 'https://github.com/x/pdf-skill' },
        });
        const id = parse(r0)['cheatcode_id'];
        const r = await call(tools.handlers, 'cheatcode_activate', { agent: 'bro', cheatcode_id: id });
        assert.notEqual(r.isError, true, `activate errored: ${r.content[0]?.text}`);
        const out = parse(r);
        assert.equal(out['status'], 'activated');
        assert.equal(out['reason'], null);
    });
    it('returns restart_required + a reason for a plugin-kind cheatcode', async () => {
        const db = tempDB();
        const tools = cheatcodeTools(db);
        const id = await seedInstall(tools, {
            name: 'pdf-plugin',
            kind: 'plugin',
            source_url: 'https://github.com/x/pdf',
        });
        const r = await call(tools.handlers, 'cheatcode_activate', { agent: 'bro', cheatcode_id: id });
        assert.notEqual(r.isError, true, `activate errored: ${r.content[0]?.text}`);
        const out = parse(r);
        assert.equal(out['status'], 'restart_required');
        assert.ok(typeof out['reason'] === 'string' && out['reason'].length > 0, 'reason present');
    });
    it('returns restart_required + a reason for an mcp-kind cheatcode', async () => {
        const db = tempDB();
        const tools = cheatcodeTools(db);
        const id = await seedInstall(tools, {
            name: 'pdf-mcp',
            kind: 'mcp',
            source_url: 'https://github.com/x/pdf-mcp',
        });
        const r = await call(tools.handlers, 'cheatcode_activate', { agent: 'bro', cheatcode_id: id });
        const out = parse(r);
        assert.equal(out['status'], 'restart_required');
        assert.ok(typeof out['reason'] === 'string' && out['reason'].length > 0, 'reason present');
    });
    it('writes a cheatcode_activate audit row carrying the verdict', async () => {
        const db = tempDB();
        const tools = cheatcodeTools(db);
        const id = await seedInstall(tools, {
            name: 'pdf-plugin',
            kind: 'plugin',
            source_url: 'https://github.com/x/pdf',
        });
        await call(tools.handlers, 'cheatcode_activate', { agent: 'bro', cheatcode_id: id });
        const row = db.get(`SELECT content_json FROM audit WHERE event_type = 'cheatcode_activate' ORDER BY id DESC LIMIT 1`);
        assert.ok(row, 'cheatcode_activate audit row exists');
        const content = JSON.parse(row.content_json);
        assert.equal(content.cheatcode_id, id);
        assert.equal(content.status, 'restart_required');
    });
    it('errors on an unknown cheatcode_id (never silently throws)', async () => {
        const db = tempDB();
        const tools = cheatcodeTools(db);
        const r = await call(tools.handlers, 'cheatcode_activate', { agent: 'bro', cheatcode_id: 9999 });
        assert.equal(r.isError, true);
        assert.ok(parse(r)['error']);
    });
    it('rejects a non-bro caller', async () => {
        const db = tempDB();
        const tools = cheatcodeTools(db);
        const r = await call(tools.handlers, 'cheatcode_activate', { agent: 'swe', cheatcode_id: 1 });
        assert.equal(r.isError, true);
        assert.equal(parse(r)['error'], 'forbidden');
    });
});
//# sourceMappingURL=cheatcode.test.js.map