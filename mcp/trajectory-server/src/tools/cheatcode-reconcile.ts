import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import { serverLog } from '../logger.js';
import { insertAudit } from './audit.js';
import type { Writer } from '../audit-events.js';

export interface PluginEvidence {
  enabled: boolean;
  mcpServers: Set<string>;
}

export interface RuntimeEvidence {
  mcpServers: Set<string> | null;
  plugins: Map<string, PluginEvidence> | null;
}

export interface Transition {
  id: number;
  name: string;
  kind: string;
  from: string;
  to: string;
}

export interface ReconcileOptions {
  fromNode: string;
  writer: Writer;
  now: string;
  pluginRoot?: string;
}

const DEFAULT_TIMEOUT_SEC = 4;
const MAX_LISTING_BYTES = 8 * 1024 * 1024;

export function healthcheckTimeoutSec(): number {
  const raw = Number(process.env['TMB_CHEATCODE_HEALTHCHECK_TIMEOUT']);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_SEC;
}

export function probeChildEnv(): NodeJS.ProcessEnv {
  return { ...process.env, TMB_DISABLE_CHEATCODE_HEALTHCHECK: '1' };
}

function runClaude(args: string[], timeoutSec: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        'claude',
        args,
        {
          env: probeChildEnv(),
          timeout: timeoutSec * 1000,
          killSignal: 'SIGKILL',
          maxBuffer: MAX_LISTING_BYTES,
          encoding: 'utf8',
        },
        (error, stdout) => resolve(error ? null : stdout),
      );
      child.stdin?.end();
    } catch {
      resolve(null);
    }
  });
}

function parseMcpListing(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const sep = line.indexOf(': ');
    if (sep > 0) names.add(line.slice(0, sep));
  }
  return names;
}

function claudeJsonMcpKeys(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
    const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
    if (servers && typeof servers === 'object') return new Set(Object.keys(servers));
  } catch {
    return new Set();
  }
  return new Set();
}

function parsePluginListing(text: string): Map<string, PluginEvidence> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const plugins = new Map<string, PluginEvidence>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, enabled, mcpServers } = entry as { id?: unknown; enabled?: unknown; mcpServers?: unknown };
    plugins.set(typeof id === 'string' ? id : '', {
      enabled: enabled === true,
      mcpServers: new Set(mcpServers && typeof mcpServers === 'object' ? Object.keys(mcpServers) : []),
    });
  }
  return plugins;
}

export async function probeRuntime(timeoutSec: number): Promise<RuntimeEvidence> {
  const [mcpText, pluginText] = await Promise.all([
    runClaude(['mcp', 'list'], timeoutSec),
    runClaude(['plugin', 'list', '--json'], timeoutSec),
  ]);
  const mcpNames = new Set([...(mcpText === null ? [] : parseMcpListing(mcpText)), ...claudeJsonMcpKeys()]);
  return {
    mcpServers: mcpNames.size > 0 ? mcpNames : null,
    plugins: pluginText === null ? null : parsePluginListing(pluginText),
  };
}

function pluginName(id: string): string {
  return id.split('@')[0] ?? '';
}

type Computed = 'active' | 'broken' | null;

function computeStatus(
  row: { kind: string; name: string; source_url: string | null; file_path: string | null },
  evidence: RuntimeEvidence,
  pluginRoot: string | undefined,
): Computed {
  switch (row.kind) {
    case 'skill': {
      if (!row.file_path) return 'broken';
      const resolved = isAbsolute(row.file_path) || !pluginRoot ? row.file_path : join(pluginRoot, row.file_path);
      return existsSync(resolved) ? 'active' : 'broken';
    }
    case 'mcp': {
      const bundled = /^mcp:([^/]+)\/(.+)$/.exec(row.source_url ?? '');
      if (bundled) {
        if (!evidence.plugins) return null;
        const [, plugin, server] = bundled;
        for (const [id, entry] of evidence.plugins) {
          if (pluginName(id) === plugin && entry.enabled && entry.mcpServers.has(server as string)) return 'active';
        }
        return 'broken';
      }
      if (!evidence.mcpServers) return null;
      return evidence.mcpServers.has(row.name) ? 'active' : 'broken';
    }
    case 'plugin': {
      if (!evidence.plugins) return null;
      for (const [id, entry] of evidence.plugins) {
        if (pluginName(id) === row.name && entry.enabled) return 'active';
      }
      return 'broken';
    }
    default:
      return null;
  }
}

export function reconcileCheatcodes(db: TrajectoryDB, evidence: RuntimeEvidence, opts: ReconcileOptions): Transition[] {
  const pluginRoot = opts.pluginRoot ?? process.env['CLAUDE_PLUGIN_ROOT'];
  const rows = db.all<{
    id: number;
    name: string;
    kind: string;
    status: string;
    source_url: string | null;
    file_path: string | null;
  }>(`SELECT id, name, kind, status, source_url, file_path FROM cheatcodes WHERE status IN ('active', 'broken') ORDER BY id`);

  const transitions: Transition[] = [];
  for (const row of rows) {
    const next = computeStatus(row, evidence, pluginRoot);
    if (next === null || next === row.status) continue;
    db.run('UPDATE cheatcodes SET status = ?, updated_at = ? WHERE id = ?', [next, opts.now, row.id]);
    insertAudit(db, {
      issue_id: -1,
      branch_id: '',
      from_node: opts.fromNode,
      writer: opts.writer,
      event_type: 'cheatcode_healthcheck',
      summary: `${row.name} (${row.kind}): ${row.status} -> ${next}`,
      content_json: JSON.stringify({ name: row.name, kind: row.kind, from: row.status, to: next }),
      created_at: opts.now,
    });
    transitions.push({ id: row.id, name: row.name, kind: row.kind, from: row.status, to: next });
  }
  return transitions;
}

export async function reconcileNow(
  db: TrajectoryDB,
  identity: { fromNode: string; writer: Writer },
): Promise<{ transitions: Transition[]; probed: { mcp: boolean; plugin: boolean } }> {
  const evidence = await probeRuntime(healthcheckTimeoutSec());
  const transitions = reconcileCheatcodes(db, evidence, { ...identity, now: nowISO() });
  return { transitions, probed: { mcp: evidence.mcpServers !== null, plugin: evidence.plugins !== null } };
}

export async function reconcileAtStartup(db: TrajectoryDB): Promise<void> {
  if (process.env['TMB_DISABLE_CHEATCODE_HEALTHCHECK'] === '1') return;
  try {
    const { transitions } = await reconcileNow(db, { fromNode: 'server', writer: 'server' });
    serverLog({ kind: 'cheatcode_reconcile', transitions: transitions.length });
  } catch (e) {
    serverLog({ kind: 'cheatcode_reconcile', error_message: e instanceof Error ? e.message : String(e) });
  }
}
