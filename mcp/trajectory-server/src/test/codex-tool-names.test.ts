import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CODEX_SCOPE_3_TOOL_NAMES as sharedScope3,
  CODEX_SCOPE_4_TOOL_NAMES as sharedScope4,
} from '../../../../adapters/codex/tool-names.mjs';
import {
  CODEX_SCOPE_3_TOOL_NAMES,
  CODEX_SCOPE_4_TOOL_NAMES,
} from '../codex-tools.js';

it('re-exports the same frozen Codex tool metadata instead of maintaining another list', () => {
  assert.strictEqual(CODEX_SCOPE_3_TOOL_NAMES, sharedScope3);
  assert.strictEqual(CODEX_SCOPE_4_TOOL_NAMES, sharedScope4);
  assert.ok(Object.isFrozen(sharedScope3));
  assert.ok(Object.isFrozen(sharedScope4));
  assert.equal(new Set(sharedScope4).size, sharedScope4.length);
  assert.deepEqual(sharedScope4.slice(0, sharedScope3.length), sharedScope3);
});

it('evaluates shared metadata without imports, Node globals or host-state access', () => {
  const source = fileURLToPath(new URL('../../../../adapters/codex/tool-names.mjs', import.meta.url));
  const output = execFileSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { createContext, SourceTextModule } from 'node:vm';
    const module = new SourceTextModule(readFileSync(process.argv[1], 'utf8'), {
      context: createContext({}),
    });
    await module.link(() => { throw new Error('Shared metadata must not import runtime modules'); });
    await module.evaluate({ timeout: 1000 });
    process.stdout.write(JSON.stringify({
      names: module.namespace.CODEX_SCOPE_4_TOOL_NAMES,
      frozen: Object.isFrozen(module.namespace.CODEX_SCOPE_4_TOOL_NAMES),
    }));
  `, source], {
    encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', NODE_OPTIONS: '', NODE_PATH: '' },
  });
  assert.deepEqual(JSON.parse(output), { names: sharedScope4, frozen: true });
});

it('bundles the shared surface into a cache-only MCP entrypoint without source data or node_modules', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'tmb-codex-metadata-cache-'));
  const cacheRoot = join(fixture, 'cache');
  const cacheDist = join(cacheRoot, 'mcp', 'trajectory-server', 'dist');
  const client = new Client({ name: 'codex-metadata-cache-test', version: '1.0.0' });
  try {
    mkdirSync(cacheDist, { recursive: true });
    mkdirSync(join(cacheRoot, '.codex-plugin'));
    for (const name of ['codex.js', 'schema.sql']) {
      copyFileSync(new URL(`../${name}`, import.meta.url), join(cacheDist, name));
    }
    copyFileSync(
      new URL('../../../../.codex-plugin/plugin.json', import.meta.url),
      join(cacheRoot, '.codex-plugin', 'plugin.json'),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--experimental-sqlite', join(cacheDist, 'codex.js')],
      cwd: cacheRoot,
      env: { PATH: '/usr/bin:/bin', HOME: join(fixture, 'home'), NODE_PATH: '', NODE_OPTIONS: '' },
      stderr: 'pipe',
    });
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), sharedScope4);
    assert.equal(existsSync(join(cacheRoot, 'adapters')), false, 'shared metadata is included in the bundle');
    assert.equal(existsSync(join(cacheRoot, 'node_modules')), false);
    assert.equal(existsSync(join(cacheRoot, '.tmb')), false, 'listing the shared surface does not initialize project state');
  } finally {
    await client.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});
