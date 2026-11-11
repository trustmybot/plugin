// env_detect / env_record / env_get (GH 2066): a repo's toolchain evidence, read-only, and the repo_env profiles bro resolves from it.
import { statSync } from 'node:fs';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { nowISO, type TrajectoryDB } from '../db.js';
import { collectEnvEvidence } from '../env/collect.js';
import { normalizeAgent, requireRoles } from '../middleware/agent-scope.js';
import { repoRowPath } from '../utils/repo-paths.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

export const ENV_CATEGORIES = ['install', 'test', 'lint', 'format_check', 'typecheck'] as const;
export type EnvCategory = (typeof ENV_CATEGORIES)[number];
export const PROVENANCE_KINDS = ['existing_repo', 'existing_machine', 'workspace', 'web', 'model_knowledge'] as const;
export const ENV_STATUSES = ['ready', 'detected', 'missing_tool', 'stale'] as const;

export interface Provenance {
  kind: (typeof PROVENANCE_KINDS)[number];
  urls?: string[];
  fetched_at?: string;
  recheck?: string | boolean;
}

export interface CommandCandidate {
  command: string;
  source: string;
  confidence: number | string;
  probe: string | null;
  provenance: Provenance;
}

export type Commands = Record<EnvCategory, CommandCandidate[]>;
export type Overrides = Partial<Record<EnvCategory, CommandCandidate[]>>;

export interface Waiver {
  category: EnvCategory;
  reason: string;
  by: string;
  at: string;
}

export interface Declined {
  item: string;
  kind: string;
  reason: string;
  evidence_hash: string;
  at: string;
}

export interface RepoEnvRow {
  id: number;
  repo: string;
  package_path: string;
  ecosystem: string;
  package_manager: string;
  runner_prefix: string | null;
  commands_json: string;
  globs_json: string;
  status: string;
  confirmed_by: string | null;
  detected_at: string;
  evidence_hash: string;
  overrides_json: string | null;
  waivers_json: string | null;
  declined_json: string | null;
  updated_at: string;
}

class InvalidProfile extends Error {}

function fail(message: string): never {
  throw new InvalidProfile(message);
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function refuse(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], isError: true };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') fail(`${field} must be a non-empty string`);
  return v;
}

function optionalText(v: unknown, field: string): string | null {
  if (v === undefined || v === null) return null;
  return text(v, field);
}

function category(v: unknown, field: string): EnvCategory {
  if (typeof v !== 'string' || !(ENV_CATEGORIES as readonly string[]).includes(v)) {
    fail(`${field} must be one of ${ENV_CATEGORIES.join(', ')}`);
  }
  return v as EnvCategory;
}

function provenance(v: unknown, field: string): Provenance {
  if (!isRecord(v)) fail(`${field} must be {kind, urls?, fetched_at?, recheck?}`);
  const kind = v['kind'];
  if (typeof kind !== 'string' || !(PROVENANCE_KINDS as readonly string[]).includes(kind)) {
    fail(`${field}.kind must be one of ${PROVENANCE_KINDS.join(', ')}`);
  }
  const out: Provenance = { kind: kind as Provenance['kind'] };
  if (v['urls'] !== undefined) {
    const urls = v['urls'];
    if (!Array.isArray(urls) || urls.some((u) => typeof u !== 'string' || u.trim() === '')) fail(`${field}.urls must be a list of URLs`);
    out.urls = urls as string[];
  }
  if (v['fetched_at'] !== undefined) out.fetched_at = text(v['fetched_at'], `${field}.fetched_at`);
  if (v['recheck'] !== undefined) {
    const recheck = v['recheck'];
    if (typeof recheck !== 'boolean' && (typeof recheck !== 'string' || recheck.trim() === '')) fail(`${field}.recheck must be a string or boolean`);
    out.recheck = recheck as string | boolean;
  }
  if (out.kind === 'web' && (!out.urls || out.urls.length === 0 || !out.fetched_at)) fail(`${field}: a web provenance needs urls and fetched_at`);
  return out;
}

function candidates(v: unknown, field: string): CommandCandidate[] {
  if (!Array.isArray(v)) fail(`${field} must be a list of {command, source, confidence, probe, provenance}`);
  return v.map((c, i) => {
    const at = `${field}[${i}]`;
    if (!isRecord(c)) fail(`${at} must be {command, source, confidence, probe, provenance}`);
    const confidence = c['confidence'];
    const numeric = typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1;
    if (!numeric && (typeof confidence !== 'string' || confidence.trim() === '')) {
      fail(`${at}.confidence must be a number from 0 to 1 or a non-empty label`);
    }
    return {
      command: text(c['command'], `${at}.command`),
      source: text(c['source'], `${at}.source`),
      confidence: confidence as number | string,
      probe: optionalText(c['probe'], `${at}.probe`),
      provenance: provenance(c['provenance'], `${at}.provenance`),
    };
  });
}

