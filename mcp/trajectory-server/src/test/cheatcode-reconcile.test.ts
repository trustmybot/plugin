import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDB } from './helpers.js';
import type { TrajectoryDB } from '../db.js';
import { reconcileCheatcodes, type RuntimeEvidence } from '../tools/cheatcode-reconcile.js';

const NOW = '2026-10-18T12:00:00.000Z';

function evidence(partial: Partial<RuntimeEvidence> = {}): RuntimeEvidence {
  return { mcpServers: null, plugins: null, ...partial };
}

function plugins(entries: Record<string, { enabled: boolean; mcpServers?: string[] }>): RuntimeEvidence['plugins'] {
  return new Map(
    Object.entries(entries).map(([id, e]) => [id, { enabled: e.enabled, mcpServers: new Set(e.mcpServers ?? []) }]),
  );
}

describe('reconcileCheatcodes', () => {
  let db: TrajectoryDB;
  let root: string;

  const addRow = (
    name: string,
    kind: 'skill' | 'mcp' | 'plugin',
    status: string,
    opts: { source_url?: string | null; file_path?: string | null } = {},
  ): number => {
    const res = db.run(
      `INSERT INTO cheatcodes (name, kind, origin, description, source_url, file_path, scope, status, installed_at, created_at, updated_at)
       VALUES (?, ?, 'external', '', ?, ?, 'project-local', ?, 'then', 'then', 'then')`,
      [name, kind, opts.source_url ?? `fixture:${name}`, opts.file_path ?? null, status],
    );
    return Number(res.lastInsertRowid);
  };
  const statusOf = (id: number): string => db.get<{ status: string }>('SELECT status FROM cheatcodes WHERE id = ?', [id])!.status;
  const reconcile = (ev: RuntimeEvidence, pluginRoot: string | undefined = root) =>
    reconcileCheatcodes(db, ev, { fromNode: 'server', writer: 'server', now: NOW, pluginRoot });
  const healthAudits = () =>
    db.all<{ from_node: string; summary: string; content_json: string; created_at: string; issue_id: number; branch_id: string }>(
      `SELECT from_node, summary, content_json, created_at, issue_id, branch_id FROM audit WHERE event_type = 'cheatcode_healthcheck'`,
    );

  beforeEach(() => {
    db = tempDB();
    db.run('DELETE FROM cheatcodes');
    root = mkdtempSync(join(tmpdir(), 'reconcile-'));
    mkdirSync(join(root, 'skills', 'present'), { recursive: true });
    writeFileSync(join(root, 'skills', 'present', 'SKILL.md'), '# present');
  });

  it('skill: absolute file_path present -> active, missing -> broken', () => {
    const present = addRow('abs-present', 'skill', 'broken', { file_path: join(root, 'skills', 'present', 'SKILL.md') });
    const missing = addRow('abs-missing', 'skill', 'active', { file_path: join(root, 'nope', 'SKILL.md') });
    const transitions = reconcile(evidence());
    assert.equal(statusOf(present), 'active');
    assert.equal(statusOf(missing), 'broken');
    assert.equal(transitions.length, 2);
  });

  it('skill: relative file_path resolves against pluginRoot', () => {
    const present = addRow('rel-present', 'skill', 'broken', { file_path: 'skills/present/SKILL.md' });
    const missing = addRow('rel-missing', 'skill', 'active', { file_path: 'skills/absent/SKILL.md' });
    reconcile(evidence());
    assert.equal(statusOf(present), 'active');
    assert.equal(statusOf(missing), 'broken');
  });

  it('bundled mcp: active only when plugin enabled and carries the server key', () => {
    const ok = addRow('srv-ok', 'mcp', 'broken', { source_url: 'mcp:tmb/trajectory-server' });
    const disabled = addRow('srv-disabled', 'mcp', 'active', { source_url: 'mcp:off/srv' });
    const noKey = addRow('srv-nokey', 'mcp', 'active', { source_url: 'mcp:tmb/other-server' });
    const noPlugin = addRow('srv-noplugin', 'mcp', 'active', { source_url: 'mcp:ghost/srv' });
    reconcile(
      evidence({
        plugins: plugins({
          'tmb@market': { enabled: true, mcpServers: ['trajectory-server'] },
          'off@market': { enabled: false, mcpServers: ['srv'] },
        }),
      }),
    );
    assert.equal(statusOf(ok), 'active');
    assert.equal(statusOf(disabled), 'broken');
    assert.equal(statusOf(noKey), 'broken');
    assert.equal(statusOf(noPlugin), 'broken');
  });

  it('bundled mcp: null plugin listing leaves the row untouched', () => {
    const id = addRow('srv', 'mcp', 'active', { source_url: 'mcp:tmb/srv' });
    const transitions = reconcile(evidence({ mcpServers: new Set(['srv']) }));
    assert.equal(statusOf(id), 'active');
    assert.deepEqual(transitions, []);
  });

  it('plain mcp: name present (including merged ~/.claude.json key) -> active, missing -> broken', () => {
    const listed = addRow('listed', 'mcp', 'broken', { source_url: 'npx:listed' });
    const fromJson = addRow('from-claude-json', 'mcp', 'broken', { source_url: 'npx:json' });
    const missing = addRow('missing', 'mcp', 'active', { source_url: 'npx:missing' });
    reconcile(evidence({ mcpServers: new Set(['listed', 'from-claude-json']) }));
    assert.equal(statusOf(listed), 'active');
    assert.equal(statusOf(fromJson), 'active');
    assert.equal(statusOf(missing), 'broken');
  });

  it('plain mcp: null mcp listing leaves the row untouched', () => {
    const id = addRow('srv', 'mcp', 'active', { source_url: 'npx:srv' });
    reconcile(evidence({ plugins: plugins({}) }));
    assert.equal(statusOf(id), 'active');
  });

  it('plugin: enabled -> active, disabled or absent -> broken', () => {
    const enabled = addRow('p-enabled', 'plugin', 'broken');
    const disabled = addRow('p-disabled', 'plugin', 'active');
    const absent = addRow('p-absent', 'plugin', 'active');
    reconcile(evidence({ plugins: plugins({ 'p-enabled@m': { enabled: true }, 'p-disabled@m': { enabled: false } }) }));
    assert.equal(statusOf(enabled), 'active');
    assert.equal(statusOf(disabled), 'broken');
    assert.equal(statusOf(absent), 'broken');
  });

  it('plugin: null plugin listing leaves the row untouched', () => {
    const id = addRow('p', 'plugin', 'active');
    const transitions = reconcile(evidence({ mcpServers: new Set(['p']) }));
    assert.equal(statusOf(id), 'active');
    assert.deepEqual(transitions, []);
    assert.equal(healthAudits().length, 0);
  });

  it('matches exactly: a name that is a substring of another does not match', () => {
    const plugin = addRow('foo', 'plugin', 'active');
    const mcp = addRow('srv', 'mcp', 'active', { source_url: 'npx:srv' });
    const bundled = addRow('bundled', 'mcp', 'active', { source_url: 'mcp:foo/srv' });
    reconcile(
      evidence({
        mcpServers: new Set(['srv-extra', 'my-srv']),
        plugins: plugins({ 'foobar@m': { enabled: true, mcpServers: ['srv'] }, 'myfoo@m': { enabled: true } }),
      }),
    );
    assert.equal(statusOf(plugin), 'broken');
    assert.equal(statusOf(mcp), 'broken');
    assert.equal(statusOf(bundled), 'broken');
  });

  it('writes no audit row and leaves updated_at alone when status is unchanged', () => {
    const id = addRow('p', 'plugin', 'active');
    const transitions = reconcile(evidence({ plugins: plugins({ 'p@m': { enabled: true } }) }));
    assert.deepEqual(transitions, []);
    assert.equal(healthAudits().length, 0);
    assert.equal(db.get<{ updated_at: string }>('SELECT updated_at FROM cheatcodes WHERE id = ?', [id])!.updated_at, 'then');
  });

  it('skips rows that are not active or broken', () => {
    const candidate = addRow('c', 'plugin', 'candidate');
    const approved = addRow('a', 'plugin', 'approved');
    const installed = addRow('i', 'plugin', 'installed');
    const transitions = reconcile(evidence({ plugins: plugins({}) }));
    assert.deepEqual(transitions, []);
    assert.equal(statusOf(candidate), 'candidate');
    assert.equal(statusOf(approved), 'approved');
    assert.equal(statusOf(installed), 'installed');
  });

  it('records the transition and a cheatcode_healthcheck audit row on the system issue', () => {
    const id = addRow('gone', 'plugin', 'active');
    const transitions = reconcile(evidence({ plugins: plugins({}) }));
    assert.deepEqual(transitions, [{ id, name: 'gone', kind: 'plugin', from: 'active', to: 'broken' }]);
    assert.equal(db.get<{ updated_at: string }>('SELECT updated_at FROM cheatcodes WHERE id = ?', [id])!.updated_at, NOW);
    const audits = healthAudits();
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.issue_id, -1);
    assert.equal(audits[0]!.branch_id, '');
    assert.equal(audits[0]!.from_node, 'server');
    assert.equal(audits[0]!.created_at, NOW);
    assert.equal(audits[0]!.summary, 'gone (plugin): active -> broken');
    assert.deepEqual(JSON.parse(audits[0]!.content_json), { name: 'gone', kind: 'plugin', from: 'active', to: 'broken' });
  });

  it('rejects a writer outside the event writer list', () => {
    addRow('gone', 'plugin', 'active');
    assert.throws(() =>
      reconcileCheatcodes(db, evidence({ plugins: plugins({}) }), { fromNode: 'x', writer: 'hook', now: NOW, pluginRoot: root }),
    );
  });
});
