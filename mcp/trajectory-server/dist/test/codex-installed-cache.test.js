import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { it } from 'node:test';
it('cold-boots from an installed-cache copy without source node_modules', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'tmb-codex-cache-'));
    let client;
    try {
        const project = join(fixture, 'project');
        const testFile = fileURLToPath(import.meta.url);
        const sourceDist = dirname(dirname(testFile));
        const sourceRoot = dirname(dirname(dirname(sourceDist)));
        const manifest = JSON.parse(readFileSync(join(sourceRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
        const cacheRoot = join(fixture, 'cache', manifest.name, manifest.version);
        const cacheDist = join(cacheRoot, 'mcp', 'trajectory-server', 'dist');
        const cacheAdapter = join(cacheRoot, 'adapters', 'codex');
        mkdirSync(project, { recursive: true });
        mkdirSync(join(cacheRoot, '.codex-plugin'), { recursive: true });
        mkdirSync(cacheAdapter, { recursive: true });
        mkdirSync(cacheDist, { recursive: true });
        execFileSync('git', ['init', '--quiet', project]);
        writeFileSync(join(project, '.gitignore'), '.tmb/\n');
        const claudeState = join(project, '.claude', 'tmb', 'trajectory.db');
        mkdirSync(dirname(claudeState), { recursive: true });
        writeFileSync(claudeState, 'existing Claude state must remain untouched');
        cpSync(join(sourceDist, 'codex.js'), join(cacheDist, 'codex.js'));
        cpSync(join(sourceDist, 'schema.sql'), join(cacheDist, 'schema.sql'));
        cpSync(join(sourceRoot, 'adapters', 'codex', '.mcp.json'), join(cacheAdapter, '.mcp.json'));
        writeFileSync(join(cacheRoot, '.codex-plugin', 'plugin.json'), readFileSync(join(sourceRoot, '.codex-plugin', 'plugin.json')));
        const mcpConfig = JSON.parse(readFileSync(join(cacheAdapter, '.mcp.json'), 'utf8'));
        const configured = mcpConfig['trajectory-server'];
        const transport = new StdioClientTransport({
            command: configured.command,
            args: configured.args,
            cwd: join(cacheRoot, configured.cwd),
            env: {
                PATH: process.env['PATH'] ?? '',
                HOME: join(fixture, 'isolated-home'),
                CLAUDE_PLUGIN_ROOT: sourceRoot,
                TRAJECTORY_DB_PATH: join(cacheRoot, 'must-not-be-used.db'),
                NODE_PATH: '',
            },
            stderr: 'pipe',
        });
        client = new Client({ name: 'codex-cache-test', version: '1.0.0' });
        await client.connect(transport);
        assert.equal(existsSync(join(project, '.tmb')), false);
        assert.equal(readFileSync(claudeState, 'utf8'), 'existing Claude state must remain untouched');
        assert.equal(existsSync(join(cacheRoot, '.tmb')), false);
        const listed = await client.listTools();
        assert.deepEqual(listed.tools.map((tool) => tool.name), ['runtime_initialize']);
        assert.equal(existsSync(join(project, '.tmb')), false);
        assert.equal(readFileSync(claudeState, 'utf8'), 'existing Claude state must remain untouched');
        assert.equal(existsSync(join(cacheRoot, '.tmb')), false);
        const createdCall = await client.callTool({
            name: 'runtime_initialize',
            arguments: { project_root: project },
        });
        assert.notEqual(createdCall.isError, true);
        const createdContent = createdCall.content[0];
        assert.equal(createdContent.type, 'text');
        if (createdContent.type !== 'text' || createdContent.text === undefined) {
            throw new Error('Expected text MCP content');
        }
        const createdPayload = JSON.parse(createdContent.text);
        const canonicalProject = realpathSync(project);
        assert.equal(createdPayload.ok, true);
        assert.equal(createdPayload.runtime.status, 'created');
        assert.equal(createdPayload.runtime.project_root, canonicalProject);
        assert.equal(createdPayload.runtime.plugin_name, manifest.name);
        assert.equal(createdPayload.runtime.plugin_version, manifest.version);
        assert.equal(createdPayload.runtime.schema_version, 28);
        assert.equal(createdPayload.runtime.graph_available, false);
        assert.equal(createdPayload.runtime.graph_status, 'unavailable');
        assert.ok(createdPayload.runtime.trajectory_db.startsWith(join(canonicalProject, '.tmb')));
        assert.ok(createdPayload.runtime.graph_db.startsWith(join(canonicalProject, '.tmb')));
        assert.ok(createdPayload.runtime.log_dir.startsWith(join(canonicalProject, '.tmb')));
        const db = new DatabaseSync(createdPayload.runtime.trajectory_db);
        try {
            const row = db
                .prepare('SELECT schema_version, plugin_version FROM plugin_meta WHERE id = 1')
                .get();
            assert.equal(row.schema_version, 28);
            assert.equal(row.plugin_version, manifest.version);
        }
        finally {
            db.close();
        }
        const reusedCall = await client.callTool({
            name: 'runtime_initialize',
            arguments: { project_root: project },
        });
        const reusedContent = reusedCall.content[0];
        assert.equal(reusedContent.type, 'text');
        if (reusedContent.type !== 'text' || reusedContent.text === undefined) {
            throw new Error('Expected text MCP content');
        }
        const reusedPayload = JSON.parse(reusedContent.text);
        assert.equal(reusedPayload.runtime.status, 'reused');
        assert.equal(reusedPayload.runtime.trajectory_db, createdPayload.runtime.trajectory_db);
        assert.ok(existsSync(join(project, '.tmb', 'tmb', 'trajectory.db')));
        assert.equal(readFileSync(claudeState, 'utf8'), 'existing Claude state must remain untouched');
        assert.equal(existsSync(join(cacheRoot, 'node_modules')), false);
        assert.equal(existsSync(join(cacheRoot, '.tmb')), false);
        assert.equal(existsSync(join(cacheRoot, 'must-not-be-used.db')), false);
        assert.equal(existsSync(join(sourceRoot, '.tmb')), false);
    }
    finally {
        await client?.close();
        rmSync(fixture, { recursive: true, force: true });
    }
});
//# sourceMappingURL=codex-installed-cache.test.js.map