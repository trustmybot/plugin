// cheatcodeSearch ranks fixture and stubbed-registry candidates deterministically, with no live network.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CheatcodeInputError } from '../tools/cheatcode-runtime.js';
import { cheatcodeSearch, SEARCH_FIXTURE_FILE } from '../tools/cheatcode-search.js';
import { cleanEnv, stubFetch, tempWorkspace } from './cheatcode-stubs.js';
const ws = tempWorkspace('tmb-cheatcode-search');
const fixture = join(ws.dir, 'candidates.json');
before(() => {
    writeFileSync(fixture, JSON.stringify([
        { name: 'curated-pdf', kind: 'skill', source_url: 'https://x.test/a', description: 'extract pdf table data from documents', registry: 'pulsemcp', tier: 2 },
        { name: 'official-pdf', kind: 'skill', source_url: 'https://x.test/b', description: 'pdf tooling', registry: 'mcp-official', tier: 1 },
        { name: 'kube-tool', kind: 'mcp', source_url: 'https://x.test/c', description: 'manages kubernetes clusters', registry: 'mcp-official', tier: 1 },
    ]));
});
after(() => ws.cleanup());
const fixtureOpts = () => ({ projectRoot: ws.dir, env: cleanEnv({ TMB_CHEATCODE_SEARCH_FIXTURE: fixture }) });
function scoresDescending(out) {
    const scores = out.candidates.map((c) => c.score);
    return scores.every((s, i) => i === 0 || (scores[i - 1] ?? s) >= s);
}
async function rejectsWith(p, payload) {
    await assert.rejects(p, (e) => e instanceof CheatcodeInputError && JSON.stringify(e.payload) === JSON.stringify(payload));
}
describe('cheatcodeSearch over a fixture', () => {
    let out;
    before(async () => {
        out = await cheatcodeSearch({ query: 'pdf table extraction', kind: 'any' }, fixtureOpts());
    });
    it('output round-trips as JSON', () => {
        assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
    });
    it('echoes the query back', () => {
        assert.equal(out.query, 'pdf table extraction');
    });
    it('returns the candidates', () => {
        assert.ok(out.candidates.length >= 2);
    });
    it('ranks by score descending (stable)', () => {
        assert.ok(scoresDescending(out));
    });
    it('ranks official (tier 1) first despite curated being more relevant', () => {
        assert.equal(out.candidates[0]?.name, 'official-pdf');
    });
    it('signals expose registry, tier and relevance (no stars/downloads)', () => {
        assert.deepEqual(Object.keys(out.candidates[0]?.signals ?? {}).sort(), ['registry', 'relevance', 'tier']);
    });
    it('top candidate carries tier 1', () => {
        assert.equal(out.candidates[0]?.signals.tier, 1);
    });
    it('kind filter excludes other kinds', async () => {
        const skill = await cheatcodeSearch({ query: 'pdf', kind: 'skill' }, fixtureOpts());
        assert.equal(skill.candidates.filter((c) => c.kind !== 'skill').length, 0);
    });
    it('is deterministic across runs', async () => {
        assert.deepEqual(await cheatcodeSearch({ query: 'pdf table extraction', kind: 'any' }, fixtureOpts()), out);
    });
    it('rejects a missing query', async () => {
        await rejectsWith(cheatcodeSearch({ query: '', kind: 'any' }, fixtureOpts()), { error: '--query is required' });
    });
    it('rejects an invalid kind', async () => {
        await rejectsWith(cheatcodeSearch({ query: 'pdf', kind: 'widget' }, fixtureOpts()), { error: 'invalid kind: widget' });
    });
    it('rejects a fixture that is not a JSON array', async () => {
        const bad = join(ws.dir, 'object.json');
        writeFileSync(bad, '{"name":"x"}');
        await rejectsWith(cheatcodeSearch({ query: 'pdf' }, { projectRoot: ws.dir, env: cleanEnv({ TMB_CHEATCODE_SEARCH_FIXTURE: bad }) }), { error: 'fixture is not a JSON array of candidates' });
    });
    it('reads the default fixture file in the project root when the env var is unset', async () => {
        const root = tempWorkspace('tmb-cheatcode-search-default');
        try {
            writeFileSync(join(root.dir, SEARCH_FIXTURE_FILE), JSON.stringify([{ name: 'only', kind: 'skill', source_url: 'https://x.test/o', tier: 1 }]));
            const { fetchImpl, requests } = stubFetch(() => null);
            const res = await cheatcodeSearch({ query: 'only' }, { projectRoot: root.dir, env: cleanEnv(), fetchImpl });
            assert.deepEqual(res.candidates.map((c) => c.name), ['only']);
            assert.deepEqual(requests, []);
        }
        finally {
            root.cleanup();
        }
    });
});
const REGISTRY_BODIES = {
    'registry.modelcontextprotocol.io': JSON.stringify({
        servers: [{ server: { name: 'official-pdf', description: 'pdf tooling', repository: { url: 'https://github.com/mcp/official-pdf' } } }],
    }),
    'raw.githubusercontent.com': '{ "plugins": [] }',
    'api.pulsemcp.com': JSON.stringify({
        servers: [{ name: 'curated-pdf', description: 'extract pdf table data from documents', source_code_url: 'https://github.com/curated/curated-pdf' }],
    }),
};
function registryFetch() {
    return stubFetch((url) => REGISTRY_BODIES[new URL(url).host] ?? null);
}
describe('cheatcodeSearch over the stubbed live registries', () => {
    let out;
    let requests;
    before(async () => {
        const stub = registryFetch();
        requests = stub.requests;
        out = await cheatcodeSearch({ query: 'pdf table extraction', kind: 'any' }, { projectRoot: ws.dir, env: cleanEnv(), fetchImpl: stub.fetchImpl });
    });
    it('queries each registry once, with the query URI-encoded', () => {
        assert.deepEqual(requests, [
            'https://registry.modelcontextprotocol.io/v0.1/servers?search=pdf%20table%20extraction&limit=50',
            'https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json',
            'https://api.pulsemcp.com/v0beta/servers?query=pdf%20table%20extraction&count_per_page=50',
        ]);
    });
    it('real adapters yield both registries\' candidates', () => {
        assert.deepEqual(out.candidates.map((c) => c.name).sort(), ['curated-pdf', 'official-pdf']);
    });
    it('tier-1 official ranks first despite tier-2 curated being more relevant', () => {
        assert.equal(out.candidates[0]?.name, 'official-pdf');
    });
    it('ranks by score descending', () => {
        assert.ok(scoresDescending(out));
    });
    it('tiers come from the real adapters (official=1, curated=2)', () => {
        assert.equal(out.candidates.find((c) => c.name === 'official-pdf')?.signals.tier, 1);
        assert.equal(out.candidates.find((c) => c.name === 'curated-pdf')?.signals.tier, 2);
    });
    it('curated (tier 2) has higher relevance than official (tier 1)', () => {
        const rel = (n) => out.candidates.find((c) => c.name === n)?.signals.relevance ?? -1;
        assert.ok(rel('curated-pdf') > rel('official-pdf'));
    });
    it('kind filter (mcp) keeps only mcp-kind candidates', async () => {
        const mcp = await cheatcodeSearch({ query: 'pdf table extraction', kind: 'mcp' }, { projectRoot: ws.dir, env: cleanEnv(), fetchImpl: registryFetch().fetchImpl });
        assert.equal(mcp.candidates.filter((c) => c.kind !== 'mcp').length, 0);
    });
    describe('anthropic marketplace source resolution (GH 2135)', () => {
        const PLUGINS = [
            { name: 'rel-plugin', description: 'pdf review', source: './plugins/pr-review-toolkit' },
            { name: 'abs-plugin', description: 'pdf review', source: 'https://github.com/someorg/abs-plugin' },
            { name: 'obj-plugin', description: 'pdf review', source: { source: 'url', url: 'https://github.com/someorg/obj-plugin.git' } },
            { name: 'up-plugin', description: 'pdf review', source: './plugins/../../escape', homepage: 'https://x.test/up' },
            { name: 'root-plugin', description: 'pdf review', source: '/etc/plugins/root' },
        ];
        let urls;
        before(async () => {
            const body = JSON.stringify({ plugins: PLUGINS });
            const { fetchImpl } = stubFetch((url) => (new URL(url).host === 'raw.githubusercontent.com' ? body : null));
            const res = await cheatcodeSearch({ query: 'pdf', kind: 'plugin' }, { projectRoot: ws.dir, env: cleanEnv(), fetchImpl });
            urls = Object.fromEntries(res.candidates.map((c) => [c.name, c.source_url]));
        });
        it('GH 2135: a ./plugins/<name> source resolves to the marketplace repo tree URL', () => {
            assert.equal(urls['rel-plugin'], 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/pr-review-toolkit');
        });
        it('GH 2135: an absolute URL source passes through unchanged', () => {
            assert.equal(urls['abs-plugin'], 'https://github.com/someorg/abs-plugin');
        });
        it('GH 2135: an object {url} source passes through unchanged', () => {
            assert.equal(urls['obj-plugin'], 'https://github.com/someorg/obj-plugin.git');
        });
        it('GH 2135: a source with a .. segment falls back to homepage', () => {
            assert.equal(urls['up-plugin'], 'https://x.test/up');
        });
        it('GH 2135: a leading-/ source without a homepage is not resolved and yields no candidate', () => {
            assert.ok(!('root-plugin' in urls));
            assert.ok(!Object.values(urls).some((u) => u.includes('/etc/plugins')));
        });
    });
    it('a failing or malformed registry yields no candidates instead of an error', async () => {
        const { fetchImpl } = stubFetch((url) => (url.includes('pulsemcp') ? 'not json' : null));
        const res = await cheatcodeSearch({ query: 'pdf' }, { projectRoot: ws.dir, env: cleanEnv(), fetchImpl });
        assert.deepEqual(res, { query: 'pdf', kind: 'any', candidates: [] });
    });
});
//# sourceMappingURL=cheatcode-search.test.js.map