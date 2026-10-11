import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { TrajectoryDB } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { insertAudit } from './audit.js';
import { projectRootFromDbPath } from './containment.js';
import { resolveRepoPath, taskWorktreePath } from './composites.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;
type Rec = Record<string, unknown>;

const UNBOUND_SAMPLE = 20;
const BACKFILL_AGENTS = new Set(['swe', 'pr-reviewer']);

// Parses a JSONL transcript; unparsable lines are dropped.
function readRecords(path: string): Rec[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: Rec[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Rec);
    } catch {
      continue;
    }
  }
  return out;
}

function messageOf(r: Rec): Rec | null {
  const m = r['message'];
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as Rec) : null;
}

// The hooks' tmb_task_id_from_transcript: the first `task_id=<N>` in the
// transcript's message content, string or block array (blocks are matched in
// their JSON form). Scanning stops at the first unparsable line, as jq does.
export function taskIdFromTranscript(path: string): number | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      return null;
    }
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) return null;
    const msg = (rec as Rec)['message'];
    if (msg !== undefined && msg !== null && (typeof msg !== 'object' || Array.isArray(msg))) return null;
    const raw = msg ? (msg as Rec)['content'] : undefined;
    const content = raw === undefined || raw === null || raw === false ? [] : raw;
    const s = typeof content === 'string' ? content : JSON.stringify(content);
    const m = /task_id=([0-9]+)/.exec(s);
    if (m) return Number(m[1]);
  }
  return null;
}

// 24-char ms-ISO, or null for anything that is not a UTC ISO timestamp.
function isoMs(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(\.([0-9]+))?Z$/.exec(v);
  if (!m) return null;
  return `${m[1]}.${((m[3] ?? '') + '000').slice(0, 3)}Z`;
}

function nonNegInt(v: unknown): number {
  return typeof v === 'number' && v >= 0 ? Math.floor(v) : 0;
}

function modelId(v: unknown): string {
  if (typeof v !== 'string' || v.startsWith('<')) return '';
  return v.replace(/[^A-Za-z0-9._:@/[\]-]/g, '');
}

function toolUseCount(r: Rec): number {
  const content = messageOf(r)?.['content'];
  if (!Array.isArray(content)) return 0;
  return content.filter((b) => b && typeof b === 'object' && (b as Rec)['type'] === 'tool_use').length;
}

interface Usage {
  ti: number;
  to: number;
  cr: number;
  cc: number;
}

function usageOf(u: unknown): Usage {
  const o = (u && typeof u === 'object' ? u : {}) as Rec;
  return {
    ti: nonNegInt(o['input_tokens']),
    to: nonNegInt(o['output_tokens']),
    cr: nonNegInt(o['cache_read_input_tokens']),
    cc: nonNegInt(o['cache_creation_input_tokens']),
  };
}

function usageTotal(u: Usage): number {
  return u.ti + u.to + u.cr + u.cc;
}

function messageKey(r: Rec, i: number): string {
  const id = messageOf(r)?.['id'] ?? r['uuid'];
  return id === undefined || id === null || id === false ? `line-${i}` : String(id);
}

function dominantModel(msgs: Array<{ m: string; u: Usage }>): string | null {
  const byModel = new Map<string, number>();
  for (const x of msgs) {
    if (x.m === '') continue;
    byModel.set(x.m, (byModel.get(x.m) ?? 0) + usageTotal(x.u));
  }
  const ranked = [...byModel].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return ranked[0]?.[0] ?? null;
}

export interface SpawnStats extends Usage {
  tool_uses: number;
  duration_ms: number;
  first_ts: string | null;
  last_ts: string | null;
  model: string | null;
}

// The SubagentStop hook's tmb_parse_transcript_stats: usage grouped by
// message id (the last usage of a group wins), every tool_use block counted,
// duration = last − first timestamp, model = the one with the most tokens.
export function spawnStats(records: Rec[]): SpawnStats {
  const stamps = records.map((r) => isoMs(r['timestamp'])).filter((s): s is string => s !== null).sort();
  const groups = new Map<string, { u: Usage; m: string }>();
  records.forEach((r, i) => {
    const msg = messageOf(r);
    if (!msg || msg['usage'] === undefined || msg['usage'] === null) return;
    groups.set(messageKey(r, i), { u: usageOf(msg['usage']), m: modelId(msg['model']) });
  });
  const msgs = [...groups.values()];
  const sum = (k: keyof Usage) => msgs.reduce((a, x) => a + x.u[k], 0);
  const first = stamps[0] ?? null;
  const last = stamps[stamps.length - 1] ?? null;
  return {
    ti: sum('ti'),
    to: sum('to'),
    cr: sum('cr'),
    cc: sum('cc'),
    tool_uses: records.reduce((a, r) => a + toolUseCount(r), 0),
    duration_ms: stamps.length < 2 ? 0 : Date.parse(last!) - Date.parse(first!),
    first_ts: first,
    last_ts: last,
    model: dominantModel(msgs),
  };
}

