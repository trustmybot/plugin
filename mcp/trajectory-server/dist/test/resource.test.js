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
const FIXTURE = JSON.stringify([
    {
        name: 'pdf-extractor',
        kind: 'skill',
        source_url: 'https://example.test/pdf-extractor',
        description: 'extract tables from pdf documents',
        stars: 5000,
        downloads: 4000,
    },
    {
        name: 'doc-reader',
        kind: 'skill',
        source_url: 'https://example.test/doc-reader',
        description: 'read pdf files',
        stars: 10,
        downloads: 0,
    },
    {
        name: 'unrelated-thing',
        kind: 'mcp',
        source_url: 'https://example.test/unrelated',
        description: 'manages kubernetes clusters',
        stars: 1,
        downloads: 0,
    },
]);
describe('resource_search', () => {
    function withFixture() {
        const dir = mkdtempSync(join(tmpdir(), 'tmb-resource-'));
        const path = join(dir, 'candidates.json');
        writeFileSync(path, FIXTURE);
        return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    }
    it('returns candidates ranked by score descending', async () => {
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
            // The high-relevance, high-reputation candidate ranks first.
            assert.equal(candidates[0].name, 'pdf-extractor');
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