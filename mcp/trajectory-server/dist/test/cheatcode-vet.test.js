// cheatcodeVet classifies a candidate's trust tier deterministically over fixtures and a stubbed GitHub REST API.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CheatcodeInputError } from '../tools/cheatcode-runtime.js';
import { cheatcodeVet } from '../tools/cheatcode-vet.js';
import { cleanEnv, githubDirFetch, tempWorkspace } from './cheatcode-stubs.js';
const ws = tempWorkspace('tmb-cheatcode-vet');
const gh = join(ws.dir, 'gh');
after(() => ws.cleanup());
const OFFICIAL_REPO = {
    stargazers_count: 1200,
    forks_count: 80,
    pushed_at: '2026-05-01T00:00:00Z',
    archived: false,
    license: { spdx_id: 'MIT' },
    owner: { login: 'anthropics', type: 'Organization' },
};
const OFFICIAL = { repo: OFFICIAL_REPO, contents: ['README.md', 'LICENSE'] };
const EXEC = {
    repo: {
        stargazers_count: 9000,
        forks_count: 800,
        pushed_at: '2026-06-01T00:00:00Z',
        archived: false,
        license: { spdx_id: 'Apache-2.0' },
        owner: { login: 'someorg', type: 'Organization' },
    },
    contents: ['README.md', 'hooks', 'scripts'],
};
const ARCHIVED = {
    repo: {
        stargazers_count: 50,
        forks_count: 2,
        pushed_at: '2022-01-01T00:00:00Z',
        archived: true,
        license: { spdx_id: 'MIT' },
        owner: { login: 'x', type: 'User' },
    },
};
const CAND_OFFICIAL = '{"name":"official-pdf","kind":"skill","source_url":"https://github.com/anthropics/pdf","tier":1}';
const CAND_EXEC = '{"name":"hooky","kind":"skill","source_url":"https://github.com/someorg/hooky"}';
const CAND_ARCHIVED = '{"name":"old","kind":"skill","source_url":"https://github.com/x/old","tier":2}';
const CAND_EMPTY = '{"name":"mystery","kind":"skill","source_url":"https://gitlab.com/x/y"}';
let fixtureSeq = 0;
function writeFixture(body) {
    const f = join(ws.dir, `fixture-${fixtureSeq++}.json`);
    writeFileSync(f, JSON.stringify(body));
    return f;
}
function vetFixture(body, input) {
    return cheatcodeVet(input, { projectRoot: ws.dir, env: cleanEnv({ TMB_CHEATCODE_VET_FIXTURE: writeFixture(body) }) });
}
async function vetLive(candidate) {
    const { fetchImpl, requests } = githubDirFetch(gh);
    const out = await cheatcodeVet({ candidate: JSON.stringify(candidate) }, { projectRoot: ws.dir, env: cleanEnv(), fetchImpl });
    return { out, requests };
}
function stubGh(file, body) {
    writeFileSync(join(gh, file), typeof body === 'string' ? body : JSON.stringify(body));
}
function base64Body(json, wrap = 0) {
    const b64 = Buffer.from(json).toString('base64');
    const content = wrap > 0 ? (b64.match(new RegExp(`.{1,${wrap}}`, 'g')) ?? []).join('\n') : b64;
    return { type: 'file', encoding: 'base64', content };
}
function assertWhy(out, fragment) {
    assert.equal(out.trust_tier, 'caution');
    assert.ok(out.rationale.includes(fragment), `rationale: ${out.rationale}`);
}
const assertUnlisted = (out) => assertWhy(out, 'could not be inspected');
const assertPartial = (out) => assertWhy(out, 'nested folders not inspected');
const assertOpaque = (out) => assertWhy(out, 'submodule or symlink not inspected');
const PUSHED_FRESH = new Date(Date.now() - 30 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const popularRepo = (login, stars = 4000, extra = {}) => ({
    stargazers_count: stars,
    forks_count: 300,
    pushed_at: PUSHED_FRESH,
    archived: false,
    license: { spdx_id: 'MIT' },
    owner: { login, type: 'Organization' },
    ...extra,
});
before(() => {
    mkdirSync(gh, { recursive: true });
    stubGh('anthropics_live-pdf.repo.json', popularRepo('anthropics', 2500, { forks_count: 120 }));
    stubGh('anthropics_live-pdf.contents.json', [
        { name: 'README.md', type: 'file', download_url: 'https://raw.example/README.md' },
        { name: 'LICENSE', type: 'file', download_url: 'https://raw.example/LICENSE' },
    ]);
    stubGh('someorg_live-thin.repo.json', popularRepo('someorg', 3, { forks_count: 0, license: null }));
    stubGh('someorg_live-thin.contents.json', [{ name: 'README.md' }, { name: 'hooks' }]);
    stubGh('someorg_mono.repo.json', popularRepo('someorg'));
    stubGh('someorg_mono.contents.json', [
        { name: '.claude-plugin', type: 'dir' },
        { name: 'hooks', type: 'dir' },
        { name: 'skills', type: 'dir' },
        { name: 'README.md', type: 'file', download_url: 'https://raw.example/README.md' },
    ]);
    stubGh('someorg_mono.trees.json', {
        sha: 'abc',
        truncated: false,
        tree: [
            { path: '.claude-plugin', mode: '040000', type: 'tree' },
            { path: '.claude-plugin/plugin.json', mode: '100644', type: 'blob' },
            { path: 'hooks', mode: '040000', type: 'tree' },
            { path: 'hooks/hooks.json', mode: '100644', type: 'blob' },
            { path: 'skills', mode: '040000', type: 'tree' },
            { path: 'skills/plain', mode: '040000', type: 'tree' },
            { path: 'skills/plain/SKILL.md', mode: '100644', type: 'blob' },
            { path: 'skills/plain/reference.md', mode: '100644', type: 'blob' },
            { path: 'skills/plain-extra', mode: '040000', type: 'tree' },
            { path: 'skills/plain-extra/hooks/hooks.json', mode: '100644', type: 'blob' },
            { path: 'skills/tooly', mode: '040000', type: 'tree' },
            { path: 'skills/tooly/SKILL.md', mode: '100644', type: 'blob' },
            { path: 'skills/tooly/scripts', mode: '040000', type: 'tree' },
            { path: 'skills/tooly/scripts/run', mode: '100755', type: 'blob' },
        ],
    });
    stubGh('someorg_huge.repo.json', popularRepo('someorg'));
    stubGh('someorg_huge.trees.json', { sha: 'abc', truncated: true, tree: [{ path: 'skills/mcpish/SKILL.md', mode: '100644', type: 'blob' }] });
    stubGh('someorg_huge.contents.skills_mcpish.json', [
        { name: 'SKILL.md', type: 'file', download_url: 'https://raw.example/SKILL.md' },
        { name: '.mcp.json', type: 'file', download_url: 'https://raw.example/.mcp.json' },
    ]);
    stubGh('someorg_huge.contents.skills_withlib.json', [
        { name: 'SKILL.md', type: 'file', download_url: 'https://raw.example/SKILL.md' },
        { name: 'lib', type: 'dir' },
    ]);
    stubGh('someorg_huge.contents.skills_symlinky.json', [
        { name: 'SKILL.md', type: 'file', download_url: 'https://raw.example/SKILL.md' },
        { name: 'lib', type: 'symlink', download_url: 'https://raw.example/lib' },
    ]);
    stubGh('someorg_huge.contents.skills_subby.json', [
        { name: 'SKILL.md', type: 'file', download_url: 'https://raw.example/SKILL.md' },
        { name: 'vendor', type: 'file', download_url: null },
    ]);
    copyFileSync(join(gh, 'anthropics_live-pdf.repo.json'), join(gh, 'anthropics_nolist.repo.json'));
    copyFileSync(join(gh, 'anthropics_live-pdf.repo.json'), join(gh, 'anthropics_emptylist.repo.json'));
    stubGh('anthropics_emptylist.contents.json', '[]');
    stubGh('someorg_nested.repo.json', popularRepo('someorg'));
    stubGh('someorg_nested.contents.json', [
        { name: '.claude-plugin', type: 'dir' },
        { name: 'skills', type: 'dir' },
        { name: 'README.md', type: 'file', download_url: 'https://raw.example/README.md' },
    ]);
    stubGh('someorg_nested.trees.json', { sha: 'abc', truncated: false, tree: [{ path: 'skills/x/scripts/run.py', mode: '100644', type: 'blob' }] });
    stubGh('someorg_shallowcode.contents.json', [
        { name: 'hooks', type: 'dir' },
        { name: 'skills', type: 'dir' },
    ]);
    copyFileSync(join(gh, 'someorg_nested.repo.json'), join(gh, 'someorg_shallowcode.repo.json'));
    copyFileSync(join(gh, 'someorg_mono.repo.json'), join(gh, 'someorg_plug.repo.json'));
    stubGh('someorg_plug.trees.json', {
        sha: 'abc',
        truncated: false,
        tree: [
            { path: 'skills/sub/SKILL.md', mode: '100644', type: 'blob' },
            { path: 'skills/sub/vendor', mode: '160000', type: 'commit' },
            { path: 'skills/link/SKILL.md', mode: '100644', type: 'blob' },
            { path: 'skills/link/lib', mode: '120000', type: 'blob' },
            { path: 'plugins/hooky/README.md', mode: '100644', type: 'blob' },
            { path: 'plugins/hooky/.claude-plugin/plugin.json', mode: '100644', type: 'blob' },
            { path: 'plugins/mcpy/.claude-plugin/plugin.json', mode: '100644', type: 'blob' },
            { path: 'plugins/clean/.claude-plugin/plugin.json', mode: '100644', type: 'blob' },
            { path: 'plugins/clean/skills/c/SKILL.md', mode: '100644', type: 'blob' },
            { path: 'plugins/broken/.claude-plugin/plugin.json', mode: '100644', type: 'blob' },
            { path: 'plugins/market/.claude-plugin/marketplace.json', mode: '100644', type: 'blob' },
        ],
    });
    const plugManifest = (folder, file, json) => stubGh(`someorg_plug.contents.${folder.replace(/\//g, '_')}_.claude-plugin_${file}.json`, base64Body(json, 60));
    plugManifest('plugins/hooky', 'plugin.json', '{"name":"hooky","hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"./x"}]}]}}');
    plugManifest('plugins/mcpy', 'plugin.json', '{"name":"mcpy","mcpServers":{"srv":{"command":"node","args":["s.js"]}}}');
    plugManifest('plugins/clean', 'plugin.json', '{"name":"clean","description":"skills only"}');
    plugManifest('plugins/market', 'marketplace.json', '{"name":"m","plugins":[{"name":"p","source":"./p","mcpServers":{"s":{"url":"https://x"}}}]}');
    copyFileSync(join(gh, 'someorg_mono.repo.json'), join(gh, 'someorg_nestman.repo.json'));
    stubGh('someorg_nestman.trees.json', {
        sha: 'abc',
        truncated: false,
        tree: [{ path: 'pack/plugins/x/.claude-plugin/plugin.json', mode: '100644', type: 'blob' }],
    });
    stubGh('someorg_nestman.contents.pack_plugins_x_.claude-plugin_plugin.json.json', base64Body('{"name":"x","hooks":{"Stop":[]}}'));
    copyFileSync(join(gh, 'someorg_mono.repo.json'), join(gh, 'someorg_casey.repo.json'));
    stubGh('someorg_casey.trees.json', {
        sha: 'abc',
        truncated: false,
        tree: [
            { path: 'pack/SKILL.md', mode: '100644', type: 'blob' },
            { path: 'pack/.CLAUDE-PLUGIN/Plugin.json', mode: '100644', type: 'blob' },
        ],
    });
    stubGh('someorg_casey.contents.pack_.CLAUDE-PLUGIN_Plugin.json.json', base64Body('{"name":"x","hooks":{"Stop":[]}}'));
    copyFileSync(join(gh, 'someorg_mono.repo.json'), join(gh, 'someorg_odd.repo.json'));
    stubGh('someorg_odd.trees.json', {
        sha: 'abc',
        truncated: false,
        tree: [
            { path: 'pack/a#b/.claude-plugin/plugin.json', mode: '100644', type: 'blob' },
            { path: 'pack/c%2e/.claude-plugin/plugin.json', mode: '100644', type: 'blob' },
            { path: 'pack/d e/.claude-plugin/plugin.json', mode: '100644', type: 'blob' },
        ],
    });
});
describe('cheatcodeVet over fixtures', () => {
    let out;
    let outExec;
    before(async () => {
        out = await vetFixture(OFFICIAL, { candidate: CAND_OFFICIAL });
        outExec = await vetFixture(EXEC, { candidate: CAND_EXEC });
    });
    it('output round-trips as JSON', () => {
        assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
    });
    it('JSON shape: candidate + signals + trust_tier + rationale + capabilities', () => {
        assert.deepEqual(Object.keys(out).sort(), ['candidate', 'capabilities', 'rationale', 'signals', 'trust_tier']);
    });
    it('signals expose reputation/maintenance/license/maintainer/security_surface', () => {
        assert.deepEqual(Object.keys(out.signals).sort(), ['license', 'maintainer', 'maintenance', 'reputation', 'security_surface']);
    });
    it('official tier-1, no exec surface -> trusted', () => {
        assert.equal(out.trust_tier, 'trusted');
    });
    it('carries reputation signals through (tier + stars)', () => {
        assert.equal(`${out.signals.reputation.registry_tier}/${String(out.signals.reputation.stars)}`, '1/1200');
    });
    it('ships hooks/scripts -> code_execution capability', () => {
        assert.equal(outExec.signals.security_surface.code_execution, true);
    });
    it('a code-executing candidate is never trusted on popularity', () => {
        assert.notEqual(outExec.trust_tier, 'trusted');
    });
    it('code_execution appears in capabilities[]', () => {
        assert.ok(outExec.capabilities.includes('code_execution'));
    });
    it('archived repo -> untrusted', async () => {
        assert.equal((await vetFixture(ARCHIVED, { candidate: CAND_ARCHIVED })).trust_tier, 'untrusted');
    });
    it('empty/failed signal set -> unknown (never crashes)', async () => {
        assert.equal((await vetFixture({}, { candidate: CAND_EMPTY })).trust_tier, 'unknown');
    });
    it('discrete flags input form works', async () => {
        const flags = await vetFixture(OFFICIAL, { sourceUrl: 'https://github.com/anthropics/pdf', kind: 'skill', tier: '1', name: 'flagform' });
        assert.equal(flags.trust_tier, 'trusted');
    });
    it('is deterministic across runs', async () => {
        assert.deepEqual(await vetFixture(OFFICIAL, { candidate: CAND_OFFICIAL }), out);
    });
    it('rejects a missing source URL and candidate', async () => {
        await assert.rejects(vetFixture(OFFICIAL, { kind: 'skill' }), CheatcodeInputError);
    });
});
describe('cheatcodeVet over the stubbed GitHub REST API', () => {
    let hi;
    before(async () => {
        hi = await vetLive({ name: 'live-pdf', kind: 'skill', source_url: 'https://github.com/anthropics/live-pdf' });
    });
    it('high-signal repo -> trusted (stars-driven, no registry tier)', () => {
        assert.equal(hi.out.trust_tier, 'trusted');
    });
    it('carries the real fetched reputation (stars from the stubbed repo JSON)', () => {
        assert.equal(hi.out.signals.reputation.stars, 2500);
    });
    it('thin repo shipping hooks -> caution (exec surface)', async () => {
        const { out } = await vetLive({ name: 'live-thin', kind: 'skill', source_url: 'https://github.com/someorg/live-thin' });
        assert.equal(out.trust_tier, 'caution');
        assert.equal(out.signals.security_surface.code_execution, true);
    });
    it('non-github source (no stub hit) -> unknown (honesty, never crashes)', async () => {
        const { out, requests } = await vetLive({ name: 'mystery', kind: 'skill', source_url: 'https://gitlab.com/x/y' });
        assert.equal(out.trust_tier, 'unknown');
        assert.deepEqual(requests, []);
    });
    it('a bare repo URL lists the repo root via contents, never git/trees (GH 1617)', () => {
        assert.ok(new Set(hi.requests).has('https://api.github.com/repos/anthropics/live-pdf/contents'));
        assert.ok(!hi.requests.some((u) => u.includes('repos/anthropics/live-pdf/git/trees')));
    });
});
describe('cheatcodeVet on folder URLs (GH 1617)', () => {
    let plain;
    let tooly;
    before(async () => {
        plain = await vetLive({ name: 'plain', kind: 'plugin', source_url: 'https://github.com/someorg/mono/tree/main/skills/plain' });
        tooly = (await vetLive({ name: 'tooly', kind: 'plugin', source_url: 'https://github.com/someorg/mono/tree/main/skills/tooly/' })).out;
    });
    it('a /tree/<ref>/<path> URL requests git/trees/<ref>?recursive=1', () => {
        assert.ok(new Set(plain.requests).has('https://api.github.com/repos/someorg/mono/git/trees/main?recursive=1'));
    });
    it('two folders of one repo get different capability sets', () => {
        assert.notDeepEqual(plain.out.capabilities, tooly.capabilities);
    });
    it('a SKILL.md-only folder has no code_execution despite repo-root hooks/.claude-plugin', () => {
        assert.equal(plain.out.signals.security_surface.code_execution, false);
        assert.deepEqual(plain.out.capabilities, []);
        assert.equal(plain.out.trust_tier, 'trusted');
    });
    it('a folder shipping an executable script -> code_execution + fs_writes, caution', () => {
        assert.deepEqual(tooly.capabilities, ['code_execution', 'fs_writes']);
        assert.equal(tooly.trust_tier, 'caution');
    });
    it('repo-level reputation stays repo-level', () => {
        assert.equal(`${String(plain.out.signals.reputation.stars)}/${String(plain.out.signals.maintainer.login)}`, '4000/someorg');
    });
    let huge;
    it('a truncated tree falls back to contents/<path>?ref=<ref> for that folder', async () => {
        huge = await vetLive({ name: 'mcpish', kind: 'skill', source_url: 'https://github.com/someorg/huge/tree/v2/skills/mcpish' });
        assert.ok(new Set(huge.requests).has('https://api.github.com/repos/someorg/huge/contents/skills/mcpish?ref=v2'));
    });
    it('an MCP server definition flags code_execution + network but not fs_writes', () => {
        assert.deepEqual(huge.out.capabilities, ['code_execution', 'network']);
    });
    it('.claude-plugin alone (kind=plugin) no longer sets code_execution', async () => {
        const out = await vetFixture({ repo: OFFICIAL_REPO, contents: ['.claude-plugin', 'commands', 'README.md'] }, { sourceUrl: 'https://github.com/anthropics/po', kind: 'plugin', tier: '1' });
        assert.equal(out.signals.security_surface.code_execution, false);
        assert.equal(out.trust_tier, 'trusted');
    });
});
describe('cheatcodeVet never trusts a surface it did not list', () => {
    it('offline tier-1 plugin (no repo, no listing) -> caution', async () => {
        assertUnlisted((await vetLive({ name: 'offline', kind: 'plugin', source_url: 'https://github.com/nowhere/offline', tier: 1 })).out);
    });
    it('slash-containing ref in a popular repo (path matches no tree entry, contents 404) -> caution', async () => {
        assertUnlisted((await vetLive({ name: 'slash', kind: 'skill', source_url: 'https://github.com/someorg/mono/tree/feature/x/skills/plain' })).out);
    });
    it('404 folder in a popular repo (git/trees + contents both fail) -> caution', async () => {
        assertUnlisted((await vetLive({ name: 'gone', kind: 'skill', source_url: 'https://github.com/anthropics/live-pdf/tree/main/skills/gone' })).out);
    });
    it('bare popular repo URL whose contents call fails -> caution', async () => {
        assertUnlisted((await vetLive({ name: 'nolist', kind: 'skill', source_url: 'https://github.com/anthropics/nolist' })).out);
    });
    it('fixture with no tree/contents array (tier 1) -> caution', async () => {
        assertUnlisted(await vetFixture({ repo: OFFICIAL_REPO }, { candidate: CAND_OFFICIAL }));
    });
    it('empty [] contents result (bare URL) -> caution', async () => {
        assertUnlisted((await vetLive({ name: 'emptylist', kind: 'skill', source_url: 'https://github.com/anthropics/emptylist', tier: 1 })).out);
    });
    it('fixture with an empty [] contents array (tier 1) -> caution', async () => {
        assertUnlisted(await vetFixture({ ...OFFICIAL, contents: [] }, { candidate: CAND_OFFICIAL }));
    });
    it('bare kind=plugin repo with code nested at skills/x/scripts/run.py -> caution, no git/trees request', async () => {
        const { out, requests } = await vetLive({ name: 'nested', kind: 'plugin', source_url: 'https://github.com/someorg/nested', tier: 1 });
        assertPartial(out);
        assert.ok(!requests.some((u) => u.includes('repos/someorg/nested/git/trees')));
    });
    it('code in a shallow listing still wins over the partial-surface reason', async () => {
        const { out } = await vetLive({ name: 'shallowcode', kind: 'plugin', source_url: 'https://github.com/someorg/shallowcode' });
        assert.equal(out.trust_tier, 'caution');
        assert.deepEqual(out.capabilities, ['code_execution', 'fs_writes']);
        assert.ok(out.rationale.startsWith('Ships executable surface'), out.rationale);
    });
    it('truncated tree whose folder holds a plain subfolder -> caution (nested folders not inspected)', async () => {
        const { out } = await vetLive({ name: 'withlib', kind: 'skill', source_url: 'https://github.com/someorg/huge/tree/v2/skills/withlib' });
        assertPartial(out);
        assert.deepEqual(out.capabilities, []);
    });
});
const vetPlug = async (name, folder) => vetLive({ name, kind: 'plugin', source_url: `https://github.com/someorg/plug/tree/main/${folder}` });
describe('cheatcodeVet on submodules, symlinks and plugin manifests', () => {
    it('(A) a git/trees submodule entry (type commit, mode 160000) -> caution', async () => {
        assertOpaque((await vetPlug('sub', 'skills/sub')).out);
    });
    it('(B) a git/trees symlink entry (mode 120000) -> caution', async () => {
        assertOpaque((await vetPlug('link', 'skills/link')).out);
    });
    it('(D) a contents/ symlink entry -> caution', async () => {
        assertOpaque((await vetLive({ name: 'symlinky', kind: 'skill', source_url: 'https://github.com/someorg/huge/tree/v2/skills/symlinky' })).out);
    });
    it('(D) a contents/ submodule (type file, null download_url) -> caution', async () => {
        const { out } = await vetLive({ name: 'subby', kind: 'skill', source_url: 'https://github.com/someorg/huge/tree/v2/skills/subby' });
        assertOpaque(out);
        assert.deepEqual(out.capabilities, []);
    });
    it('(G) plugin.json declaring hooks -> code_execution, fetched from the folder at the ref', async () => {
        const { out, requests } = await vetPlug('hooky', 'plugins/hooky');
        assert.deepEqual(out.capabilities, ['code_execution']);
        assert.equal(out.trust_tier, 'caution');
        assert.ok(new Set(requests).has('https://api.github.com/repos/someorg/plug/contents/plugins/hooky/.claude-plugin/plugin.json?ref=main'));
    });
    it('(G) plugin.json declaring mcpServers -> code_execution + network', async () => {
        assert.deepEqual((await vetPlug('mcpy', 'plugins/mcpy')).out.capabilities, ['code_execution', 'network']);
    });
    it('(G) marketplace.json with a plugin declaring mcpServers -> code_execution + network', async () => {
        assert.deepEqual((await vetPlug('market', 'plugins/market')).out.capabilities, ['code_execution', 'network']);
    });
    it('(G) a manifest with neither key leaves the folder trusted', async () => {
        const { out } = await vetPlug('clean', 'plugins/clean');
        assert.deepEqual(out.capabilities, []);
        assert.equal(out.trust_tier, 'trusted');
    });
    it('(G) a manifest that cannot be fetched -> caution', async () => {
        assertWhy((await vetPlug('broken', 'plugins/broken')).out, 'plugin manifest could not be read');
    });
    it('(G) fixture path: a listed manifest is read from .manifests', async () => {
        const tree = [{ path: 'p/.claude-plugin/plugin.json', mode: '100644', type: 'blob' }];
        const input = { sourceUrl: 'https://github.com/anthropics/po/tree/main/p', kind: 'plugin', tier: '1' };
        const withManifest = await vetFixture({ repo: OFFICIAL_REPO, tree, manifests: { '.claude-plugin/plugin.json': { hooks: './hooks.json' } } }, input);
        assert.deepEqual(withManifest.capabilities, ['code_execution']);
        assert.equal((await vetFixture({ repo: OFFICIAL_REPO, tree }, input)).trust_tier, 'caution');
    });
});
function vetTree(paths, manifests = {}) {
    return vetFixture({ repo: OFFICIAL_REPO, tree: paths.map((p) => ({ path: `p/${p}`, mode: '100644', type: 'blob' })), manifests }, { sourceUrl: 'https://github.com/anthropics/po/tree/main/p', kind: 'plugin', tier: '1' });
}
const MKT = '.claude-plugin/marketplace.json';
const NESTED = 'plugins/x/.claude-plugin/plugin.json';
const PJ = '.claude-plugin/plugin.json';
const market = (plugins) => ({ [MKT]: { name: 'm', plugins } });
describe('cheatcodeVet over a fixture tree', () => {
    it('(baseline) a folder with a clean manifest and SKILL.md is trusted', async () => {
        assert.equal((await vetTree([PJ, 'skills/s/SKILL.md'], { [PJ]: { name: 'p' } })).trust_tier, 'trusted');
    });
    it('(G1) marketplace plugin with a github object source -> caution (external plugin source)', async () => {
        assertWhy(await vetTree([MKT], market([{ name: 'a', source: { source: 'github', repo: 'o/r' } }])), 'external plugin source not inspected');
    });
    it('(G1) marketplace plugin with a url object source -> caution (external plugin source)', async () => {
        assertWhy(await vetTree([MKT], market([{ name: 'a', source: { source: 'url', url: 'https://example.com/r.git' } }])), 'external plugin source not inspected');
    });
    it('(G1) marketplace plugin with a URL string source -> caution (external plugin source)', async () => {
        assertWhy(await vetTree([MKT], market([{ name: 'a', source: 'https://github.com/o/r' }])), 'external plugin source not inspected');
    });
    it('(G1) a ./ source that climbs out of the folder (..) -> caution', async () => {
        assertWhy(await vetTree([MKT], market([{ name: 'a', source: './../elsewhere' }])), 'plugin source outside the folder not inspected');
    });
    it('(G1) a ./ source inside the folder stays trusted', async () => {
        assert.equal((await vetTree([MKT, 'plugins/a/SKILL.md'], market([{ name: 'a', source: './plugins/a' }]))).trust_tier, 'trusted');
    });
    it('(G2) a nested plugins/x/.claude-plugin/plugin.json with inline hooks -> code_execution', async () => {
        assert.deepEqual((await vetTree([NESTED], { [NESTED]: { name: 'x', hooks: { Stop: [] } } })).capabilities, ['code_execution']);
    });
    it('(G2) a nested manifest keyed by its repo path in the fixture is read too', async () => {
        assert.deepEqual((await vetTree([NESTED], { [`p/${NESTED}`]: { name: 'x', hooks: { Stop: [] } } })).capabilities, ['code_execution']);
    });
    it('(G2) more manifests than the cap -> caution (the rest not inspected)', async () => {
        const paths = Array.from({ length: 21 }, (_, i) => `plugins/p${i}/.claude-plugin/plugin.json`);
        assertWhy(await vetTree(paths, Object.fromEntries(paths.map((p) => [p, { name: 'clean' }]))), 'more than 20 plugin manifests');
    });
    it('(G2) live path: a nested manifest is fetched from contents/<folder>/<path>?ref=<ref>', async () => {
        const { out, requests } = await vetLive({ name: 'pack', kind: 'plugin', source_url: 'https://github.com/someorg/nestman/tree/main/pack' });
        assert.deepEqual(out.capabilities, ['code_execution']);
        assert.ok(new Set(requests).has('https://api.github.com/repos/someorg/nestman/contents/pack/plugins/x/.claude-plugin/plugin.json?ref=main'));
    });
    it('(G3) plugin.json declaring lspServers -> code_execution', async () => {
        assert.deepEqual((await vetTree([PJ], { [PJ]: { name: 'l', lspServers: { go: { command: 'gopls' } } } })).capabilities, ['code_execution']);
    });
    it('(G3) plugin.json declaring top-level monitors -> code_execution', async () => {
        assert.deepEqual((await vetTree([PJ], { [PJ]: { name: 'm', monitors: './mon.json' } })).capabilities, ['code_execution']);
    });
    it('(G3) plugin.json declaring experimental.monitors -> code_execution', async () => {
        assert.deepEqual((await vetTree([PJ], { [PJ]: { name: 'm', experimental: { monitors: [] } } })).capabilities, ['code_execution']);
    });
    it("(G3) a nested manifest's mcpServers .mcpb URL -> code_execution + network", async () => {
        const out = await vetTree([NESTED], { [NESTED]: { name: 'x', mcpServers: ['https://example.com/srv.mcpb'] } });
        assert.deepEqual(out.capabilities, ['code_execution', 'network']);
    });
    it('(G3) a .lsp.json file -> code_execution', async () => {
        assert.equal((await vetTree(['.lsp.json', 'README.md'])).signals.security_surface.code_execution, true);
    });
    it('(G3) a monitors/monitors.json file -> code_execution', async () => {
        assert.equal((await vetTree(['monitors/monitors.json'])).signals.security_surface.code_execution, true);
    });
    it('(G3) an extensionless, non-executable-mode bin/tool -> code_execution', async () => {
        assert.equal((await vetTree(['bin/tool'])).signals.security_surface.code_execution, true);
    });
    it("(G3) a nested plugin's bin/ file -> code_execution", async () => {
        assert.equal((await vetTree(['plugins/x/bin/tool'])).signals.security_surface.code_execution, true);
    });
    it('(K/L) fixture contents objects map name to path, keeping their markers', async () => {
        const out = await vetFixture({
            ...OFFICIAL,
            contents: [
                { name: 'SKILL.md', type: 'file', download_url: 'https://raw.example/SKILL.md' },
                { name: 'run.sh', type: 'file', download_url: 'https://raw.example/run.sh' },
            ],
        }, { candidate: CAND_OFFICIAL });
        assert.deepEqual(out.capabilities, ['code_execution', 'fs_writes']);
        assert.equal(out.trust_tier, 'caution');
    });
    it('(S) a plugin-root settings.json -> code_execution + fs_writes', async () => {
        const out = await vetTree([PJ, 'settings.json', 'SKILL.md'], { [PJ]: { name: 'p' } });
        assert.deepEqual(out.capabilities, ['code_execution', 'fs_writes']);
        assert.equal(out.trust_tier, 'caution');
    });
    it('(S) a settings.json matched in any case (Settings.JSON) -> code_execution + fs_writes', async () => {
        assert.deepEqual((await vetTree(['Settings.JSON', 'SKILL.md'])).capabilities, ['code_execution', 'fs_writes']);
    });
    it('(S) plugin.json settings.subagentStatusLine command -> code_execution', async () => {
        const out = await vetTree([PJ], { [PJ]: { name: 'p', settings: { subagentStatusLine: { type: 'command', command: 'curl e | sh' } } } });
        assert.deepEqual(out.capabilities, ['code_execution']);
        assert.equal(out.trust_tier, 'caution');
    });
    it('(S) a marketplace plugins[] entry declaring subagentStatusLine -> code_execution', async () => {
        const out = await vetTree([MKT], market([{ name: 'a', source: './a', subagentStatusLine: { type: 'command', command: 'x' } }]));
        assert.deepEqual(out.capabilities, ['code_execution']);
    });
    it('(D) plugin.json with non-empty dependencies -> caution (external dependencies)', async () => {
        const out = await vetTree([PJ, 'SKILL.md'], { [PJ]: { name: 'p', dependencies: ['evil-hooks', { name: 'v', version: '^1' }] } });
        assertWhy(out, 'external dependencies not inspected');
        assert.deepEqual(out.capabilities, []);
    });
    it('(D) a marketplace plugins[] entry with dependencies -> caution (external dependencies)', async () => {
        const out = await vetTree([MKT, 'plugins/a/SKILL.md'], market([{ name: 'a', source: './plugins/a', dependencies: ['b@other'] }]));
        assertWhy(out, 'external dependencies not inspected');
    });
    it('(D) an empty dependencies list leaves the folder trusted', async () => {
        assert.equal((await vetTree([PJ, 'SKILL.md'], { [PJ]: { name: 'p', dependencies: [] } })).trust_tier, 'trusted');
    });
    it('(C) an upper-case .CLAUDE-PLUGIN/Plugin.json is a manifest (unread -> caution)', async () => {
        assertWhy(await vetTree(['.CLAUDE-PLUGIN/Plugin.json', 'SKILL.md']), 'plugin manifest could not be read');
    });
    it('(C) live path: an upper-case manifest is fetched at its exact listed path and read', async () => {
        const { out, requests } = await vetLive({ name: 'pack', kind: 'plugin', source_url: 'https://github.com/someorg/casey/tree/main/pack' });
        assert.deepEqual(out.capabilities, ['code_execution']);
        assert.ok(new Set(requests).has('https://api.github.com/repos/someorg/casey/contents/pack/.CLAUDE-PLUGIN/Plugin.json?ref=main'));
    });
    it('(U) fixture: a manifest path with ? is never read -> caution (unusual path)', async () => {
        const odd = 'x?y/.claude-plugin/plugin.json';
        assertWhy(await vetTree([odd], { [odd]: { name: 'x' } }), 'plugin manifest with an unusual path not inspected');
    });
    it('(U) live path: manifest paths with #, % or a space are never fetched -> caution', async () => {
        const { out, requests } = await vetLive({ name: 'pack', kind: 'plugin', source_url: 'https://github.com/someorg/odd/tree/main/pack' });
        assertWhy(out, 'plugin manifest with an unusual path not inspected');
        assert.ok(!requests.some((u) => u.includes('repos/someorg/odd/contents')));
    });
    it('(.) a marketplace plugin whose source is "." (the root) stays trusted', async () => {
        assert.equal((await vetTree([MKT, 'SKILL.md'], market([{ name: 'x', source: '.' }]))).trust_tier, 'trusted');
    });
});
//# sourceMappingURL=cheatcode-vet.test.js.map