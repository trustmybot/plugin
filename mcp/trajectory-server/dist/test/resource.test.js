import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDB } from './helpers.js';
import { resourceTools } from '../tools/resource.js';
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
describe('resource_search', () => {
    function withFixture() {
        const dir = mkdtempSync(join(tmpdir(), 'tmb-resource-'));
        const path = join(dir, 'candidates.json');
        writeFileSync(path, FIXTURE);
        return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    }
    it('ranks official (tier 1) above curated (tier 2) even when curated is more relevant', async () => {
        const db = tempDB();
        const { path, cleanup } = withFixture();
        process.env['TMB_RESOURCE_SEARCH_FIXTURE'] = path;
        try {
            const tools = resourceTools(db);
            const r = await call(tools.handlers, 'resource_search', {
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
            delete process.env['TMB_RESOURCE_SEARCH_FIXTURE'];
            cleanup();
        }
    });
    it('filters candidates by kind', async () => {
        const db = tempDB();
        const { path, cleanup } = withFixture();
        process.env['TMB_RESOURCE_SEARCH_FIXTURE'] = path;
        try {
            const tools = resourceTools(db);
            const r = await call(tools.handlers, 'resource_search', {
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
            delete process.env['TMB_RESOURCE_SEARCH_FIXTURE'];
            cleanup();
        }
    });
    it('writes a resource_search audit row', async () => {
        const db = tempDB();
        const { path, cleanup } = withFixture();
        process.env['TMB_RESOURCE_SEARCH_FIXTURE'] = path;
        try {
            const tools = resourceTools(db);
            await call(tools.handlers, 'resource_search', {
                agent: 'bro',
                capability_query: 'pdf table extraction',
            });
            const row = db.get(`SELECT event_type, content_json FROM audit WHERE event_type = 'resource_search' ORDER BY id DESC LIMIT 1`);
            assert.ok(row, 'resource_search audit row exists');
            const content = JSON.parse(row.content_json);
            assert.equal(content.query, 'pdf table extraction');
            assert.ok(typeof content.candidate_count === 'number');
        }
        finally {
            delete process.env['TMB_RESOURCE_SEARCH_FIXTURE'];
            cleanup();
        }
    });
    it('rejects a non-bro caller', async () => {
        const db = tempDB();
        const tools = resourceTools(db);
        const r = await call(tools.handlers, 'resource_search', {
            agent: 'swe',
            capability_query: 'pdf',
        });
        assert.equal(r.isError, true);
        const out = parse(r);
        assert.equal(out['error'], 'forbidden');
    });
});
//# sourceMappingURL=resource.test.js.map