interface SessionMessage {
  ts: string;
  u: Usage;
  m: string;
  tu: number;
}

// The bro Stop hook's parse: main-loop (non-sidechain) messages with usage,
// grouped by message id (earliest timestamp, last usage, summed tool_use).
function sessionMessages(records: Rec[]): SessionMessage[] {
  const groups = new Map<string, SessionMessage>();
  records.forEach((r, i) => {
    const msg = messageOf(r);
    if (r['isSidechain'] === true || !msg || msg['usage'] === undefined || msg['usage'] === null) return;
    const ts = isoMs(r['timestamp']);
    if (ts === null) return;
    const key = messageKey(r, i);
    const prev = groups.get(key);
    groups.set(key, {
      ts: prev && prev.ts < ts ? prev.ts : ts,
      u: usageOf(msg['usage']),
      m: modelId(msg['model']),
      tu: (prev?.tu ?? 0) + toolUseCount(r),
    });
  });
  return [...groups.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

function normalizeRole(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v.slice(v.indexOf(':') + 1) : null;
}

// subagent_type of each spawn of a session, keyed by the spawn's agent id
// (the Agent tool_use id → its result's agentId).
function sessionSpawnTypes(records: Rec[]): Map<string, string> {
  const byToolUse = new Map<string, string>();
  const out = new Map<string, string>();
  for (const r of records) {
    const content = messageOf(r)?.['content'];
    if (!Array.isArray(content)) continue;
    for (const b of content as Rec[]) {
      if (b?.['type'] === 'tool_use' && typeof b['id'] === 'string') {
        const t = (b['input'] as Rec | undefined)?.['subagent_type'];
        if (typeof t === 'string') byToolUse.set(b['id'], t);
      }
    }
  }
  for (const r of records) {
    const agentId = (r['toolUseResult'] as Rec | undefined)?.['agentId'];
    const content = messageOf(r)?.['content'];
    if (typeof agentId !== 'string' || !Array.isArray(content)) continue;
    for (const b of content as Rec[]) {
      const t = typeof b?.['tool_use_id'] === 'string' ? byToolUse.get(b['tool_use_id'] as string) : undefined;
      if (t) out.set(agentId, t);
    }
  }
  return out;
}

// ~/.claude/projects/<slug>: Claude Code's per-project transcript dir, slug =
// the project path with every non-alphanumeric character replaced by '-'.
export function defaultTranscriptsDir(projectRoot: string): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude');
  return join(configDir, 'projects', projectRoot.replace(/[^A-Za-z0-9]/g, '-'));
}

interface Transcripts {
  sessions: string[];
  subagents: Array<{ path: string; session: string }>;
}

function listTranscripts(dir: string): Transcripts {
  const sessions: string[] = [];
  const subagents: Array<{ path: string; session: string }> = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (name.endsWith('.jsonl')) {
      sessions.push(p);
      continue;
    }
    const sub = join(p, 'subagents');
    if (!existsSync(sub) || !statSync(sub).isDirectory()) continue;
    for (const f of readdirSync(sub).sort()) {
      if (/^agent-.+\.jsonl$/.test(f)) subagents.push({ path: join(sub, f), session: name });
    }
  }
  return { sessions, subagents };
}

function spawnAgentType(path: string, sessionTypes: Map<string, string> | undefined): string | null {
  const meta = path.replace(/\.jsonl$/, '.meta.json');
  if (existsSync(meta)) {
    try {
      const t = normalizeRole((JSON.parse(readFileSync(meta, 'utf8')) as Rec)['agentType']);
      if (t) return t;
    } catch {
      // fall through to the parent session
    }
  }
  return normalizeRole(sessionTypes?.get(agentIdOf(path)));
}

