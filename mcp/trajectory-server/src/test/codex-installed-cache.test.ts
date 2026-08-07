import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { it } from 'node:test';

const EXPECTED_SCOPE_3_TOOL_NAMES = [
  'runtime_initialize',
  'project_inventory',
  'project_scan',
  'world_model_get',
  'world_model_search',
  'planning_label_taxonomy_get',
  'planning_label_taxonomy_set',
  'planning_issue_create',
  'planning_issue_get',
  'planning_issue_list',
  'planning_issue_resume',
  'planning_discussion_append',
  'planning_discussion_list',
] as const;

function payloadOf(result: unknown): Record<string, unknown> {
  const content = (result as {
    content: Array<{ type: string; text?: string }>;
  }).content[0];
  assert.equal(content?.type, 'text');
  if (!content || content.type !== 'text' || content.text === undefined) {
    throw new Error('Expected text MCP content');
  }
  return JSON.parse(content.text) as Record<string, unknown>;
}

it('cold-boots from an installed-cache copy without source node_modules', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'tmb-codex-cache-'));
  let client: Client | undefined;
  try {
    const project = join(fixture, 'project');
    const testFile = fileURLToPath(import.meta.url);
    const sourceDist = dirname(dirname(testFile));
    const sourceRoot = dirname(dirname(dirname(sourceDist)));
    const manifest = JSON.parse(
      readFileSync(join(sourceRoot, '.codex-plugin', 'plugin.json'), 'utf8'),
    ) as { name: string; version: string };
    const cacheRoot = join(
      fixture,
      'cache',
      manifest.name,
      manifest.version,
    );
    const cacheDist = join(cacheRoot, 'mcp', 'trajectory-server', 'dist');
    const cacheAdapter = join(cacheRoot, 'adapters', 'codex');
    mkdirSync(project, { recursive: true });
    mkdirSync(join(cacheRoot, '.codex-plugin'), { recursive: true });
    mkdirSync(cacheAdapter, { recursive: true });
    mkdirSync(cacheDist, { recursive: true });
    execFileSync('git', ['init', '--quiet', project]);
    writeFileSync(join(project, '.gitignore'), '.tmb/\n');
    writeFileSync(join(project, 'README.md'), '# Installed fixture\n');
    execFileSync('git', ['-C', project, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', project, 'config', 'user.name', 'Codex Cache Test']);
    execFileSync('git', ['-C', project, 'add', '.gitignore', 'README.md']);
    execFileSync('git', ['-C', project, 'commit', '--quiet', '-m', 'fixture']);
    execFileSync('git', ['-C', project, 'remote', 'add', 'origin', 'https://github.com/example/fixture.git']);
    const claudeState = join(project, '.claude', 'tmb', 'trajectory.db');
    mkdirSync(dirname(claudeState), { recursive: true });
    writeFileSync(claudeState, 'existing Claude state must remain untouched');

    cpSync(join(sourceDist, 'codex.js'), join(cacheDist, 'codex.js'));
    cpSync(join(sourceDist, 'schema.sql'), join(cacheDist, 'schema.sql'));
    cpSync(
      join(sourceRoot, 'adapters', 'codex', '.mcp.json'),
      join(cacheAdapter, '.mcp.json'),
    );
    cpSync(
      join(sourceRoot, 'adapters', 'codex', 'skills'),
      join(cacheAdapter, 'skills'),
      { recursive: true },
    );
    writeFileSync(
      join(cacheRoot, '.codex-plugin', 'plugin.json'),
      readFileSync(join(sourceRoot, '.codex-plugin', 'plugin.json')),
    );

    const mcpConfig = JSON.parse(
      readFileSync(join(cacheAdapter, '.mcp.json'), 'utf8'),
    ) as {
      'trajectory-server': {
        command: string;
        args: string[];
        cwd: string;
      };
    };
    const configured = mcpConfig['trajectory-server'];
    const installedSkillEntries = readdirSync(join(cacheAdapter, 'skills'));
    assert.deepEqual(installedSkillEntries, ['tmb-bro']);
    assert.match(
      readFileSync(join(cacheAdapter, 'skills', 'tmb-bro', 'agents', 'openai.yaml'), 'utf8'),
      /allow_implicit_invocation: false/,
    );
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
    assert.equal(
      readFileSync(claudeState, 'utf8'),
      'existing Claude state must remain untouched',
    );
    assert.equal(existsSync(join(cacheRoot, '.tmb')), false);

    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      EXPECTED_SCOPE_3_TOOL_NAMES,
    );
    assert.equal(listed.tools.length, 13);
    const installedTaxonomySet = listed.tools.find(
      (tool) => tool.name === 'planning_label_taxonomy_set',
    );
    assert.deepEqual(installedTaxonomySet?.inputSchema.required, [
      'project_root',
      'classification_labels',
      'priority_labels',
    ]);
    const installedIssueCreate = listed.tools.find(
      (tool) => tool.name === 'planning_issue_create',
    );
    const installedIssueProperties = installedIssueCreate?.inputSchema.properties as
      | Record<string, unknown>
      | undefined;
    assert.deepEqual(
      (installedIssueProperties?.['labels'] as Record<string, unknown>)['items'],
      { type: 'string', minLength: 1, pattern: '\\S' },
    );
    assert.deepEqual(installedIssueCreate?.inputSchema['allOf'], [
      { not: { required: ['labels', 'classification'] } },
      { not: { required: ['labels', 'priority'] } },
    ]);
    assert.equal(existsSync(join(project, '.tmb')), false);
    assert.equal(
      readFileSync(claudeState, 'utf8'),
      'existing Claude state must remain untouched',
    );
    assert.equal(existsSync(join(cacheRoot, '.tmb')), false);

    const createdCall = await client.callTool({
      name: 'runtime_initialize',
      arguments: { project_root: project },
    });
    assert.notEqual(createdCall.isError, true);
    const createdContent = (
      createdCall as { content: Array<{ type: string; text?: string }> }
    ).content[0]!;
    assert.equal(createdContent.type, 'text');
    if (createdContent.type !== 'text' || createdContent.text === undefined) {
      throw new Error('Expected text MCP content');
    }
    const createdPayload = JSON.parse(createdContent.text) as {
      ok: true;
      data: {
        runtime: {
          status: string;
          project_root: string;
          plugin_name: string;
          plugin_version: string;
          trajectory_db: string;
          graph_db: string;
          log_dir: string;
          schema_version: number;
          graph_available: boolean;
          graph_status: string;
        };
      };
    };
    const createdRuntime = createdPayload.data.runtime;
    const canonicalProject = realpathSync(project);
    assert.equal(createdPayload.ok, true);
    assert.equal(createdRuntime.status, 'created');
    assert.equal(createdRuntime.project_root, canonicalProject);
    assert.equal(createdRuntime.plugin_name, manifest.name);
    assert.equal(createdRuntime.plugin_version, manifest.version);
    assert.equal(createdRuntime.schema_version, 28);
    assert.equal(createdRuntime.graph_available, false);
    assert.equal(createdRuntime.graph_status, 'unavailable');
    assert.ok(
      createdRuntime.trajectory_db.startsWith(
        join(canonicalProject, '.tmb'),
      ),
    );
    assert.ok(
      createdRuntime.graph_db.startsWith(join(canonicalProject, '.tmb')),
    );
    assert.ok(
      createdRuntime.log_dir.startsWith(join(canonicalProject, '.tmb')),
    );

    const db = new DatabaseSync(createdRuntime.trajectory_db);
    try {
      const row = db
        .prepare('SELECT schema_version, plugin_version FROM plugin_meta WHERE id = 1')
        .get() as { schema_version: number; plugin_version: string };
      assert.equal(row.schema_version, 28);
      assert.equal(row.plugin_version, manifest.version);
    } finally {
      db.close();
    }

    const reusedCall = await client.callTool({
      name: 'runtime_initialize',
      arguments: { project_root: project },
    });
    const reusedContent = (
      reusedCall as { content: Array<{ type: string; text?: string }> }
    ).content[0]!;
    assert.equal(reusedContent.type, 'text');
    if (reusedContent.type !== 'text' || reusedContent.text === undefined) {
      throw new Error('Expected text MCP content');
    }
    const reusedPayload = JSON.parse(reusedContent.text) as {
      data: { runtime: { status: string; trajectory_db: string } };
    };
    assert.equal(reusedPayload.data.runtime.status, 'reused');
    assert.equal(
      reusedPayload.data.runtime.trajectory_db,
      createdRuntime.trajectory_db,
    );

    const scanCall = await client.callTool({
      name: 'project_scan',
      arguments: { project_root: project },
    });
    assert.notEqual(scanCall.isError, true);
    const inventoryCall = await client.callTool({
      name: 'project_inventory',
      arguments: { project_root: project },
    });
    const inventory = payloadOf(inventoryCall)['data'] as {
      repos: Array<{ path: string }>;
    };
    assert.equal(inventory.repos.length, 1);
    assert.equal(inventory.repos[0]?.path, canonicalProject);

    const configuredTaxonomy = await client.callTool({
      name: 'planning_label_taxonomy_set',
      arguments: {
        project_root: project,
        classification_labels: ['Defect', 'Capability'],
        priority_labels: ['P0', 'P1', 'P2'],
      },
    });
    assert.notEqual(configuredTaxonomy.isError, true);
    assert.deepEqual(payloadOf(configuredTaxonomy)['data'], {
      classification_labels: ['Defect', 'Capability'],
      priority_labels: ['P0', 'P1', 'P2'],
      classification_source: 'configured',
      priority_source: 'configured',
    });

    // Taxonomy setup above is intentionally public-MCP-only. This direct DB
    // mutation is a separate adversarial precondition proving issue creation
    // forces an existing remote-sync setting back to local-only.
    const configuredDb = new DatabaseSync(createdRuntime.trajectory_db);
    try {
      configuredDb
        .prepare(`UPDATE plugin_config SET value_json = '"gh"' WHERE key = 'issue_sync'`)
        .run();
    } finally {
      configuredDb.close();
    }

    const taxonomyCall = await client.callTool({
      name: 'planning_label_taxonomy_get',
      arguments: { project_root: project },
    });
    assert.notEqual(taxonomyCall.isError, true);
    assert.deepEqual(payloadOf(taxonomyCall)['data'], {
      classification_labels: ['Defect', 'Capability'],
      priority_labels: ['P0', 'P1', 'P2'],
      classification_source: 'configured',
      priority_source: 'configured',
    });

    const planningCall = await client.callTool({
      name: 'planning_issue_create',
      arguments: {
        project_root: project,
        objective: 'Plan the installed-cache fixture',
        description: 'Prove local planning works without source node_modules.',
        labels: ['Capability', 'P1', 'cache-proof'],
      },
    });
    assert.notEqual(planningCall.isError, true);
    const planningIssue = payloadOf(planningCall)['data'] as {
      id: number;
      remote_iid: number | null;
    };
    assert.ok(planningIssue.id > 0);
    assert.equal(planningIssue.remote_iid, null);

    const discussionCall = await client.callTool({
      name: 'planning_discussion_append',
      arguments: {
        project_root: project,
        issue_id: String(planningIssue.id),
        kind: 'decision',
        body: 'Installed-cache execution remains local-only.',
      },
    });
    assert.notEqual(discussionCall.isError, true);
    const discussion = payloadOf(discussionCall)['data'] as { author: string };
    assert.equal(discussion.author, 'bro');

    const resumedCall = await client.callTool({
      name: 'planning_issue_resume',
      arguments: {
        project_root: project,
        issue_id: String(planningIssue.id),
      },
    });
    assert.notEqual(resumedCall.isError, true);
    const resumed = payloadOf(resumedCall)['data'] as Record<string, unknown>;
    assert.ok('issue' in resumed);
    assert.ok('discussions' in resumed);
    assert.equal('next_task' in resumed, false);

    const excludedCall = await client.callTool({
      name: 'task_create_batch',
      arguments: { project_root: project },
    });
    assert.equal(excludedCall.isError, true);
    assert.equal(
      ((payloadOf(excludedCall)['error'] as Record<string, unknown>)['code']),
      'out_of_scope_operation',
    );

    const persisted = new DatabaseSync(createdRuntime.trajectory_db);
    try {
      assert.equal(
        (persisted.prepare('SELECT COUNT(*) AS n FROM issues WHERE id != -1').get() as { n: number }).n,
        1,
      );
      assert.equal(
        (persisted.prepare("SELECT COUNT(*) AS n FROM discussions WHERE author = 'bro'").get() as { n: number }).n,
        1,
      );
      const sync = persisted
        .prepare("SELECT value_json FROM plugin_config WHERE key = 'issue_sync'")
        .get() as { value_json: string };
      assert.equal(JSON.parse(sync.value_json), 'off');
      const labels = persisted
        .prepare('SELECT labels FROM issues WHERE id = ?')
        .get(planningIssue.id) as { labels: string };
      assert.deepEqual(JSON.parse(labels.labels), [
        'Capability',
        'P1',
        'cache-proof',
      ]);
    } finally {
      persisted.close();
    }

    assert.ok(existsSync(join(project, '.tmb', 'tmb', 'trajectory.db')));
    assert.equal(
      readFileSync(claudeState, 'utf8'),
      'existing Claude state must remain untouched',
    );
    assert.equal(existsSync(join(cacheRoot, 'node_modules')), false);
    assert.equal(existsSync(join(cacheRoot, '.tmb')), false);
    assert.equal(existsSync(join(cacheRoot, 'must-not-be-used.db')), false);
    assert.equal(existsSync(join(sourceRoot, '.tmb')), false);
  } finally {
    await client?.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});
