import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, chmodSync, linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import { TrajectoryDB } from '../db.js';
import { GraphHolder } from '../graph-db.js';
import { readCodexPackageMetadata } from '../codex-package.js';
import { CodexRuntimeError, CodexRuntimeManager, } from '../codex-runtime.js';
import { CODEX_SCOPE_3_TOOL_NAMES, createCodexToolRegistry, } from '../codex-tools.js';
import { registerTools, toolDefinitions, toolHandlers, } from '../tools/index.js';
const cleanup = [];
afterEach(() => {
    for (const path of cleanup.splice(0)) {
        rmSync(path, { recursive: true, force: true });
    }
});
function gitProject(options = {}) {
    const root = mkdtempSync(join(tmpdir(), 'tmb-codex-runtime-'));
    cleanup.push(root);
    execFileSync('git', ['init', '--quiet', root]);
    if (options.ignoreState !== false) {
        writeFileSync(join(root, '.gitignore'), '.tmb/\n');
    }
    return root;
}
function manager(capacity = 4, now) {
    return new CodexRuntimeManager({
        plugin: readCodexPackageMetadata(import.meta.url),
        capacity,
        ...(now ? { now } : {}),
    });
}
async function expectRuntimeError(promise, code) {
    await assert.rejects(promise, (error) => error instanceof CodexRuntimeError && error.code === code);
}
function queryPluginVersion(path) {
    const db = new DatabaseSync(path);
    try {
        const row = db
            .prepare('SELECT plugin_version FROM plugin_meta WHERE id = 1')
            .get();
        return row.plugin_version;
    }
    finally {
        db.close();
    }
}
function writeIsolationMarker(path, marker) {
    const db = new DatabaseSync(path);
    try {
        db.exec('CREATE TABLE IF NOT EXISTS codex_isolation_test (marker TEXT NOT NULL)');
        db.prepare('INSERT INTO codex_isolation_test(marker) VALUES (?)').run(marker);
    }
    finally {
        db.close();
    }
}
function readIsolationMarkers(path) {
    const db = new DatabaseSync(path);
    try {
        return db.prepare('SELECT marker FROM codex_isolation_test ORDER BY marker').all().map((row) => row.marker);
    }
    finally {
        db.close();
    }
}
function toolPayload(result) {
    const content = result.content[0];
    assert.equal(content?.type, 'text');
    if (!content || content.type !== 'text') {
        throw new Error('Expected text MCP content');
    }
    return JSON.parse(content.text);
}
describe('Codex runtime manager', () => {
    it('creates and then reuses one project-bound SQLite runtime', async () => {
        const project = gitProject();
        const runtimeManager = manager();
        try {
            const created = await runtimeManager.initialize(project);
            const reused = await runtimeManager.initialize(project);
            const plugin = readCodexPackageMetadata(import.meta.url);
            assert.equal(created.status, 'created');
            assert.equal(reused.status, 'reused');
            assert.equal(created.project_root, realpathSync(project));
            assert.equal(created.plugin_name, plugin.name);
            assert.equal(created.plugin_version, plugin.version);
            assert.equal(created.schema_version, 28);
            assert.equal(created.graph_available, true);
            assert.equal(created.graph_status, 'deferred');
            assert.ok(existsSync(created.trajectory_db));
            assert.equal(queryPluginVersion(created.trajectory_db), plugin.version);
            assert.ok(created.state_dir.startsWith(join(realpathSync(project), '.tmb')));
            assert.equal(existsSync(join(project, '.claude')), false);
        }
        finally {
            runtimeManager.close();
        }
    });
    it('single-flights concurrent initialization for the same project', async () => {
        const project = gitProject();
        const runtimeManager = manager();
        try {
            const [first, second] = await Promise.all([
                runtimeManager.initialize(project),
                runtimeManager.initialize(project),
            ]);
            assert.deepEqual(first, second);
            assert.equal(first.status, 'created');
        }
        finally {
            runtimeManager.close();
        }
    });
    it('single-flights concurrent canonical and symlink-alias inputs at capacity one', async () => {
        const project = gitProject();
        const aliasRoot = mkdtempSync(join(tmpdir(), 'tmb-codex-alias-parent-'));
        cleanup.push(aliasRoot);
        const alias = join(aliasRoot, 'project-alias');
        symlinkSync(project, alias);
        const runtimeManager = manager(1);
        try {
            const [canonical, throughAlias] = await Promise.all([
                runtimeManager.initialize(project),
                runtimeManager.initialize(alias),
            ]);
            assert.deepEqual(canonical, throughAlias);
            assert.equal(canonical.status, 'created');
        }
        finally {
            runtimeManager.close();
        }
    });
    it('reuses one runtime for canonical and symlink-alias project roots', async () => {
        const project = gitProject();
        const aliasRoot = mkdtempSync(join(tmpdir(), 'tmb-codex-alias-parent-'));
        cleanup.push(aliasRoot);
        const alias = join(aliasRoot, 'project-alias');
        symlinkSync(project, alias);
        const runtimeManager = manager();
        try {
            const created = await runtimeManager.initialize(alias);
            const reused = await runtimeManager.initialize(project);
            assert.equal(created.status, 'created');
            assert.equal(reused.status, 'reused');
            assert.equal(created.project_root, realpathSync(project));
            assert.equal(created.trajectory_db, reused.trajectory_db);
        }
        finally {
            runtimeManager.close();
        }
    });
    it('supports linked Git worktrees whose .git entry is a file', async () => {
        const primary = gitProject();
        execFileSync('git', ['-C', primary, 'config', 'user.email', 'test@example.com']);
        execFileSync('git', ['-C', primary, 'config', 'user.name', 'Codex Test']);
        execFileSync('git', ['-C', primary, 'add', '.gitignore']);
        execFileSync('git', ['-C', primary, 'commit', '--quiet', '-m', 'fixture']);
        const linkedParent = mkdtempSync(join(tmpdir(), 'tmb-codex-linked-parent-'));
        cleanup.push(linkedParent);
        const linked = join(linkedParent, 'linked');
        execFileSync('git', ['-C', primary, 'worktree', 'add', '--quiet', linked]);
        const runtimeManager = manager();
        try {
            const result = await runtimeManager.initialize(linked);
            assert.equal(result.project_root, realpathSync(linked));
            assert.ok(existsSync(result.trajectory_db));
        }
        finally {
            runtimeManager.close();
        }
    });
    it('keeps alternating projects isolated', async () => {
        const firstProject = gitProject();
        const secondProject = gitProject();
        const runtimeManager = manager(1);
        try {
            const first = await runtimeManager.initialize(firstProject);
            writeIsolationMarker(first.trajectory_db, 'first-project');
            const second = await runtimeManager.initialize(secondProject);
            writeIsolationMarker(second.trajectory_db, 'second-project');
            const reopened = await runtimeManager.initialize(firstProject);
            assert.notEqual(first.trajectory_db, second.trajectory_db);
            assert.notEqual(first.graph_db, second.graph_db);
            assert.notEqual(first.log_dir, second.log_dir);
            assert.equal(reopened.status, 'created');
            assert.equal(queryPluginVersion(first.trajectory_db), first.plugin_version);
            assert.equal(queryPluginVersion(second.trajectory_db), second.plugin_version);
            assert.deepEqual(readIsolationMarkers(first.trajectory_db), ['first-project']);
            assert.deepEqual(readIsolationMarkers(second.trajectory_db), ['second-project']);
        }
        finally {
            runtimeManager.close();
        }
    });
    it('evicts the least-recently used runtime with tied wall-clock timestamps', async () => {
        const firstProject = gitProject();
        const secondProject = gitProject();
        const thirdProject = gitProject();
        const runtimeManager = manager(2, () => 0);
        try {
            await runtimeManager.initialize(firstProject);
            await runtimeManager.initialize(secondProject);
            assert.equal((await runtimeManager.initialize(firstProject)).status, 'reused');
            await runtimeManager.initialize(thirdProject);
            assert.equal((await runtimeManager.initialize(firstProject)).status, 'reused');
            assert.equal((await runtimeManager.initialize(secondProject)).status, 'created');
        }
        finally {
            runtimeManager.close();
        }
    });
    it('never evicts an active runtime and exposes capacity exhaustion', async () => {
        const firstProject = gitProject();
        const secondProject = gitProject();
        const runtimeManager = manager(1);
        let releaseLease;
        let markLeaseStarted;
        const leaseStarted = new Promise((resolve) => {
            markLeaseStarted = resolve;
        });
        const holdLease = new Promise((resolve) => {
            releaseLease = resolve;
        });
        try {
            await runtimeManager.initialize(firstProject);
            const activeCall = runtimeManager.withRuntime(firstProject, async () => {
                markLeaseStarted();
                await holdLease;
            });
            await leaseStarted;
            await expectRuntimeError(runtimeManager.initialize(secondProject), 'runtime_capacity_exceeded');
            assert.equal(existsSync(join(secondProject, '.tmb')), false);
            assert.equal((await runtimeManager.initialize(firstProject)).status, 'reused');
            releaseLease();
            await activeCall;
            assert.equal((await runtimeManager.initialize(secondProject)).status, 'created');
        }
        finally {
            releaseLease();
            runtimeManager.close();
        }
    });
    it('closes evicted and shutdown resources exactly once', async () => {
        const firstProject = gitProject();
        const secondProject = gitProject();
        const originalClose = TrajectoryDB.prototype.close;
        let closeCount = 0;
        TrajectoryDB.prototype.close = function closeWithCount() {
            closeCount += 1;
            originalClose.call(this);
        };
        const runtimeManager = manager(1);
        try {
            await runtimeManager.initialize(firstProject);
            await runtimeManager.initialize(secondProject);
            runtimeManager.close();
            runtimeManager.close();
            assert.equal(closeCount, 2);
        }
        finally {
            TrajectoryDB.prototype.close = originalClose;
            runtimeManager.close();
        }
    });
    it('attempts to close every runtime when one close reports an error', async () => {
        const firstProject = gitProject();
        const secondProject = gitProject();
        const originalClose = TrajectoryDB.prototype.close;
        let closeCount = 0;
        TrajectoryDB.prototype.close = function closeWithOneFailure() {
            closeCount += 1;
            originalClose.call(this);
            if (closeCount === 1)
                throw new Error('injected close failure');
        };
        const runtimeManager = manager(2);
        try {
            await runtimeManager.initialize(firstProject);
            await runtimeManager.initialize(secondProject);
            assert.throws(() => runtimeManager.close(), /injected close failure/);
            assert.equal(closeCount, 2);
            runtimeManager.close();
            assert.equal(closeCount, 2);
        }
        finally {
            TrajectoryDB.prototype.close = originalClose;
            try {
                runtimeManager.close();
            }
            catch {
                // The assertion above verifies the injected failure.
            }
        }
    });
    it('returns every stable project_root validation code before writes', async () => {
        const project = gitProject();
        const nested = join(project, 'nested');
        mkdirSync(nested);
        const nonGit = mkdtempSync(join(tmpdir(), 'tmb-codex-nongit-'));
        cleanup.push(nonGit);
        const missing = join(nonGit, 'missing');
        const file = join(nonGit, 'file');
        writeFileSync(file, 'not a directory');
        const unignored = gitProject({ ignoreState: false });
        const runtimeManager = manager();
        try {
            await expectRuntimeError(runtimeManager.initialize(undefined), 'missing_project_root');
            await expectRuntimeError(runtimeManager.initialize('relative'), 'project_root_not_absolute');
            await expectRuntimeError(runtimeManager.initialize(missing), 'project_root_not_found');
            await expectRuntimeError(runtimeManager.initialize(file), 'project_root_not_directory');
            await expectRuntimeError(runtimeManager.initialize(nonGit), 'project_root_not_git_toplevel');
            await expectRuntimeError(runtimeManager.initialize(nested), 'project_root_not_git_toplevel');
            await expectRuntimeError(runtimeManager.initialize(unignored), 'project_state_not_ignored');
            assert.equal(existsSync(join(project, '.tmb')), false);
            assert.equal(existsSync(join(nonGit, '.tmb')), false);
            assert.equal(existsSync(join(unignored, '.tmb')), false);
        }
        finally {
            runtimeManager.close();
        }
    });
    it('rejects ignored state that already contains Git-tracked files', async () => {
        const project = gitProject();
        const tracked = join(project, '.tmb', 'tmb', 'trajectory.db');
        mkdirSync(dirname(tracked), { recursive: true });
        writeFileSync(tracked, 'tracked state must never be adopted');
        execFileSync('git', ['-C', project, 'add', '--force', tracked]);
        const runtimeManager = manager();
        try {
            await expectRuntimeError(runtimeManager.initialize(project), 'project_state_not_ignored');
            assert.equal(readFileSync(tracked, 'utf8'), 'tracked state must never be adopted');
        }
        finally {
            runtimeManager.close();
        }
    });
    it('scrubs Git repository override variables before validation', async () => {
        const project = gitProject({ ignoreState: false });
        const poison = gitProject();
        const priorGitDir = process.env['GIT_DIR'];
        const priorGitWorkTree = process.env['GIT_WORK_TREE'];
        process.env['GIT_DIR'] = join(poison, '.git');
        process.env['GIT_WORK_TREE'] = project;
        const runtimeManager = manager();
        try {
            await expectRuntimeError(runtimeManager.initialize(project), 'project_state_not_ignored');
            assert.equal(existsSync(join(project, '.tmb')), false);
        }
        finally {
            if (priorGitDir === undefined)
                delete process.env['GIT_DIR'];
            else
                process.env['GIT_DIR'] = priorGitDir;
            if (priorGitWorkTree === undefined)
                delete process.env['GIT_WORK_TREE'];
            else
                process.env['GIT_WORK_TREE'] = priorGitWorkTree;
            runtimeManager.close();
        }
    });
    it('disables repository-local Git fsmonitor execution during validation', async () => {
        const project = gitProject();
        const marker = join(project, 'fsmonitor-executed');
        const hook = join(project, 'malicious-fsmonitor.sh');
        writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`);
        chmodSync(hook, 0o755);
        execFileSync('git', ['-C', project, 'config', 'core.fsmonitor', hook]);
        const runtimeManager = manager();
        try {
            const result = await runtimeManager.initialize(project);
            assert.equal(result.status, 'created');
            assert.equal(existsSync(marker), false);
        }
        finally {
            runtimeManager.close();
        }
    });
    it('fails closed on unsafe state replacement and remains retryable', async () => {
        const project = gitProject();
        const outside = mkdtempSync(join(tmpdir(), 'tmb-codex-outside-'));
        cleanup.push(outside);
        mkdirSync(join(project, '.tmb'));
        const stateLink = join(project, '.tmb', 'tmb');
        symlinkSync(outside, stateLink);
        const runtimeManager = manager();
        try {
            await expectRuntimeError(runtimeManager.initialize(project), 'unsafe_project_state_path');
            unlinkSync(stateLink);
            const retried = await runtimeManager.initialize(project);
            assert.equal(retried.status, 'created');
            assert.ok(existsSync(retried.trajectory_db));
        }
        finally {
            runtimeManager.close();
        }
    });
    it('rejects hard-linked writable state without modifying the outside inode', async () => {
        const project = gitProject();
        const outsideRoot = mkdtempSync(join(tmpdir(), 'tmb-codex-hardlink-'));
        cleanup.push(outsideRoot);
        const outside = join(outsideRoot, 'outside.db');
        const trajectoryDb = join(project, '.tmb', 'tmb', 'trajectory.db');
        writeFileSync(outside, 'outside inode must remain untouched');
        mkdirSync(dirname(trajectoryDb), { recursive: true });
        linkSync(outside, trajectoryDb);
        const runtimeManager = manager();
        try {
            await expectRuntimeError(runtimeManager.initialize(project), 'unsafe_project_state_path');
            assert.equal(readFileSync(outside, 'utf8'), 'outside inode must remain untouched');
        }
        finally {
            runtimeManager.close();
        }
    });
    it('rejects a FIFO trajectory leaf before SQLite can open it', async () => {
        const project = gitProject();
        const trajectoryDb = join(project, '.tmb', 'tmb', 'trajectory.db');
        mkdirSync(dirname(trajectoryDb), { recursive: true });
        execFileSync('mkfifo', [trajectoryDb]);
        const runtimeManager = manager();
        try {
            await expectRuntimeError(runtimeManager.initialize(project), 'unsafe_project_state_path');
        }
        finally {
            runtimeManager.close();
        }
    });
    it('rejects a non-directory Codex log path instead of silently disabling logs', async () => {
        const project = gitProject();
        const logDir = join(project, '.tmb', 'tmb', 'logs');
        mkdirSync(dirname(logDir), { recursive: true });
        writeFileSync(logDir, 'not a directory');
        const runtimeManager = manager();
        try {
            await expectRuntimeError(runtimeManager.initialize(project), 'unsafe_project_state_path');
            assert.equal(readFileSync(logDir, 'utf8'), 'not a directory');
            assert.equal(existsSync(join(project, '.tmb', 'tmb', 'trajectory.db')), false);
        }
        finally {
            runtimeManager.close();
        }
    });
    it('rejects hard-linked Codex log files before runtime initialization', async () => {
        const project = gitProject();
        const outsideRoot = mkdtempSync(join(tmpdir(), 'tmb-codex-log-hardlink-'));
        cleanup.push(outsideRoot);
        const outside = join(outsideRoot, 'outside.log');
        const logFile = join(project, '.tmb', 'tmb', 'logs', 'mcp-server.log');
        writeFileSync(outside, 'outside log must remain untouched');
        mkdirSync(dirname(logFile), { recursive: true });
        linkSync(outside, logFile);
        const runtimeManager = manager();
        try {
            await expectRuntimeError(runtimeManager.initialize(project), 'unsafe_project_state_path');
            assert.equal(readFileSync(outside, 'utf8'), 'outside log must remain untouched');
            assert.equal(existsSync(join(project, '.tmb', 'tmb', 'trajectory.db')), false);
        }
        finally {
            runtimeManager.close();
        }
    });
    it('cleans failed candidates and retries after a database open failure', async () => {
        const project = gitProject();
        const dbPath = join(project, '.tmb', 'tmb', 'trajectory.db');
        mkdirSync(dirname(dbPath), { recursive: true });
        writeFileSync(dbPath, 'not a SQLite database');
        const runtimeManager = manager();
        try {
            await expectRuntimeError(runtimeManager.initialize(project), 'runtime_initialization_failed');
            rmSync(dbPath, { recursive: true, force: true });
            const retried = await runtimeManager.initialize(project);
            assert.equal(retried.status, 'created');
            assert.ok(existsSync(retried.trajectory_db));
        }
        finally {
            runtimeManager.close();
        }
    });
});
describe('Codex tool surface', () => {
    it('exposes exactly the frozen Scope-3 allowlist through a deeply immutable registry', () => {
        const runtimeManager = manager();
        try {
            const registry = createCodexToolRegistry(runtimeManager);
            assert.deepEqual(registry.definitions.map((tool) => tool.name), CODEX_SCOPE_3_TOOL_NAMES);
            assert.ok(Object.isFrozen(registry));
            assert.ok(Object.isFrozen(registry.definitions));
            assert.ok(Object.isFrozen(registry.definitions[0]));
            assert.ok(Object.isFrozen(registry.definitions[0].inputSchema));
            assert.ok(Object.isFrozen(registry.definitions[0].inputSchema.properties));
            assert.ok(Object.isFrozen(registry.handlers));
            for (const definition of registry.definitions) {
                const properties = definition.inputSchema.properties;
                assert.equal(definition.inputSchema.additionalProperties, false);
                assert.ok('project_root' in properties);
                for (const identity of ['agent', 'author', 'verified_human', 'role', 'provenance']) {
                    assert.equal(identity in properties, false);
                }
            }
        }
        finally {
            runtimeManager.close();
        }
    });
    it('keeps independent Codex registries from mutating the Claude registry', () => {
        const claudeDb = new TrajectoryDB(':memory:', {
            pluginVersion: null,
            serverLog: () => { },
            sqlLog: () => { },
        });
        registerTools({}, claudeDb, ':memory:', GraphHolder.fixed(null));
        const claudeDefinitionsBefore = JSON.stringify(toolDefinitions);
        const claudeHandlerNamesBefore = Object.keys(toolHandlers);
        const firstManager = manager();
        const secondManager = manager();
        try {
            const firstRegistry = createCodexToolRegistry(firstManager);
            const secondRegistry = createCodexToolRegistry(secondManager);
            assert.notEqual(firstRegistry, secondRegistry);
            assert.notEqual(firstRegistry.handlers, secondRegistry.handlers);
            assert.equal(JSON.stringify(toolDefinitions), claudeDefinitionsBefore);
            assert.deepEqual(Object.keys(toolHandlers), claudeHandlerNamesBefore);
            assert.deepEqual(Object.keys(firstRegistry.handlers), CODEX_SCOPE_3_TOOL_NAMES);
            assert.deepEqual(Object.keys(secondRegistry.handlers), CODEX_SCOPE_3_TOOL_NAMES);
        }
        finally {
            firstManager.close();
            secondManager.close();
            claudeDb.close();
        }
    });
    it('returns stable MCP error payloads for missing input and unknown tools', async () => {
        const runtimeManager = manager();
        try {
            const registry = createCodexToolRegistry(runtimeManager);
            const missing = await registry.call('runtime_initialize', {});
            const unknown = await registry.call('claude_workflow_tool', {});
            const missingContent = missing.content[0];
            const unknownContent = unknown.content[0];
            assert.equal(missingContent.type, 'text');
            assert.equal(unknownContent.type, 'text');
            if (missingContent.type !== 'text' || unknownContent.type !== 'text') {
                throw new Error('Expected text MCP content');
            }
            assert.equal(missing.isError, true);
            assert.equal(JSON.parse(missingContent.text).error.code, 'missing_project_root');
            assert.equal(unknown.isError, true);
            assert.equal(JSON.parse(unknownContent.text).error.code, 'unknown_tool');
            assert.deepEqual(Object.keys(registry.handlers), CODEX_SCOPE_3_TOOL_NAMES);
        }
        finally {
            runtimeManager.close();
        }
    });
    it('rejects caller identity and named out-of-scope workflow operations', async () => {
        const runtimeManager = manager();
        try {
            const registry = createCodexToolRegistry(runtimeManager);
            const spoofed = await registry.call('planning_discussion_append', {
                project_root: '/not-used',
                issue_id: '1',
                body: 'spoofed',
                agent: 'human',
            });
            const excluded = await registry.call('task_create_batch', {});
            assert.equal(spoofed.isError, true);
            assert.equal((toolPayload(spoofed)['error']['code']), 'unsupported_identity_claim');
            assert.equal(excluded.isError, true);
            assert.equal((toolPayload(excluded)['error']['code']), 'out_of_scope_operation');
        }
        finally {
            runtimeManager.close();
        }
    });
    it('runs a local-only scan and planning flow with fixed Bro authorship', async () => {
        const project = gitProject();
        execFileSync('git', ['-C', project, 'config', 'user.email', 'test@example.com']);
        execFileSync('git', ['-C', project, 'config', 'user.name', 'Codex Test']);
        writeFileSync(join(project, 'README.md'), '# Fixture\n\nProject planning fixture.\n');
        execFileSync('git', ['-C', project, 'add', '.gitignore', 'README.md']);
        execFileSync('git', ['-C', project, 'commit', '--quiet', '-m', 'fixture']);
        execFileSync('git', ['-C', project, 'remote', 'add', 'origin', 'https://github.com/example/fixture.git']);
        const runtimeManager = new CodexRuntimeManager({
            plugin: readCodexPackageMetadata(import.meta.url),
            // Kuzu v0.11 has a known native destructor crash on Node 24/macOS; the
            // shared graph suite covers real Kuzu in a child process. This test keeps
            // the adapter flow in-process and exercises the documented unavailable
            // degradation instead.
            graphHolderFactory: () => GraphHolder.fixed(null),
        });
        try {
            const registry = createCodexToolRegistry(runtimeManager);
            const initialized = await runtimeManager.initialize(project);
            await runtimeManager.withRuntime(project, ({ db }) => {
                db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json)
           VALUES ('issue_sync', '"gh"')`);
            });
            const scanned = await registry.call('project_scan', {
                project_root: project,
            });
            assert.notEqual(scanned.isError, true);
            const inventory = await registry.call('project_inventory', {
                project_root: project,
            });
            const inventoryData = toolPayload(inventory)['data'];
            assert.equal(inventoryData.repos.length, 1);
            assert.equal(inventoryData.repos[0]?.path, realpathSync(project));
            const created = await registry.call('planning_issue_create', {
                project_root: project,
                objective: 'Plan fixture documentation',
                description: 'Define a bounded documentation change.',
                classification: 'Docs',
                priority: 'Low',
            });
            assert.notEqual(created.isError, true);
            const issue = toolPayload(created)['data'];
            assert.ok(issue.id > 0);
            assert.equal(issue.remote_iid, null);
            assert.deepEqual(JSON.parse(issue.labels), ['Docs', 'Priority: Low']);
            const appended = await registry.call('planning_discussion_append', {
                project_root: project,
                issue_id: String(issue.id),
                kind: 'decision',
                body: 'Keep the change local to documentation.',
            });
            assert.notEqual(appended.isError, true);
            const discussion = toolPayload(appended)['data'];
            assert.equal(discussion.author, 'bro');
            assert.equal(discussion.kind, 'decision');
            const resumed = await registry.call('planning_issue_resume', {
                project_root: project,
                issue_id: String(issue.id),
            });
            assert.notEqual(resumed.isError, true);
            const resumedData = toolPayload(resumed)['data'];
            assert.ok('issue' in resumedData);
            assert.ok('discussions' in resumedData);
            assert.equal('next_task' in resumedData, false);
            const db = new DatabaseSync(initialized.trajectory_db);
            try {
                const sync = db
                    .prepare(`SELECT value_json FROM plugin_config WHERE key = 'issue_sync'`)
                    .get();
                assert.equal(JSON.parse(sync.value_json), 'off');
                assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
            }
            finally {
                db.close();
            }
            assert.equal(existsSync(join(project, '.claude')), false);
            assert.equal(existsSync(join(project, '.codex')), false);
            assert.equal(existsSync(join(project, '.agents')), false);
        }
        finally {
            runtimeManager.close();
        }
    });
});
describe('Codex package metadata', () => {
    it('resolves identity from the module path rather than cwd or environment', () => {
        const metadata = readCodexPackageMetadata(import.meta.url);
        const expectedRoot = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
        const manifest = JSON.parse(readFileSync(join(expectedRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
        assert.equal(metadata.root, expectedRoot);
        assert.equal(metadata.name, manifest.name);
        assert.equal(metadata.version, manifest.version);
    });
});
//# sourceMappingURL=codex-runtime.test.js.map