function agentIdOf(path: string): string {
  return basename(path).replace(/^agent-/, '').replace(/\.jsonl$/, '');
}

export interface BackfillReport {
  dry_run: boolean;
  transcripts_dir: string;
  transcripts_seen: number;
  sessions_seen: number;
  bound: number;
  unbound: { count: number; first: Array<{ path: string; reason: string }> };
  rows_inserted: number;
  rows_updated: number;
  rows_skipped_measured: number;
  tokens_total_added: number;
}

interface RunRow {
  id: number;
  task_id: number | null;
  agent_type: string;
  started_at: string | null;
  completed_at: string | null;
  spawn_id: string | null;
  session_id: string | null;
  usage_source: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
}

const RUN_COLS =
  'id, task_id, agent_type, started_at, completed_at, spawn_id, session_id, usage_source, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens';

const MEASURED_SOURCES = new Set(['transcript', 'subagent_stop', 'backfill']);

// Measured: a meter wrote it, or it carries tokens with no usage_source
// (pre-v33 data). 'unmeasured' rows and source-less zero rows are backfillable.
function isMeasured(r: RunRow): boolean {
  if (r.usage_source !== null && MEASURED_SOURCES.has(r.usage_source)) return true;
  if (r.usage_source === 'unmeasured') return false;
  return (r.tokens_in ?? 0) + (r.tokens_out ?? 0) + (r.cache_read_tokens ?? 0) + (r.cache_creation_tokens ?? 0) > 0;
}

function exitReasonFor(status: string): string {
  if (status === 'completed' || status === 'closed' || status === 'needs_validation') return 'completed';
  if (status === 'escalated') return 'escalated';
  return 'failed';
}

type Write =
  | { kind: 'insert'; values: unknown[] }
  | { kind: 'update_spawn'; id: number; values: unknown[] }
  | { kind: 'update_bro'; id: number; session: string; u: Usage; tu: number; model: string | null };

export interface BackfillOptions {
  dryRun: boolean;
  since: string | null;
  transcriptsDir: string;
  now: string;
}