function commands(v: unknown): Commands {
  if (!isRecord(v)) fail(`commands must be {${ENV_CATEGORIES.join(', ')}}`);
  for (const key of Object.keys(v)) category(key, `commands key '${key}'`);
  const out = {} as Commands;
  for (const c of ENV_CATEGORIES) out[c] = v[c] === undefined ? [] : candidates(v[c], `commands.${c}`);
  return out;
}

function inCategoryOrder(o: Overrides): Overrides {
  const out: Overrides = {};
  for (const c of ENV_CATEGORIES) if (o[c] !== undefined) out[c] = o[c];
  return out;
}

function mergeOverrides(stored: Overrides, v: unknown): Overrides {
  if (!isRecord(v)) fail('overrides must be {category: [candidate] | null}');
  const out: Overrides = { ...stored };
  for (const [key, list] of Object.entries(v)) {
    const c = category(key, `overrides key '${key}'`);
    if (list === null) delete out[c];
    else out[c] = candidates(list, `overrides.${c}`);
  }
  return inCategoryOrder(out);
}

function mergeWaivers(stored: Waiver[], v: unknown, agent: string, now: string): Waiver[] {
  if (!Array.isArray(v)) fail('waivers must be a list of {category, reason, by?, at?}');
  const byCategory = new Map(stored.map((w) => [w.category, w]));
  v.forEach((w, i) => {
    if (!isRecord(w)) fail(`waivers[${i}] must be {category, reason, by?, at?}`);
    const c = category(w['category'], `waivers[${i}].category`);
    byCategory.set(c, {
      category: c,
      reason: text(w['reason'], `waivers[${i}].reason`),
      by: optionalText(w['by'], `waivers[${i}].by`) ?? agent,
      at: optionalText(w['at'], `waivers[${i}].at`) ?? now,
    });
  });
  return ENV_CATEGORIES.filter((c) => byCategory.has(c)).map((c) => byCategory.get(c)!);
}

