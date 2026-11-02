// cheatcodeUninstall assembles the teardown payload from a fixture or a claude CLI shim (GH 676, GH 1533), soft-degrading on failure.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CheatcodeInputError } from '../tools/cheatcode-runtime.js';
import { cheatcodeUninstall, UNINSTALL_FIXTURE_FILE } from '../tools/cheatcode-uninstall.js';
import { claudeShim, cleanEnv, tempWorkspace } from './cheatcode-stubs.js';
const ws = tempWorkspace('tmb-cheatcode-uninstall');
const project = join(ws.dir, 'project');
const probeDir = join(ws.dir, 'probe');
const nofixDir = join(ws.dir, 'nofix');
const fixture = join(ws.dir, 'uninstall.json');
const failFixture = join(ws.dir, 'uninstall-fail.json');
const winsFixture = join(ws.dir, 'wins.json');
let shim;
before(() => {
    for (const d of [project, probeDir, nofixDir])
        mkdirSync(d, { recursive: true });
    writeFileSync(fixture, '{ "removed": true, "error": null }');
    writeFileSync(failFixture, '{ "removed": false, "error": "marketplace uninstall failed (exit 1)" }');
    writeFileSync(winsFixture, '{ "removed": false, "error": "stub-not-removed" }');
    writeFileSync(join(probeDir, UNINSTALL_FIXTURE_FILE), '{ "removed": true, "error": null }');
    shim = claudeShim(ws.dir);
});
after(() => ws.cleanup());
const PDF_PLUGIN = '{"name":"pdf-plugin","kind":"plugin","source_url":"https://x.test/pdf"}';
const PDF_MCP = '{"name":"pdf-mcp","kind":"mcp","source_url":"https://x.test/pdf-mcp"}';
const PDF_SKILL = '{"name":"pdf-skill","kind":"skill","source_url":"https://x.test/pdf-skill"}';
function withFixture(path, input, projectRoot = project) {
    return cheatcodeUninstall(input, { projectRoot, env: cleanEnv({ TMB_CHEATCODE_UNINSTALL_FIXTURE: path }) });
}
function noFixture(input, projectRoot = project) {
    return cheatcodeUninstall(input, { projectRoot, env: cleanEnv({ PATH: '/usr/bin:/bin' }) });
}
function live(input) {
    shim.reset();
    return cheatcodeUninstall(input, { projectRoot: project, env: shim.env });
}
async function inputError(p) {
    try {
        await p;
    }
    catch (e) {
        if (e instanceof CheatcodeInputError)
            return e.payload;
        throw e;
    }
    assert.fail('expected a CheatcodeInputError');
}
describe('cheatcodeUninstall over a fixture', () => {
    let out;
    before(async () => {
        out = await withFixture(fixture, { candidate: '{"name":"pdf-plugin","kind":"plugin","source_url":"https://x.test/pdf","tier":1}' });
    });
    it('output round-trips as JSON', () => {
        assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
    });
    it('plugin kind is reversed via the marketplace method', () => {
        assert.equal(out.method, 'marketplace');
    });
    it('plugin uninstall reports removed=true', () => {
        assert.equal(out.removed, true);
    });
    it('plugin uninstall has no error', () => {
        assert.equal(out.error, null);
    });
    it('echoes the candidate source_url', () => {
        assert.equal(out.candidate.source_url, 'https://x.test/pdf');
    });
    it('echoes the normalized candidate', () => {
        assert.deepEqual(out.candidate, { name: 'pdf-plugin', kind: 'plugin', source_url: 'https://x.test/pdf', tier: 1 });
    });
    it('mcp kind is reversed via the mcp-deregister method', async () => {
        assert.equal((await withFixture(fixture, { candidate: PDF_MCP })).method, 'mcp-deregister');
    });
    it('a failed marketplace uninstall degrades soft (removed=false + error)', async () => {
        const res = await withFixture(failFixture, { candidate: PDF_PLUGIN });
        assert.equal(res.removed, false);
        assert.match(String(res.error), /failed/);
    });
});
describe('cheatcodeUninstall input checks', () => {
    it('an invalid kind fails', async () => {
        const err = await inputError(noFixture({ candidate: '{"name":"x","kind":"bad","source_url":"https://x"}' }));
        assert.equal(err.error, "candidate.kind must be skill|mcp|plugin (got 'bad')");
    });
    it('a missing source_url fails', async () => {
        const err = await inputError(noFixture({ candidate: '{"name":"x","kind":"plugin"}' }));
        assert.equal(err.error, 'candidate.source_url is required');
    });
    it('an unset project root fails with a clear message', async () => {
        const err = await inputError(withFixture(fixture, { candidate: PDF_PLUGIN }, ''));
        assert.match(String(err.error), /TMB_PROJECT_ROOT is unset/);
    });
    it('a missing fixture file fails', async () => {
        const err = await inputError(withFixture(join(ws.dir, 'absent.json'), { candidate: PDF_PLUGIN }));
        assert.equal(err.error, `fixture not found: ${join(ws.dir, 'absent.json')}`);
    });
    it('a fixture that is not a JSON object fails', async () => {
        const arr = join(ws.dir, 'array.json');
        writeFileSync(arr, '[]');
        const err = await inputError(withFixture(arr, { candidate: PDF_PLUGIN }));
        assert.equal(err.error, 'fixture is not a JSON object');
    });
});
describe('cheatcodeUninstall fixture resolution', () => {
    it('env unset + default fixture file in the project -> fixture used', async () => {
        const res = await noFixture({ candidate: '{"name":"feature-dev","kind":"plugin","source_url":"https://x.test/feature-dev"}' }, probeDir);
        assert.equal(res.removed, true);
        assert.equal(res.method, 'marketplace');
    });
    it('a default fixture in the server cwd (not the project) is ignored', async () => {
        const cwd = process.cwd();
        process.chdir(probeDir);
        try {
            assert.equal((await noFixture({ candidate: PDF_SKILL }, nofixDir)).removed, false);
        }
        finally {
            process.chdir(cwd);
        }
    });
    it('an env-set fixture wins over the default file in the project', async () => {
        const res = await withFixture(winsFixture, { candidate: '{"name":"feature-dev","kind":"plugin","source_url":"https://x.test/feature-dev"}' }, probeDir);
        assert.equal(res.removed, false);
        assert.equal(res.error, 'stub-not-removed');
    });
    it('no env + no default file -> no-fixture path unchanged (not removed)', async () => {
        const res = await noFixture({ candidate: PDF_SKILL }, nofixDir);
        assert.equal(res.removed, false);
        assert.equal(res.method, 'skill-proposed-pr-revert');
    });
});
describe('cheatcodeUninstall of a skill with no fixture', () => {
    let skill;
    before(async () => {
        skill = await noFixture({ candidate: PDF_SKILL }, nofixDir);
    });
    it('uses the skill-proposed-pr-revert method', () => {
        assert.equal(skill.method, 'skill-proposed-pr-revert');
    });
    it('reverses nothing at the marketplace', () => {
        assert.equal(skill.removed, false);
    });
});
describe('cheatcodeUninstall through the claude CLI shim', () => {
    let plugin;
    let pluginCalls;
    let pluginCwds;
    before(async () => {
        plugin = await live({ candidate: PDF_PLUGIN });
        pluginCalls = shim.calls();
        pluginCwds = shim.cwds();
    });
    it('plugin kind: claude plugin uninstall runs with --scope project --keep-data', () => {
        assert.equal(plugin.removed, true);
        assert.deepEqual(pluginCalls, ['plugin uninstall pdf-plugin --scope project --keep-data']);
    });
    it('plugin kind: the claude call runs in the project root', () => {
        assert.deepEqual(pluginCwds, [realpathSync(project)]);
    });
    it('mcp kind: claude mcp remove runs with --scope project', async () => {
        const res = await live({ candidate: PDF_MCP });
        assert.equal(res.removed, true);
        assert.deepEqual(shim.calls(), ['mcp remove pdf-mcp --scope project']);
    });
    it('mcp kind: the claude call runs in the project root', () => {
        assert.deepEqual(shim.cwds(), [realpathSync(project)]);
    });
    it('a candidate with no recorded name degrades soft with no claude call', async () => {
        const plugin = await live({ candidate: '{"kind":"plugin","source_url":"https://x.test/anon"}' });
        assert.deepEqual({ removed: plugin.removed, error: plugin.error }, { removed: false, error: 'no plugin name recorded (faithful identity coupled to #108)' });
        const mcp = await live({ candidate: '{"kind":"mcp","source_url":"https://x.test/anon"}' });
        assert.deepEqual({ removed: mcp.removed, error: mcp.error }, { removed: false, error: 'no mcp server name recorded (faithful identity coupled to #108)' });
        assert.deepEqual(shim.calls(), []);
    });
    it('a failing claude call degrades soft with the exit code', async () => {
        const failing = claudeShim(join(ws.dir, 'failing'), 'exit 3');
        const res = await cheatcodeUninstall({ candidate: PDF_PLUGIN }, { projectRoot: project, env: failing.env });
        assert.deepEqual({ removed: res.removed, error: res.error }, { removed: false, error: 'marketplace uninstall failed (exit 3)' });
    });
    it('no claude on PATH degrades soft per kind', async () => {
        assert.equal((await noFixture({ candidate: PDF_PLUGIN })).error, 'marketplace CLI unavailable');
        assert.equal((await noFixture({ candidate: PDF_MCP })).error, 'mcp CLI unavailable');
    });
});
//# sourceMappingURL=cheatcode-uninstall.test.js.map