export function agentRunsBackfill(db: TrajectoryDB, opts: BackfillOptions): BackfillReport {
  const { sessions, subagents } = listTranscripts(opts.transcriptsDir);
  const report: BackfillReport = {
    dry_run: opts.dryRun,
    transcripts_dir: opts.transcriptsDir,
    transcripts_seen: 0,
    sessions_seen: 0,
    bound: 0,
    unbound: { count: 0, first: [] },
    rows_inserted: 0,
    rows_updated: 0,
    rows_skipped_measured: 0,
    tokens_total_added: 0,
  };
  const writes: Write[] = [];
  const unbound = (path: string, reason: string) => {
    report.unbound.count++;
    if (report.unbound.first.length < UNBOUND_SAMPLE) report.unbound.first.push({ path, reason });
  };
  const sessionRecords = new Map<string, Rec[]>();
  for (const p of sessions) sessionRecords.set(basename(p, '.jsonl'), readRecords(p));
  const spawnTypes = new Map<string, Map<string, string>>();
  const claimedRunIds = new Set<number>();
  const plannedSwe: Array<{ id: number | null; task_id: number; started_at: string; completed_at: string }> = [];

  for (const { path, session } of subagents) {
    const records = readRecords(path);
    const stats = spawnStats(records);
    if (opts.since && (stats.last_ts === null || stats.last_ts < opts.since)) continue;
    report.transcripts_seen++;
    if (!spawnTypes.has(session)) spawnTypes.set(session, sessionSpawnTypes(sessionRecords.get(session) ?? []));
    const agentType = spawnAgentType(path, spawnTypes.get(session));
    if (!agentType || !BACKFILL_AGENTS.has(agentType)) {
      unbound(path, `subagent_type ${agentType ?? 'unknown'} is not swe or pr-reviewer`);
      continue;
    }
    const taskId = taskIdFromTranscript(path);
    if (taskId === null) {
      unbound(path, 'no task_id=<N> in the spawn prompt');
      continue;
    }
    const task = db.get<{ id: number; issue_id: number; branch_id: string; status: string; repo: string | null }>(
      'SELECT id, issue_id, branch_id, status, repo FROM tasks WHERE id = ?',
      [taskId],
    );
    if (!task) {
      unbound(path, `task_id=${taskId} has no task row`);
      continue;
    }
    if (stats.first_ts === null || stats.last_ts === null) {
      unbound(path, 'transcript carries no timestamps');
      continue;
    }
    report.bound++;
    const keyed = db.get<RunRow>(
      'SELECT ' + RUN_COLS + ' FROM agent_runs WHERE task_id = ? AND spawn_id IN (?, ?) ORDER BY id LIMIT 1',
      [task.id, path, agentIdOf(path)],
    );
    const inWindow = keyed
      ? []
      : db
          .all<RunRow>(
            'SELECT ' + RUN_COLS + ` FROM agent_runs
              WHERE task_id = ? AND agent_type = ? AND spawn_id IS NULL
                AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-2 seconds') AND started_at <= ?
              ORDER BY id DESC`,
            [task.id, agentType, stats.first_ts, stats.last_ts],
          )
          .filter((r) => !claimedRunIds.has(r.id));
    const target = keyed ?? inWindow.find((r) => !isMeasured(r)) ?? inWindow[0];
    if (target && isMeasured(target)) {
      report.rows_skipped_measured++;
      continue;
    }
    const tokens = usageTotal(stats);
    report.tokens_total_added += tokens;
    const repoPath = resolveRepoPath(db, task.repo);
    const rootDir = repoPath?.startsWith('/') ? taskWorktreePath(repoPath, task.branch_id) : null;
    if (target) {
      claimedRunIds.add(target.id);
      report.rows_updated++;
      if (agentType === 'swe') {
        plannedSwe.push({ id: target.id, task_id: task.id, started_at: target.started_at ?? stats.first_ts, completed_at: stats.last_ts });
      }
      writes.push({
        kind: 'update_spawn',
        id: target.id,
        values: [stats.ti, stats.to, stats.cr, stats.cc, stats.tool_uses, stats.duration_ms, stats.first_ts, stats.last_ts,
          path, session, stats.model, rootDir, exitReasonFor(task.status), target.id],
      });
    } else {
      report.rows_inserted++;
      if (agentType === 'swe') {
        plannedSwe.push({ id: null, task_id: task.id, started_at: stats.first_ts, completed_at: stats.last_ts });
      }
      writes.push({
        kind: 'insert',
        values: [task.id, task.issue_id, agentType, stats.ti, stats.to, stats.cr, stats.cc, stats.tool_uses,
          stats.duration_ms, stats.first_ts, stats.last_ts, task.repo, path, session, stats.model, rootDir,
          exitReasonFor(task.status)],
      });
    }
  }

  planBroRows(db, sessionRecords, plannedSwe, opts, report, writes);

  if (!opts.dryRun) {
    db.transaction(() => {
      applyWrites(db, writes, opts.now);
      insertAudit(db, {
        issue_id: -1,
        from_node: 'bro',
        event_type: 'agent_runs_backfilled',
        summary: `agent_runs backfill: ${report.rows_inserted} inserted, ${report.rows_updated} updated from ${report.transcripts_seen} transcripts`,
        content_json: JSON.stringify(report),
        created_at: opts.now,
      });
    });
  }
  return report;
}

