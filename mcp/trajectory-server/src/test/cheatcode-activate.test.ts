// cheatcode_activate over the wire (GH 660): the built server installs a plugin and a skill from a fixture, then returns each kind's verdict.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { cleanEnv, tempWorkspace } from './cheatcode-stubs.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js');

interface WireResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: Record<string, unknown>;
  text: string;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<WireResult> {
  const res = (await client.callTool({ name, arguments: args })) as { content?: Array<{ text?: string }>; isError?: boolean };
  const text = res.content?.[0]?.text ?? '';
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return res.isError ? { ok: false, error: body, text } : { ok: true, data: body, text };
}

describe('cheatcode_activate over the wire', () => {
  const ws = tempWorkspace('tmb-cheatcode-activate');
  let client: Client;
  let plugin: WireResult;
  let skill: WireResult;
  let unknown: WireResult;
  let forbidden: WireResult;

  before(async () => {
    const fixture = join(ws.dir, 'install.json');
    writeFileSync(fixture, '{ "installed": true, "version": "1.2.3", "error": null }');
    const serverTmp = join(ws.dir, 'tmp');
    mkdirSync(serverTmp);
    const env = cleanEnv({
      TMB_DISABLE_CHEATCODE_HEALTHCHECK: '1',
      TMB_CHEATCODE_INSTALL_FIXTURE: fixture,
      TRAJECTORY_DB_PATH: ':memory:',
      TMPDIR: serverTmp,
    });
    client = new Client({ name: 'tmb-cheatcode-activate-test', version: '1.0' }, { capabilities: {} });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [SERVER], env: env as Record<string, string>, cwd: ws.dir, stderr: 'ignore' }),
    );
    await call(client, 'audit_append', {
      agent: 'bro',
      issue_id: '-1',
      from_node: 'bro',
      kind: 'event',
      event_type: 'deep_scan_completed',
      summary: 'cheatcode-activate test: registry gate cleared',
    });

    const install = async (candidate: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<number> => {
      await call(client, 'cheatcode_approve', { agent: 'bro', candidate });
      const r = await call(client, 'cheatcode_install', { agent: 'bro', candidate, ...extra });
      assert.ok(r.ok, `install failed: ${r.text}`);
      return r.data?.['cheatcode_id'] as number;
    };
    const pluginId = await install({ name: 'pdf-plugin', kind: 'plugin', source_url: 'https://x.test/pdf', tier: 1 });
    const skillId = await install({ name: 'pdf-skill', kind: 'skill', source_url: 'https://x.test/pdf-skill' }, { target: 'bro' });

    plugin = await call(client, 'cheatcode_activate', { agent: 'bro', cheatcode_id: pluginId });
    skill = await call(client, 'cheatcode_activate', { agent: 'bro', cheatcode_id: skillId });
    unknown = await call(client, 'cheatcode_activate', { agent: 'bro', cheatcode_id: 99999 });
    forbidden = await call(client, 'cheatcode_activate', { agent: 'swe', cheatcode_id: pluginId });
  });
  after(async () => {
    await client?.close();
    ws.cleanup();
  });

  it('activate output is JSON', () => {
    for (const r of [plugin, skill, unknown, forbidden]) assert.doesNotThrow(() => JSON.parse(r.text), r.text);
  });
  it('plugin-kind activate returns restart_required', () => {
    assert.ok(plugin.ok, plugin.text);
    assert.equal(plugin.data?.['status'], 'restart_required');
  });
  it('plugin-kind restart_required carries a non-empty reason', () => {
    const reason = plugin.data?.['reason'];
    assert.ok(typeof reason === 'string' && reason !== '', plugin.text);
  });
  it('skill-kind activate returns activated', () => {
    assert.ok(skill.ok, skill.text);
    assert.equal(skill.data?.['status'], 'activated');
  });
  it('an unknown cheatcode_id is an error (never silently throws)', () => {
    assert.equal(unknown.ok, false);
  });
  it('a non-bro caller is forbidden at the wire', () => {
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.error?.['error'], 'forbidden');
  });
});
