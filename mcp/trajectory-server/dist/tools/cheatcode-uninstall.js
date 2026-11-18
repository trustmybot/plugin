// cheatcode_uninstall's engine: reverses one installed cheatcode through the marketplace or mcp CLI (or a fixture) and reports the teardown.
import { alt, CheatcodeInputError, findOnPath, fixturePath, get, isObject, parseJson, readFixture, requireProjectRoot, runCli, } from './cheatcode-runtime.js';
import { installableCandidate } from './cheatcode-install.js';
export const UNINSTALL_FIXTURE_ENV = 'TMB_CHEATCODE_UNINSTALL_FIXTURE';
export const UNINSTALL_FIXTURE_FILE = '.tmb-cheatcode-uninstall-fixture.json';
async function marketplaceUninstall(name, opts) {
    const claude = findOnPath('claude', opts);
    if (claude === null)
        return { removed: false, error: 'marketplace CLI unavailable' };
    if (!name)
        return { removed: false, error: 'no plugin name recorded (faithful identity coupled to #108)' };
    const { code } = await runCli(claude, ['plugin', 'uninstall', name, '--scope', 'project', '--keep-data'], 'none', opts);
    return code === 0 ? { removed: true, error: null } : { removed: false, error: `marketplace uninstall failed (exit ${code})` };
}
async function mcpDeregister(name, opts) {
    const claude = findOnPath('claude', opts);
    if (claude === null)
        return { removed: false, error: 'mcp CLI unavailable' };
    if (!name)
        return { removed: false, error: 'no mcp server name recorded (faithful identity coupled to #108)' };
    const { code } = await runCli(claude, ['mcp', 'remove', name, '--scope', 'project'], 'none', opts);
    return code === 0 ? { removed: true, error: null } : { removed: false, error: `mcp deregister failed (exit ${code})` };
}
export async function cheatcodeUninstall(input, opts) {
    requireProjectRoot(opts.projectRoot);
    const { candidate, name, kind } = installableCandidate(input);
    const fixture = fixturePath(UNINSTALL_FIXTURE_ENV, UNINSTALL_FIXTURE_FILE, opts);
    let result = { removed: false, error: null };
    if (fixture !== null) {
        const parsed = parseJson(readFixture(fixture, opts.projectRoot));
        if (parsed === null || !isObject(parsed.value))
            throw new CheatcodeInputError({ error: 'fixture is not a JSON object' });
        result = { removed: alt(get(parsed.value, 'removed'), false), error: alt(get(parsed.value, 'error'), null) };
    }
    else if (kind === 'plugin')
        result = await marketplaceUninstall(name, opts);
    else if (kind === 'mcp')
        result = await mcpDeregister(name, opts);
    return {
        candidate,
        removed: alt(result.removed, false),
        method: kind === 'plugin' ? 'marketplace' : kind === 'mcp' ? 'mcp-deregister' : 'skill-proposed-pr-revert',
        error: alt(result.error, null),
    };
}
//# sourceMappingURL=cheatcode-uninstall.js.map