// Bro rows: the Stop hook's window rule over each session transcript, applied
// to the session's bro rows (those stamped with it, plus unstamped rows that
// started inside it), writing only the rows still unmeasured.
function planBroRows(
  db: TrajectoryDB,
  sessionRecords: Map<string, Rec[]>,
  plannedSwe: Array<{ id: number | null; task_id: number; started_at: string; completed_at: string }>,
  opts: BackfillOptions,
  report: BackfillReport,
  writes: Write[],
): void {
  const spans: Array<{ session: string; first: string; last: string; msgs: SessionMessage[] }> = [];
  for (const [session, records] of sessionRecords) {
    const stamps = records.map((r) => isoMs(r['timestamp'])).filter((s): s is string => s !== null).sort();
    if (stamps.length === 0) continue;
    const last = stamps[stamps.length - 1]!;
    if (opts.since && last < opts.since) continue;
    report.sessions_seen++;
    spans.push({ session, first: stamps[0]!, last, msgs: sessionMessages(records) });
  }
  const legacyOwner = new Map<number, { session: string; first: string }>();
  for (const s of spans) {
    const rows = db.all<{ id: number }>(
      `SELECT id FROM agent_runs
        WHERE agent_type = 'bro' AND session_id IS NULL AND started_at IS NOT NULL
          AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-2 seconds') AND started_at <= ?`,
      [s.first, s.last],
    );
    for (const r of rows) {
      const prev = legacyOwner.get(r.id);
      if (!prev || prev.first < s.first) legacyOwner.set(r.id, { session: s.session, first: s.first });
    }
  }

  for (const s of spans) {
    const legacyIds = [...legacyOwner].filter(([, o]) => o.session === s.session).map(([id]) => id);
    const runs = db.all<RunRow & { window_start: string; running_since: string | null }>(
      `SELECT r.id, r.task_id, r.agent_type, r.started_at, r.completed_at, r.spawn_id, r.session_id, r.usage_source,
              r.tokens_in, r.tokens_out, r.cache_read_tokens, r.cache_creation_tokens, strftime('%Y-%m-%dT%H:%M:%fZ', r.started_at, '-2 seconds') AS window_start,
              CASE WHEN t.status = 'running' THEN t.updated_at END AS running_since
         FROM agent_runs r LEFT JOIN tasks t ON t.id = r.task_id
        WHERE r.agent_type = 'bro' AND r.started_at IS NOT NULL
          AND (r.session_id = ? OR r.id IN (SELECT value FROM json_each(?)))`,
      [s.session, JSON.stringify(legacyIds)],
    );
    if (runs.length === 0) continue;
    const taskIds = JSON.stringify([...new Set(runs.map((r) => r.task_id))]);
    const sweRows = db.all<{ id: number; task_id: number; started_at: string; completed_at: string | null }>(
      `SELECT id, task_id, started_at, completed_at FROM agent_runs
        WHERE agent_type = 'swe' AND started_at IS NOT NULL AND task_id IN (SELECT value FROM json_each(?))`,
      [taskIds],
    );
    const planned = new Map(plannedSwe.filter((p) => p.id !== null).map((p) => [p.id!, p]));
    const sweRuns = [
      ...sweRows.map((r) => planned.get(r.id) ?? r),
      ...plannedSwe.filter((p) => p.id === null),
    ];
    const briefs = db.all<{ task_id: number; created_at: string }>(
      `SELECT CAST(json_extract(content_json, '$.task_id') AS INTEGER) AS task_id, created_at FROM audit
        WHERE event_type = 'swe_brief_fetched'
          AND CAST(json_extract(content_json, '$.task_id') AS INTEGER) IN (SELECT value FROM json_each(?))`,
      [taskIds],
    );
    const owned = new Map<number, { u: Usage; tu: number; models: Map<string, number> }>();
    for (const m of s.msgs) {
      let best: { id: number; key: [number, string, string, number] } | null = null;
      for (const r of runs) {
        if (!(r.window_start <= m.ts && (r.completed_at === null || m.ts < r.completed_at))) continue;
        const active =
          (r.running_since !== null && r.running_since <= m.ts) ||
          sweRuns.some((w) => w.task_id === r.task_id && w.started_at <= m.ts && (w.completed_at === null || m.ts < w.completed_at));
        const briefedAt = briefs
          .filter((b) => b.task_id === r.task_id && b.created_at <= m.ts)
          .reduce((a, b) => (b.created_at > a ? b.created_at : a), '');
        const key: [number, string, string, number] = [active ? 1 : 0, briefedAt, r.started_at!, r.id];
        if (!best || compareKey(key, best.key) > 0) best = { id: r.id, key };
      }
      if (!best) continue;
      const acc = owned.get(best.id) ?? { u: { ti: 0, to: 0, cr: 0, cc: 0 }, tu: 0, models: new Map<string, number>() };
      acc.u.ti += m.u.ti;
      acc.u.to += m.u.to;
      acc.u.cr += m.u.cr;
      acc.u.cc += m.u.cc;
      acc.tu += m.tu;
      if (m.m !== '') acc.models.set(m.m, (acc.models.get(m.m) ?? 0) + usageTotal(m.u));
      owned.set(best.id, acc);
    }
    for (const r of runs) {
      if (isMeasured(r)) {
        report.rows_skipped_measured++;
        continue;
      }
      const acc = owned.get(r.id) ?? { u: { ti: 0, to: 0, cr: 0, cc: 0 }, tu: 0, models: new Map<string, number>() };
      const model = [...acc.models].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0] ?? null;
      report.rows_updated++;
      report.tokens_total_added += usageTotal(acc.u);
      writes.push({ kind: 'update_bro', id: r.id, session: s.session, u: acc.u, tu: acc.tu, model });
    }
  }
}

