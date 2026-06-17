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
//# sourceMappingURL=cheatcode.test.js.map