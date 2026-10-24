import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import { serverLog } from '../logger.js';
import { insertAudit } from './audit.js';
import { projectRootFromDbPath, projectSpawnOptions } from './containment.js';
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

export function probeChildEnv(projectRoot: string | null = null): NodeJS.ProcessEnv {
  const base = projectRoot === null ? process.env : projectSpawnOptions(projectRoot).env;
  return { ...base, TMB_DISABLE_CHEATCODE_HEALTHCHECK: '1' };
}

function runClaude(args: string[], timeoutSec: number, projectRoot: string | null): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        'claude',
        args,
        {
          ...(projectRoot === null ? {} : { cwd: projectRoot }),
          env: probeChildEnv(projectRoot),
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

async function probeListings(
  timeoutSec: number,
  projectRoot: string | null,
): Promise<{ evidence: RuntimeEvidence; listed: boolean }> {
  const [mcpText, pluginText] = await Promise.all([
    runClaude(['mcp', 'list'], timeoutSec, projectRoot),
    runClaude(['plugin', 'list', '--json'], timeoutSec, projectRoot),
  ]);
  const mcpNames = new Set([...(mcpText === null ? [] : parseMcpListing(mcpText)), ...claudeJsonMcpKeys()]);
  const plugins = pluginText === null ? null : parsePluginListing(pluginText);
  return {
    evidence: { mcpServers: mcpNames.size > 0 ? mcpNames : null, plugins },
    listed: mcpText !== null || plugins !== null,
  };
}

export async function probeRuntime(timeoutSec: number, projectRoot: string | null = null): Promise<RuntimeEvidence> {
  return (await probeListings(timeoutSec, projectRoot)).evidence;
}

const PROBE_TTL_MS = 24 * 60 * 60 * 1000;

export type ProbeReason = 'no_tracked_rows' | 'fingerprint_unchanged' | 'fingerprint_changed' | 'ttl_expired' | 'no_cache';

interface ProbeCache {
  fingerprint: string;
  probed_at: string;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value) ? ((value as Record<string, unknown>)[key] ?? null) : null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function cliConfigFingerprint(projectRoot: string | null): string {
  const home = homedir();
  const claudeJson = readJson(join(home, '.claude.json'));
  const inProject = (...parts: string[]): unknown => (projectRoot === null ? null : readJson(join(projectRoot, ...parts)));
  const inputs = {
    claudeJsonMcpServers: field(claudeJson, 'mcpServers'),
    claudeJsonProjectMcpServers: projectRoot === null ? null : field(field(field(claudeJson, 'projects'), projectRoot), 'mcpServers'),
    projectMcpJson: inProject('.mcp.json'),
    enabledPlugins: {
      user: field(readJson(join(home, '.claude', 'settings.json')), 'enabledPlugins'),
      project: field(inProject('.claude', 'settings.json'), 'enabledPlugins'),
      local: field(inProject('.claude', 'settings.local.json'), 'enabledPlugins'),
    },
    installedPlugins: readJson(join(home, '.claude', 'plugins', 'installed_plugins.json')),
  };
  return createHash('sha256').update(stableJson(inputs)).digest('hex');
}

export function probeCachePath(projectRoot: string): string {
  return join(projectRoot, '.claude', 'tmb', 'cheatcode-probe.json');
}

function readProbeCache(projectRoot: string | null): ProbeCache | null {
  if (projectRoot === null) return null;
  const parsed = readJson(probeCachePath(projectRoot));
  const fingerprint = field(parsed, 'fingerprint');
  const probedAt = field(parsed, 'probed_at');
  if (typeof fingerprint !== 'string' || typeof probedAt !== 'string' || Number.isNaN(Date.parse(probedAt))) return null;
  return { fingerprint, probed_at: probedAt };
}

function writeProbeCache(projectRoot: string | null, cache: ProbeCache): void {
  if (projectRoot === null) return;
  const path = probeCachePath(projectRoot);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache) + '\n');
  } catch (e) {
    serverLog({ kind: 'cheatcode_probe_cache_write_failed', error_message: e instanceof Error ? e.message : String(e) });
  }
}

function startupProbeReason(cache: ProbeCache | null, fingerprint: string, nowMs: number): ProbeReason {
  if (cache === null) return 'no_cache';
  if (cache.fingerprint !== fingerprint) return 'fingerprint_changed';
  if (nowMs - Date.parse(cache.probed_at) > PROBE_TTL_MS) return 'ttl_expired';
  return 'fingerprint_unchanged';
}

function hasTrackedRuntimeRows(db: TrajectoryDB): boolean {
  return (
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM cheatcodes WHERE status IN ('active', 'broken') AND kind IN ('mcp', 'plugin')`,
    )!.n > 0
  );
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

const NO_EVIDENCE: RuntimeEvidence = { mcpServers: null, plugins: null };

async function probeAndReconcile(
  db: TrajectoryDB,
  identity: { fromNode: string; writer: Writer },
  projectRoot: string | null,
  fingerprint: string,
): Promise<{ transitions: Transition[]; probed: { mcp: boolean; plugin: boolean } }> {
  const { evidence, listed } = await probeListings(healthcheckTimeoutSec(), projectRoot);
  const now = nowISO();
  if (listed) writeProbeCache(projectRoot, { fingerprint, probed_at: now });
  const transitions = reconcileCheatcodes(db, evidence, { ...identity, now });
  return { transitions, probed: { mcp: evidence.mcpServers !== null, plugin: evidence.plugins !== null } };
}

export async function reconcileNow(
  db: TrajectoryDB,
  identity: { fromNode: string; writer: Writer },
): Promise<{ transitions: Transition[]; probed: { mcp: boolean; plugin: boolean } }> {
  const projectRoot = projectRootFromDbPath(db.dbPath);
  return probeAndReconcile(db, identity, projectRoot, cliConfigFingerprint(projectRoot));
}

export async function reconcileAtStartup(db: TrajectoryDB): Promise<void> {
  if (process.env['TMB_DISABLE_CHEATCODE_HEALTHCHECK'] === '1') return;
  const identity = { fromNode: 'server', writer: 'server' } as const;
  try {
    const projectRoot = projectRootFromDbPath(db.dbPath);
    let reason: ProbeReason = 'no_tracked_rows';
    let fingerprint = '';
    if (hasTrackedRuntimeRows(db)) {
      fingerprint = cliConfigFingerprint(projectRoot);
      reason = startupProbeReason(readProbeCache(projectRoot), fingerprint, Date.now());
    }
    const probed = reason !== 'no_tracked_rows' && reason !== 'fingerprint_unchanged';
    const { transitions } = probed
      ? await probeAndReconcile(db, identity, projectRoot, fingerprint)
      : { transitions: reconcileCheatcodes(db, NO_EVIDENCE, { ...identity, now: nowISO() }) };
    serverLog({ kind: 'cheatcode_reconcile', transitions: transitions.length, probed, reason });
  } catch (e) {
    serverLog({ kind: 'cheatcode_reconcile', error_message: e instanceof Error ? e.message : String(e) });
  }
}
