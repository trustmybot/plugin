import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrajectoryDB } from '../db.js';
import { createProjectLogger } from '../logger.js';
import { createClaudeRuntimeContext, createCodexRuntimeContext, deriveCodexRuntimePaths, resolveGraphDbPath, } from '../platform.js';
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'tmb-platform-'));
    const project = join(root, 'project');
    const plugin = join(root, 'installed-plugin');
    mkdirSync(project);
    mkdirSync(plugin);
    return { root, project, plugin };
}
describe('runtime contexts', () => {
    it('keeps Claude cwd semantics distinct from a trusted Codex project root', () => {
        const context = createClaudeRuntimeContext({
            env: {},
            cwd: '/invocation/cwd',
            home: '/user/home',
        });
        assert.equal(context.host, 'claude');
        assert.equal(context.cwd, '/invocation/cwd');
        assert.ok(!('projectRoot' in context));
        assert.equal(context.paths.trajectoryDb, join('/invocation/cwd', '.claude', 'tmb', 'trajectory.db'));
        assert.equal(context.paths.logDir, join('/user/home', '.claude', 'tmb', 'logs'));
    });
    it('resolves Codex state side-effect free from explicit metadata only', () => {
        const { root, project, plugin } = fixture();
        try {
            mkdirSync(join(plugin, '.codex-plugin'));
            writeFileSync(join(plugin, '.codex-plugin', 'plugin.json'), '{ deliberately invalid placeholder json');
            const context = createCodexRuntimeContext({
                projectRoot: project,
                pluginRoot: plugin,
                pluginName: 'tmb',
                pluginVersion: '1.1.0',
            });
            const canonicalProject = realpathSync(project);
            const canonicalPlugin = realpathSync(plugin);
            assert.equal(context.host, 'codex');
            assert.equal(context.projectRoot, canonicalProject);
            assert.deepEqual(context.plugin, {
                root: canonicalPlugin,
                name: 'tmb',
                version: '1.1.0',
            });
            assert.equal(context.paths.stateDir, join(canonicalProject, '.tmb', 'tmb'));
            assert.equal(context.paths.trajectoryDb, join(canonicalProject, '.tmb', 'tmb', 'trajectory.db'));
            assert.equal(context.paths.graphDb, join(canonicalProject, '.tmb', 'tmb', 'world-model.kuzu'));
            assert.equal(context.paths.logDir, join(canonicalProject, '.tmb', 'tmb', 'logs'));
            assert.ok(!existsSync(join(project, '.tmb')));
            assert.ok(!existsSync(join(project, '.claude')));
            assert.ok(Object.isFrozen(context));
            assert.ok(Object.isFrozen(context.plugin));
            assert.ok(Object.isFrozen(context.paths));
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('canonicalizes project-root symlink aliases to one runtime identity', () => {
        const { root, project, plugin } = fixture();
        try {
            const alias = join(root, 'project-alias');
            symlinkSync(project, alias, 'dir');
            const direct = createCodexRuntimeContext({
                projectRoot: project,
                pluginRoot: plugin,
                pluginName: 'tmb',
                pluginVersion: '1.1.0',
            });
            const throughAlias = createCodexRuntimeContext({
                projectRoot: alias,
                pluginRoot: plugin,
                pluginName: 'tmb',
                pluginVersion: '1.1.0',
            });
            assert.equal(throughAlias.projectRoot, direct.projectRoot);
            assert.deepEqual(throughAlias.paths, direct.paths);
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('rejects unsafe plugin path segments', () => {
        const { root, project, plugin } = fixture();
        try {
            for (const pluginName of ['', '.', '..', '../escape', 'a/b', 'a\\b', ' spaced ']) {
                assert.throws(() => createCodexRuntimeContext({
                    projectRoot: project,
                    pluginRoot: plugin,
                    pluginName,
                    pluginVersion: '1.1.0',
                }), /safe, non-empty path segment/);
            }
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('rejects missing, relative, or non-directory roots and empty versions', () => {
        const { root, project, plugin } = fixture();
        try {
            const file = join(root, 'not-a-dir');
            writeFileSync(file, '');
            const base = {
                projectRoot: project,
                pluginRoot: plugin,
                pluginName: 'tmb',
                pluginVersion: '1.1.0',
            };
            assert.throws(() => createCodexRuntimeContext({ ...base, projectRoot: 'relative' }), /absolute path/);
            assert.throws(() => createCodexRuntimeContext({ ...base, projectRoot: join(root, 'missing') }), /existing directory/);
            assert.throws(() => createCodexRuntimeContext({ ...base, pluginRoot: file }), /existing directory/);
            assert.throws(() => createCodexRuntimeContext({ ...base, pluginVersion: '   ' }), /non-empty string/);
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('rejects an existing state symlink that escapes the trusted project root', () => {
        const { root, project, plugin } = fixture();
        try {
            const outside = join(root, 'outside-state');
            mkdirSync(outside);
            symlinkSync(outside, join(project, '.tmb'), 'dir');
            assert.throws(() => createCodexRuntimeContext({
                projectRoot: project,
                pluginRoot: plugin,
                pluginName: 'tmb',
                pluginVersion: '1.1.0',
            }), /escapes the trusted project root/);
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('initializes two Codex DBs only under their respective .tmb state roots', () => {
        const root = mkdtempSync(join(tmpdir(), 'tmb-platform-projects-'));
        try {
            const plugin = join(root, 'plugin');
            const projectA = join(root, 'project-a');
            const projectB = join(root, 'project-b');
            mkdirSync(plugin);
            mkdirSync(projectA);
            mkdirSync(projectB);
            for (const projectRoot of [projectA, projectB]) {
                const context = createCodexRuntimeContext({
                    projectRoot,
                    pluginRoot: plugin,
                    pluginName: 'tmb',
                    pluginVersion: '1.1.0',
                });
                const logger = createProjectLogger({
                    logDir: context.paths.logDir,
                    sqlEnabled: false,
                });
                const db = new TrajectoryDB(context.paths.trajectoryDb, {
                    pluginVersion: context.plugin.version,
                    serverLog: logger.serverLog,
                    sqlLog: logger.sqlLog,
                });
                db.close();
            }
            assert.ok(existsSync(join(projectA, '.tmb', 'tmb', 'trajectory.db')));
            assert.ok(existsSync(join(projectB, '.tmb', 'tmb', 'trajectory.db')));
            assert.ok(!existsSync(join(projectA, '.claude')));
            assert.ok(!existsSync(join(projectB, '.claude')));
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
describe('path derivation', () => {
    it('keeps pure Codex derivation separate from filesystem validation', () => {
        const paths = deriveCodexRuntimePaths({
            projectRoot: '/does/not/need/to/exist',
            pluginName: 'tmb',
        });
        assert.equal(paths.trajectoryDb, join('/does/not/need/to/exist', '.tmb', 'tmb', 'trajectory.db'));
    });
    it('maps graph paths one-to-one without self-collision', () => {
        assert.equal(resolveGraphDbPath(':memory:'), ':memory:');
        assert.equal(resolveGraphDbPath('/project/state/trajectory.db'), '/project/state/world-model.kuzu');
        assert.equal(resolveGraphDbPath('/project/state/custom.db'), '/project/state/custom.db.world-model.kuzu');
        assert.equal(resolveGraphDbPath('/project/state/world-model.kuzu'), '/project/state/world-model.kuzu.world-model.kuzu');
        assert.notEqual(resolveGraphDbPath('/project/state/a.db'), resolveGraphDbPath('/project/state/b.db'));
    });
});
//# sourceMappingURL=platform.test.js.map