// ORDER BY active DESC, briefed_at DESC, started_at DESC, run_id DESC.
function compareKey(a: [number, string, string, number], b: [number, string, string, number]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}

function applyWrites(db: TrajectoryDB, writes: Write[], now: string): void {
  for (const w of writes) {
    if (w.kind === 'insert') {
      db.run(
        `INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, cache_read_tokens,
                                 cache_creation_tokens, tool_uses, duration_ms, started_at, completed_at, repo,
                                 spawn_id, session_id, usage_source, model, host, root_dir, exit_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backfill', ?, 'claude', ?, ?)`,
        w.values,
      );
    } else if (w.kind === 'update_spawn') {
      db.run(
        `UPDATE agent_runs
            SET tokens_in = ?, tokens_out = ?, cache_read_tokens = ?, cache_creation_tokens = ?,
                tool_uses = ?, duration_ms = ?,
                started_at = COALESCE(started_at, ?), completed_at = ?,
                spawn_id = COALESCE(spawn_id, ?), session_id = COALESCE(session_id, ?),
                usage_source = 'backfill', model = COALESCE(?, model), host = COALESCE(host, 'claude'),
                root_dir = COALESCE(root_dir, ?), exit_reason = COALESCE(exit_reason, ?)
          WHERE id = ?`,
        w.values,
      );
    } else {
      db.run(
        `UPDATE agent_runs
            SET tokens_in = ?, tokens_out = ?, cache_read_tokens = ?, cache_creation_tokens = ?, tool_uses = ?,
                duration_ms = MAX(0, CAST(ROUND((julianday(COALESCE(completed_at, ?)) - julianday(started_at)) * 86400000) AS INTEGER)),
                session_id = COALESCE(session_id, ?), usage_source = 'backfill', model = COALESCE(?, model),
                host = COALESCE(host, 'claude')
          WHERE id = ?`,
        [w.u.ti, w.u.to, w.u.cr, w.u.cc, w.tu, now, w.session, w.model, w.id],
      );
    }
  }
}

function okResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function errResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

export function agentRunsBackfillTools(
  db: TrajectoryDB,
  dbPath: string,
): { definitions: Tool[]; handlers: Record<string, Fn> } {
  const definitions: Tool[] = [
    {
      name: 'agent_runs_backfill',
      description:
        "Recover swe/pr-reviewer/bro agent_runs from Claude Code transcripts on disk (read-only) as usage_source='backfill'; never overwrites measured rows; idempotent. dry_run (default true) only reports.",
      inputSchema: {
        type: 'object',
        properties: {
          dry_run: { type: 'boolean', description: 'Report only, write nothing (default true).' },
          since: { type: 'string', description: 'ISO timestamp: skip transcripts whose last message is older.' },
          transcripts_dir: { type: 'string', description: 'Override ~/.claude/projects/<project-slug>.' },
        },
      },
    },
  ];

  const handlers: Record<string, Fn> = {
    agent_runs_backfill: requireRoles('agent_runs_backfill', ['bro'], async (args) => {
      try {
        const dryRun = args['dry_run'] !== false;
        const sinceArg = args['since'];
        let since: string | null = null;
        if (sinceArg !== undefined && sinceArg !== null) {
          const t = typeof sinceArg === 'string' ? Date.parse(sinceArg) : NaN;
          if (Number.isNaN(t)) return errResult('since must be an ISO timestamp');
          since = new Date(t).toISOString();
        }
        let dir = typeof args['transcripts_dir'] === 'string' && args['transcripts_dir'] !== '' ? args['transcripts_dir'] : null;
        if (dir === null) {
          const root = projectRootFromDbPath(dbPath || db.dbPath);
          if (!root) return errResult('no project root for this DB; pass transcripts_dir');
          dir = defaultTranscriptsDir(root);
        }
        if (!existsSync(dir) || !statSync(dir).isDirectory()) return errResult(`transcripts_dir not found: ${dir}`);
        return okResult(agentRunsBackfill(db, { dryRun, since, transcriptsDir: dir, now: new Date().toISOString() }));
      } catch (e) {
        return errResult((e as Error).message);
      }
    }),
  };

  return { definitions, handlers };
}