function mergeDeclined(stored: Declined[], v: unknown, evidenceHash: string, now: string): Declined[] {
  if (!Array.isArray(v)) fail('declined must be a list of {item, kind, reason, evidence_hash?, at?}');
  const key = (d: { kind: string; item: string }): string => `${d.kind}\0${d.item}`;
  const byKey = new Map(stored.map((d) => [key(d), d]));
  v.forEach((d, i) => {
    if (!isRecord(d)) fail(`declined[${i}] must be {item, kind, reason, evidence_hash?, at?}`);
    const entry: Declined = {
      item: text(d['item'], `declined[${i}].item`),
      kind: text(d['kind'], `declined[${i}].kind`),
      reason: text(d['reason'], `declined[${i}].reason`),
      evidence_hash: optionalText(d['evidence_hash'], `declined[${i}].evidence_hash`) ?? evidenceHash,
      at: optionalText(d['at'], `declined[${i}].at`) ?? now,
    };
    byKey.set(key(entry), entry);
  });
  return [...byKey.values()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

function globs(v: unknown): string[] {
  if (!Array.isArray(v) || v.some((g) => typeof g !== 'string' || g.trim() === '')) fail('globs must be a list of non-empty strings');
  return v as string[];
}

function status(v: unknown): string {
  if (typeof v !== 'string' || !(ENV_STATUSES as readonly string[]).includes(v)) fail(`status must be one of ${ENV_STATUSES.join(', ')}`);
  return v;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const SELECT_ROW = `SELECT * FROM repo_env WHERE repo = ? AND package_path = ? AND ecosystem = ?`;

const UPSERT = `INSERT INTO repo_env (repo, package_path, ecosystem, package_manager, runner_prefix, commands_json, globs_json,
                                      status, confirmed_by, detected_at, evidence_hash, overrides_json, waivers_json, declined_json, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (repo, package_path, ecosystem) DO UPDATE SET
                  package_manager = excluded.package_manager, runner_prefix = excluded.runner_prefix,
                  commands_json = excluded.commands_json, globs_json = excluded.globs_json, status = excluded.status,
                  confirmed_by = excluded.confirmed_by, detected_at = excluded.detected_at, evidence_hash = excluded.evidence_hash,
                  overrides_json = excluded.overrides_json, waivers_json = excluded.waivers_json,
                  declined_json = excluded.declined_json, updated_at = excluded.updated_at`;

// One profile's row values, its overrides, waivers and declined items merged onto the stored row's.
function profileValues(repo: string, p: unknown, i: number, stored: (pkg: string, eco: string) => RepoEnvRow | undefined, agent: string, now: string): unknown[] {
  if (!isRecord(p)) fail(`profiles[${i}] must be an object`);
  const packagePath = text(p['package_path'], `profiles[${i}].package_path`);
  const ecosystem = text(p['ecosystem'], `profiles[${i}].ecosystem`);
  const evidenceHash = text(p['evidence_hash'], `profiles[${i}].evidence_hash`);
  const row = stored(packagePath, ecosystem);
  const overrides =
    p['overrides'] === undefined
      ? row?.overrides_json ?? null
      : JSON.stringify(mergeOverrides(parseJson<Overrides>(row?.overrides_json ?? null, {}), p['overrides']));
  const waivers =
    p['waivers'] === undefined
      ? row?.waivers_json ?? null
      : JSON.stringify(mergeWaivers(parseJson<Waiver[]>(row?.waivers_json ?? null, []), p['waivers'], agent, now));
  const declined =
    p['declined'] === undefined
      ? row?.declined_json ?? null
      : JSON.stringify(mergeDeclined(parseJson<Declined[]>(row?.declined_json ?? null, []), p['declined'], evidenceHash, now));
  return [
    repo,
    packagePath,
    ecosystem,
    text(p['package_manager'], `profiles[${i}].package_manager`),
    optionalText(p['runner_prefix'], `profiles[${i}].runner_prefix`),
    JSON.stringify(commands(p['commands'])),
    JSON.stringify(globs(p['globs'])),
    status(p['status']),
    optionalText(p['confirmed_by'], `profiles[${i}].confirmed_by`),
    optionalText(p['detected_at'], `profiles[${i}].detected_at`) ?? now,
    evidenceHash,
    overrides,
    waivers,
    declined,
    now,
  ];
}

export function effectiveCommands(commandsJson: string, overridesJson: string | null): Commands {
  const base = parseJson<Partial<Commands>>(commandsJson, {});
  const over = parseJson<Overrides>(overridesJson, {});
  const out = {} as Commands;
  for (const c of ENV_CATEGORIES) out[c] = over[c] ?? base[c] ?? [];
  return out;
}

export function repoEnvView(row: RepoEnvRow): Record<string, unknown> {
  return {
    repo: row.repo,
    package_path: row.package_path,
    ecosystem: row.ecosystem,
    package_manager: row.package_manager,
    runner_prefix: row.runner_prefix,
    commands: parseJson(row.commands_json, {}),
    globs: parseJson(row.globs_json, []),
    status: row.status,
    confirmed_by: row.confirmed_by,
    detected_at: row.detected_at,
    evidence_hash: row.evidence_hash,
    overrides: parseJson(row.overrides_json, null),
    waivers: parseJson(row.waivers_json, null),
    declined: parseJson(row.declined_json, null),
    updated_at: row.updated_at,
    effective_commands: effectiveCommands(row.commands_json, row.overrides_json),
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    package_path: { type: 'string', description: "The env_detect package_path ('.' is the repo root)." },
    ecosystem: { type: 'string' },
    package_manager: { type: 'string' },
    runner_prefix: { type: ['string', 'null'] },
    commands: {
      type: 'object',
      description: '{install, test, lint, format_check, typecheck}: each a list of {command, source, confidence, probe, provenance {kind, urls?, fetched_at?, recheck?}}.',
    },
    globs: { type: 'array', items: { type: 'string' } },
    status: { type: 'string', enum: [...ENV_STATUSES] },
    confirmed_by: { type: ['string', 'null'] },
    detected_at: { type: 'string' },
    evidence_hash: { type: 'string' },
    overrides: { type: 'object', description: '{category: [candidate] | null}; null drops that override.' },
    waivers: { type: 'array', items: { type: 'object' }, description: '[{category, reason, by?, at?}]' },
    declined: { type: 'array', items: { type: 'object' }, description: '[{item, kind, reason, evidence_hash?, at?}]' },
  },
  required: ['package_path', 'ecosystem', 'package_manager', 'commands', 'globs', 'status', 'evidence_hash'],
};

export function envTools(db: TrajectoryDB): { definitions: Tool[]; handlers: Record<string, Fn> } {
  const definitions: Tool[] = [
    {
      name: 'env_detect',
      description: "Any agent: a repo's toolchain evidence per package root, read without running anything.",
      inputSchema: {
        type: 'object',
        properties: {
          repo: {
            type: 'string',
            description:
              'A repos row name. Returns packages (manifests, lockfiles, configs, CI steps, runner targets, dev deps with file:line, evidence_hash) and stored (each repo_env row, drifted when its hash differs).',
          },
        },
        required: ['repo'],
      },
    },
    {
      name: 'env_record',
      description: 'bro only: upsert repo_env profiles; returns the recorded row ids.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string' },
          profiles: {
            type: 'array',
            items: PROFILE_SCHEMA,
            description:
              'Keyed by (repo, package_path, ecosystem). commands and the other columns are replaced; overrides, waivers and declined change only when passed and merge per key.',
          },
        },
        required: ['repo', 'profiles'],
      },
    },
    {
      name: 'env_get',
      description: 'Any agent: repo_env profiles with effective_commands (overrides over commands).',
      inputSchema: {
        type: 'object',
        properties: { repo: { type: 'string', description: 'Omitted, every repo.' } },
      },
    },
  ];

  const repoRow = (name: string): { name: string; path: string } | undefined =>
    db.get<{ name: string; path: string }>(`SELECT name, path FROM repos WHERE name = ?`, [name]);

  const handlers: Record<string, Fn> = {
    env_detect: async (args) => {
      const repo = typeof args['repo'] === 'string' ? args['repo'].trim() : '';
      if (!repo) return refuse({ error: 'invalid_args', message: 'repo is required' });
      const row = repoRow(repo);
      if (!row) return refuse({ error: 'repo_not_found', repo });
      const root = repoRowPath(db, row.path);
      if (!isDirectory(root)) return refuse({ error: 'repo_path_missing', repo, path: root });
      const packages = collectEnvEvidence(root);
      const current = new Map(packages.map((p) => [p.package_path, p.evidence_hash]));
      const stored = db
        .all<{ package_path: string; ecosystem: string; evidence_hash: string }>(
          `SELECT package_path, ecosystem, evidence_hash FROM repo_env WHERE repo = ? ORDER BY package_path, ecosystem`,
          [repo],
        )
        .map((s) => {
          const now = current.get(s.package_path) ?? null;
          return { ...s, current_hash: now, drifted: now !== s.evidence_hash };
        });
      return ok({ repo, path: root, packages, stored });
    },

    env_record: requireRoles('env_record', ['bro'], async (args) => {
      const repo = typeof args['repo'] === 'string' ? args['repo'].trim() : '';
      const profiles = args['profiles'];
      if (!repo || !Array.isArray(profiles) || profiles.length === 0) {
        return refuse({ error: 'invalid_args', message: 'repo and a non-empty profiles list are required' });
      }
      if (!repoRow(repo)) return refuse({ error: 'repo_not_found', repo });
      const agent = normalizeAgent(args['agent']);
      const now = nowISO();
      try {
        const recorded = db.transaction(() =>
          profiles.map((p, i) => {
            const values = profileValues(repo, p, i, (pkg, eco) => db.get<RepoEnvRow>(SELECT_ROW, [repo, pkg, eco]), agent, now);
            const existed = db.get<{ id: number }>(SELECT_ROW, [repo, values[1], values[2]]);
            db.run(UPSERT, values);
            const id = db.get<{ id: number }>(SELECT_ROW, [repo, values[1], values[2]])!.id;
            return { id, package_path: values[1], ecosystem: values[2], created: existed === undefined };
          }),
        );
        return ok({ repo, recorded });
      } catch (e) {
        if (e instanceof InvalidProfile) return refuse({ error: 'invalid_profile', message: e.message });
        return refuse({ error: 'record_failed', message: (e as Error).message });
      }
    }),

    env_get: async (args) => {
      const repo = typeof args['repo'] === 'string' && args['repo'].trim() ? args['repo'].trim() : null;
      const rows = repo
        ? db.all<RepoEnvRow>(`SELECT * FROM repo_env WHERE repo = ? ORDER BY package_path, ecosystem`, [repo])
        : db.all<RepoEnvRow>(`SELECT * FROM repo_env ORDER BY repo, package_path, ecosystem`);
      return ok({ ...(repo ? { repo } : {}), profiles: rows.map(repoEnvView) });
    },
  };

  return { definitions, handlers };
}
