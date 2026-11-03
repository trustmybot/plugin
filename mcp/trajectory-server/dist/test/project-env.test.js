import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { resolvePluginName } from '../hooks/lib/project-env.js';
describe('project-env resolvePluginName', () => {
    let top;
    before(() => {
        top = mkdtempSync(join(tmpdir(), 'tmb-project-env-'));
    });
    after(() => {
        rmSync(top, { recursive: true, force: true });
    });
    function pluginRoot(dir, manifest) {
        const root = join(top, dir);
        mkdirSync(root);
        if (manifest !== undefined) {
            mkdirSync(join(root, '.claude-plugin'));
            writeFileSync(join(root, '.claude-plugin', 'plugin.json'), manifest);
        }
        return root;
    }
    it('returns the manifest name tmb', () => {
        const root = pluginRoot('stable', '{"name":"tmb","version":"0.6.0"}');
        assert.equal(resolvePluginName({ CLAUDE_PLUGIN_ROOT: root }), 'tmb');
    });
    it('returns the manifest name tmb-rc', () => {
        const root = pluginRoot('rc', '{"name":"tmb-rc","version":"0.6.0-rc.7"}');
        assert.equal(resolvePluginName({ CLAUDE_PLUGIN_ROOT: root }), 'tmb-rc');
    });
    it('falls back to tmb when CLAUDE_PLUGIN_ROOT is unset', () => {
        assert.equal(resolvePluginName({}), 'tmb');
    });
    it('falls back to tmb when CLAUDE_PLUGIN_ROOT has no manifest', () => {
        assert.equal(resolvePluginName({ CLAUDE_PLUGIN_ROOT: pluginRoot('empty') }), 'tmb');
    });
    it('falls back to tmb when the manifest has no name field', () => {
        const root = pluginRoot('noname', '{"version":"1.0.0"}');
        assert.equal(resolvePluginName({ CLAUDE_PLUGIN_ROOT: root }), 'tmb');
    });
});
//# sourceMappingURL=project-env.test.js.map