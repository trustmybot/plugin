/**
 * SubagentStop hook (GH 1692), the port of scripts/hooks/swe-atomic-close.sh:
 * the atomic-close safety net and per-spawn metering for swe, and per-spawn
 * metering for code-reviewer. It never denies.
 *
 * Task binding: the `task_id=<N>` of the spawn transcript, for a task in any
 * status. A swe transcript with no task id, or an id with no task row, writes
 * one agent_runs_capture_skipped audit row and stops; an unbound
 * code-reviewer spawn stops silently.
 *
 * Decision matrix (swe only):
 *   running + checkpoint from this run  → status stays running, additionalContext
 *                                         to resume swe from task_brief.checkpoint
 *   pending|running + commits           → status completed + commit_sha, checkpoint
 *                                         cleared + swe_atomic_close_auto_completed audit
 *   pending|running + no commits        → additionalContext warning to bro
 *   any other status                    → metrics only
 *   any status + stop_cause hook_block  → additionalContext names the block
 *   code-reviewer                       → metrics only
 *   any other subagent_type             → exit 0
 *
 * The transcript reduction follows the .sh's `jq -rsc` program value for
 * value, `0|0|0|0|0|0||` wherever jq would have stopped on an error. The
 * recorders swe-stop-cause and tool-output-size run in-process, each with its
 * own env as the .sh's separate node processes have. Log lines go to
 * <state dir>/logs/mcp-health.log, rotated at 1 MB.
 *
 * Divergence (decision 703): the .sh exits 0 without jq or the sqlite3 CLI;
 * this gate needs neither.
 */
import { appendFileSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync } from 'node:fs';
import type { SyncGate } from './gate.js';
import { pluginVersion, jqCompare, jqIntText } from './bro-turn-usage.js';
import { taskLocation } from './lib/agent-context.js';
import { auditAppend, auditSql, dbWrite, nowIso } from './lib/audit.js';
import { branchSlug, dbPath, haveSqlite, projectRoot, realdir, sqliteRo, sqlInt, sqlQuote, stateDir, stripTrailingNewlines, taskIdFromTranscript } from './lib/db.js';
import { effortDefaults } from './lib/effort.js';
import { cdPwd, gitOk, gitOut, isDir } from './lib/git.js';
import { byteCompare, commandSubstitution } from './lib/host.js';
import { jqCompact, jsonStream } from './lib/jq.js';
import { jqCapture, jqGet, jqInput, jqNumber, jqRaw, JqUnindexable, type JqInput } from './lib/jq-raw.js';
import { posixDirname, shellPwd } from './lib/project-env.js';
import { repoDefaultBranch, repoResolve } from './lib/repo.js';
import { normalizeRole } from './lib/role.js';
import { sweStopCause } from './swe-stop-cause.js';
import { toolOutputSize } from './tool-output-size.js';

export const GATE_NAME = 'swe-atomic-close';

const FROM_NODE = 'hook:swe-atomic-close';
const LOG_ROTATE_BYTES = 1048576;
const NO_STATS = '0|0|0|0|0|0||';
const ISO = /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(\.([0-9]+))?Z\n?$/;
const STAMP_PARTS = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})\.([0-9]{3})Z$/;
const MODEL_STRIP = /[^A-Za-z0-9._:@/[\]-]/gu;
const DBL_MAX = Number.MAX_VALUE;
const RUN_NO_USAGE_SQL =
  'COALESCE(tokens_in, 0) = 0 AND COALESCE(tokens_out, 0) = 0 AND COALESCE(cache_read_tokens, 0) = 0 AND COALESCE(cache_creation_tokens, 0) = 0';
const RUN_UNMEASURED_SQL = `usage_source = COALESCE(usage_source, CASE WHEN ${RUN_NO_USAGE_SQL} THEN 'unmeasured' END)`;

class JqError extends Error {}

const isRawJson = (value: unknown): boolean =>
  (JSON as unknown as { isRawJSON?: (v: unknown) => boolean }).isRawJSON?.(value) ?? false;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function truthy(v: unknown): boolean {
  return v !== null && v !== undefined && v !== false;
}

function index(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new JqError(`Cannot index with ${key}`);
  const v = (value as Record<string, unknown>)[key];
  return v === undefined ? null : v;
}

function isoStamp(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = ISO.exec(v);
  return m === null ? null : `${m[1]}.${`${m[3] ?? ''}000`.slice(0, 3)}Z`;
}

/** `ms` of a normalized stamp: macOS strptime's field ranges, then timegm as jq 1.7.1 runs it. */
function stampMs(stamp: string): number {
  const m = STAMP_PARTS.exec(stamp);
  if (m === null) throw new JqError('ms');
  const [year, month, day, hour, minute, second, frac] = m.slice(1).map(Number);
  if (month < 1 || month > 12 || day > 31 || hour > 23 || minute > 59 || second > 60) throw new JqError('strptime');
  if (year < 1900) throw new JqError('invalid gmtime representation');
  const t = Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
  if (t === -1 || t === -2) throw new JqError('mktime');
  return t * 1000 + frac;
}

function clamp(v: number): number {
  return v === Infinity ? DBL_MAX : v === -Infinity ? -DBL_MAX : v;
}

function n(v: unknown): number {
  return typeof v === 'number' && clamp(v) >= 0 ? Math.floor(clamp(v)) : 0;
}

function model(v: unknown): string {
  return typeof v === 'string' && !v.startsWith('<') ? v.replace(MODEL_STRIP, '') : '';
}

function sum(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((s, v) => s + v);
}

function stableSort<T>(items: T[], key: (item: T) => unknown): T[] {
  return items
    .map((item, i) => ({ item, i, k: key(item) }))
    .sort((a, b) => jqCompare(a.k, b.k) || a.i - b.i)
    .map((e) => e.item);
}

function groupBy<T>(items: T[], key: (item: T) => unknown): T[][] {
  const groups: T[][] = [];
  for (const item of stableSort(items, key)) {
    const g = groups.at(-1);
    if (g !== undefined && jqCompare(key(g[0]), key(item)) === 0) g.push(item);
    else groups.push([item]);
  }
  return groups;
}

interface Msg {
  u: unknown;
  m: string;
}

function reduceStats(all: unknown[], since: string): string {
  const values =
    since === ''
      ? all
      : all.filter((v) => {
          const t = isoStamp(index(v, 'timestamp'));
          return t !== null && byteCompare(t, since) >= 0;
        });
  const stamps = values.map((v) => isoStamp(index(v, 'timestamp'))).filter((s): s is string => s !== null);
  const entries: { id: unknown; u: unknown; m: string }[] = [];
  values.forEach((v, i) => {
    const usage = index(index(v, 'message'), 'usage');
    if (usage === null) return;
    const mid = index(index(v, 'message'), 'id');
    const uuid = index(v, 'uuid');
    const id = truthy(mid) ? mid : truthy(uuid) ? uuid : `line-${i}`;
    entries.push({ id, u: usage, m: model(index(index(v, 'message'), 'model')) });
  });
  const msgs: Msg[] = groupBy(entries, (e) => e.id).map((g) => ({ u: g[g.length - 1].u, m: g[g.length - 1].m }));
  let allToolUses = 0;
  for (const v of values) {
    const raw = index(index(v, 'message'), 'content');
    const content = truthy(raw) ? raw : [];
    if (!Array.isArray(content)) continue;
    for (const block of content) if (index(block, 'type') === 'tool_use') allToolUses += 1;
  }
  const col = (key: string): number => sum(msgs.map((m) => n(index(m.u, key)))) ?? 0;
  const ti = col('input_tokens');
  const to = col('output_tokens');
  const cr = col('cache_read_input_tokens');
  const cc = col('cache_creation_input_tokens');
  const ms = stamps.map(stampMs);
  const dm = ms.length < 2 ? 0 : ms.reduce((a, b) => Math.max(a, b)) - ms.reduce((a, b) => Math.min(a, b));
  const weighted = msgs
    .filter((m) => m.m !== '')
    .map((m) => ({
      m: m.m,
      t: sum(['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].map((k) => n(index(m.u, k)))) as number,
    }));
  const byModel = groupBy(weighted, (w) => w.m).map((g) => ({ m: g[0].m, t: sum(g.map((w) => w.t)) as number }));
  const ranked = stableSort(byModel, (w) => [-w.t, w.m]);
  const dominant = ranked.length === 0 ? '' : ranked[0].m;
  const first = stamps.length === 0 ? '' : [...stamps].sort(byteCompare)[0];
  return [jqIntText(ti), jqIntText(to), String(allToolUses), jqIntText(dm), jqIntText(cr), jqIntText(cc), first, dominant].join('|');
}

/** tmb_parse_transcript_stats <path> [<since>]: `ti|to|tool_uses|duration_ms|cr|cc|first_ts|model`. */
export function transcriptStats(path: string, since = ''): string {
  if (path === '' || !isFile(path)) return NO_STATS;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return NO_STATS;
  }
  return transcriptStatsOf(text, since);
}

/** The stats of a transcript's text, as the .sh's jq program prints them. */
export function transcriptStatsOf(text: string, since = ''): string {
  const { values, complete } = jsonStream(text);
  if (!complete) return NO_STATS;
  try {
    return reduceStats(values, since);
  } catch (e) {
    if (e instanceof JqError) return NO_STATS;
    throw e;
  }
}

function scalarPaths(value: unknown, path: string[], out: string[]): void {
  if (value !== null && typeof value === 'object' && !isRawJson(value)) {
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
    for (const [k, v] of entries) scalarPaths(v, [...path, k], out);
    return;
  }
  if (path.length > 0 && truthy(value)) out.push(path.join('.'));
}

/** `[paths(scalars) | join(".")] | unique // []` of one value, compact. */
export function entryKeys(value: unknown): string {
  const out: string[] = [];
  scalarPaths(value, [], out);
  return jqCompact([...new Set(out)].sort(byteCompare));
}

/** What `--argjson keys "$(jq … || echo '[]')"` accepts, or null where it fails and no entry line is written. */
function entryKeysArg(input: JqInput): unknown[] | null {
  if (input.values.length === 0) return input.complete ? null : [];
  if (input.values.length > 1 || !input.complete) return null;
  return JSON.parse(entryKeys(input.values[0])) as unknown[];
}

/** `jq -r '.agent_type // .subagent_type // .tool_input.subagent_type // empty'`, as `$(...)` holds it. */
function entryAgent(input: JqInput): string {
  const lines: string[] = [];
  for (const value of input.values) {
    try {
      for (const keys of [['agent_type'], ['subagent_type'], ['tool_input', 'subagent_type']]) {
        const v = jqGet(value, ...keys);
        if (truthy(v)) {
          lines.push(jqRaw(v));
          break;
        }
      }
    } catch (e) {
      if (!(e instanceof JqUnindexable)) throw e;
    }
  }
  return stripTrailingNewlines(lines.join('\n'));
}

/** `echo <text> | cut -d'|' -f<field>`, as `$(...)` holds it. */
function cutField(text: string, field: number): string {
  const lines = text.split('\n').map((line) => (line.includes('|') ? (line.split('|')[field - 1] ?? '') : line));
  return stripTrailingNewlines(lines.join('\n'));
}

function secondsIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** `cd <path> && pwd -P`, or "" when the cd fails. */
function physicalDir(path: string, env: NodeJS.ProcessEnv): string {
  const logical = cdPwd(path, shellPwd(env));
  try {
    return realpathSync.native(logical !== '' && isDir(logical) ? logical : path);
  } catch {
    return '';
  }
}

class Log {
  constructor(private readonly file: string | null) {}

  write(record: Record<string, unknown>): void {
    if (this.file === null) return;
    try {
      appendFileSync(this.file, `${jqCompact(record)}\n`);
    } catch {
      /* a log line never fails the hook */
    }
  }

  static open(env: NodeJS.ProcessEnv): Log {
    const dir = stateDir(env);
    if (dir === null) return new Log(null);
    try {
      mkdirSync(`${dir}/logs`, { recursive: true });
    } catch {
      return new Log(null);
    }
    const file = `${dir}/logs/mcp-health.log`;
    try {
      if (statSync(file).isFile() && statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`);
    } catch {
      /* no log yet */
    }
    return new Log(file);
  }
}

interface Out {
  stdout: string;
}

function write(db: string, sql: string, env: NodeJS.ProcessEnv, out: Out): boolean {
  const r = dbWrite(db, sql, { caller: GATE_NAME, env });
  out.stdout += r.stdout;
  if (!r.ok) process.stderr.write(`${r.error}\n`);
  return r.ok;
}

function runRecorder(recorder: (payload: string, env: NodeJS.ProcessEnv) => unknown, payload: string, env: NodeJS.ProcessEnv): void {
  try {
    recorder(payload, env);
  } catch {
    /* a recorder never fails the hook */
  }
}

function skipUnbound(db: string, transcript: string, spawnId: string, taskId: string, env: NodeJS.ProcessEnv, out: Out): void {
  const reason =
    taskId === '' ? 'no task_id=<N> in the spawn transcript' : `spawn transcript names task_id=${taskId}, which has no task row`;
  const content = jqCompact({ reason, transcript, spawn_id: spawnId, task_id: taskId === '' ? null : jqNumber(taskId) });
  const r = auditAppend(
    db,
    {
      issueId: '-1',
      branchId: '',
      fromNode: FROM_NODE,
      eventType: 'agent_runs_capture_skipped',
      summary: `SWE spawn not metered: ${reason}`,
      contentJson: content,
    },
    { caller: GATE_NAME, env },
  );
  out.stdout += r.stdout;
  if (!r.ok) process.stderr.write(`${r.error}\n`);
}

export const sweAtomicClose: SyncGate = (payload, env) => {
  const inputText = commandSubstitution(payload);
  const input = jqInput(payload);
  const log = Log.open(env);
  const keys = entryKeysArg(input);
  const entryAgentRaw = entryAgent(input);
  if (keys !== null) {
    log.write({ ts: secondsIso(), kind: 'swe-atomic-close-entry', keys, agent_type_resolved: entryAgentRaw });
  }

  const agentType = normalizeRole(entryAgentRaw);
  if (agentType !== 'swe' && agentType !== 'code-reviewer') return { stdout: '', code: 0 };

  const db = dbPath(env) ?? '';
  if (db === '' || !haveSqlite(env)) return { stdout: '', code: 0 };

  const out: Out = { stdout: '' };
  const transcriptPath = jqCapture(input, ['agent_transcript_path']);
  const agentId = jqCapture(input, ['agent_id']);
  const sessionId = jqCapture(input, ['session_id']);
  const spawnId = agentId || transcriptPath;

  const transcriptTaskId = sqlInt(taskIdFromTranscript(transcriptPath));
  const row =
    transcriptTaskId === ''
      ? ''
      : sqliteRo(
          db,
          `SELECT id, status, branch_id, COALESCE(parent_branch_id, ''), COALESCE(repo, ''), issue_id FROM tasks
      WHERE id = ${transcriptTaskId} LIMIT 1;`,
          env,
        );

  if (row === '') {
    if (agentType === 'swe') skipUnbound(db, transcriptPath, spawnId, transcriptTaskId, env, out);
    return { stdout: out.stdout, code: 0 };
  }

  const taskId = sqlInt(cutField(row, 1));
  if (taskId === '') return { stdout: out.stdout, code: 0 };
  const taskStatus = cutField(row, 2);
  const branch = cutField(row, 3);
  const parentBranch = cutField(row, 4);
  const issueId = cutField(row, 6);

  const ts = secondsIso();

  const resumedSince =
    agentType === 'swe'
      ? sqliteRo(
          db,
          `
SELECT CASE WHEN resumed_from IS NOT NULL THEN started_at END FROM agent_runs
 WHERE task_id = ${taskId} AND agent_type = 'swe' AND spawn_id = '${sqlQuote(spawnId)}'
 ORDER BY id DESC LIMIT 1;`,
          env,
        )
      : '';
  const stats = transcriptStats(transcriptPath, resumedSince);
  const [tokensIn, tokensOut, toolUses, durationMs, cacheRead, cacheCreation, firstTs, model] = stats.split('|');
  log.write({ ts, kind: 'agent-runs-stats-parsed', task_id: jqNumber(taskId), stats, transcript: transcriptPath });

  const safeTaskId = taskId;
  const safeIssueId = sqlInt(issueId) || 'NULL';
  const safeTokensIn = sqlInt(tokensIn) || '0';
  const safeTokensOut = sqlInt(tokensOut) || '0';
  const safeCacheRead = sqlInt(cacheRead) || '0';
  const safeCacheCreation = sqlInt(cacheCreation) || '0';
  const safeToolUses = sqlInt(toolUses) || '0';
  const safeDurationMs = sqlInt(durationMs) || '0';
  const safeSpawnId = sqlQuote(spawnId);
  let safeNow = sqlQuote(nowIso());
  const safeFirstTs = sqlQuote(firstTs || nowIso());
  const sessionSql = sessionId !== '' ? `'${sqlQuote(sessionId)}'` : 'NULL';
  const modelSql = model !== '' ? `'${sqlQuote(model)}'` : 'NULL';
  const version = pluginVersion(env);
  const versionSql = version !== '' ? `'${sqlQuote(version)}'` : 'NULL';

  const measured = /[^0]/.test(`${safeTokensIn}${safeTokensOut}${safeCacheRead}${safeCacheCreation}`);
  const tokensSetSql = measured
    ? `tokens_in = ${safeTokensIn},
       tokens_out = ${safeTokensOut},
       cache_read_tokens = ${safeCacheRead},
       cache_creation_tokens = ${safeCacheCreation}`
    : `tokens_in = COALESCE(tokens_in, 0),
       tokens_out = COALESCE(tokens_out, 0),
       cache_read_tokens = COALESCE(cache_read_tokens, 0),
       cache_creation_tokens = COALESCE(cache_creation_tokens, 0)`;
  const usageSetSql = measured ? "usage_source = 'subagent_stop'" : RUN_UNMEASURED_SQL;
  const usageInsertSql = measured ? "'subagent_stop'" : "'unmeasured'";

  if (agentType === 'code-reviewer') {
    const defaults = effortDefaults(db, env);
    const reviewerEffort = defaults.includes('|') ? defaults.slice(defaults.indexOf('|') + 1) : defaults;
    const effortSql = ['low', 'medium', 'high'].includes(reviewerEffort) ? `'${reviewerEffort}'` : 'NULL';
    const safeProjectRoot = sqlQuote(physicalDir(`${posixDirname(db)}/../..`, env));
    const ok = write(
      db,
      `
UPDATE agent_runs
   SET ${tokensSetSql},
       tool_uses = ${safeToolUses},
       duration_ms = ${safeDurationMs},
       completed_at = '${safeNow}',
       session_id = COALESCE(${sessionSql}, session_id),
       ${usageSetSql},
       model = COALESCE(${modelSql}, model),
       effort = COALESCE(effort, ${effortSql})
 WHERE task_id = ${safeTaskId} AND agent_type = 'code-reviewer' AND spawn_id = '${safeSpawnId}';
INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, cache_read_tokens,
                        cache_creation_tokens, tool_uses, duration_ms, started_at, completed_at,
                        repo, spawn_id, session_id, usage_source, model, host, root_dir, exit_reason, effort,
                        plugin_version)
SELECT ${safeTaskId}, ${safeIssueId}, 'code-reviewer', ${safeTokensIn}, ${safeTokensOut}, ${safeCacheRead},
       ${safeCacheCreation}, ${safeToolUses}, ${safeDurationMs}, '${safeFirstTs}', '${safeNow}',
       (SELECT repo FROM tasks WHERE id = ${safeTaskId}), '${safeSpawnId}', ${sessionSql}, ${usageInsertSql},
       ${modelSql}, 'claude', '${safeProjectRoot}', 'completed', ${effortSql},
       ${versionSql}
 WHERE (SELECT changes()) = 0;`,
      env,
      out,
    );
    if (!ok) log.write({ ts, kind: 'agent-runs-write-failed', task_id: jqNumber(taskId), agent_type: 'code-reviewer' });
    runRecorder(toolOutputSize, inputText, {
      ...env,
      TMB_STOP_AGENT_TYPE: 'code-reviewer',
      TMB_STOP_TASK_ID: safeTaskId,
      TMB_STOP_SPAWN_ID: spawnId,
    });
    return { stdout: out.stdout, code: 0 };
  }

  const location = taskLocation(db, taskId, env);
  let repoRoot = location.code === 0 ? location.repoRoot : '';
  if (repoRoot === '') repoRoot = projectRoot(env);
  repoRoot = realdir(repoRoot);
  const wtPath = `${repoRoot}/.claude/worktrees/${branchSlug(branch)}`;
  const safeRootDir = sqlQuote(wtPath);

  let wtHead = gitOut(wtPath, ['rev-parse', 'HEAD'], env);
  const headWithin = (head: string, ...tips: string[]): boolean =>
    tips.some((tip) => tip !== '' && gitOk(repoRoot, ['merge-base', '--is-ancestor', head, tip], env));
  const verify = (ref: string): string => gitOut(repoRoot, ['rev-parse', '-q', '--verify', `${ref}^{commit}`], env);

  let hasCommits = false;
  let parentTipLocal = '';
  let parentTipOrigin = '';
  if (parentBranch !== '') {
    parentTipLocal = verify(`refs/heads/${parentBranch}`);
    parentTipOrigin = verify(`refs/remotes/origin/${parentBranch}`);
  }
  if (wtHead !== '') {
    let headInParent = false;
    if (`${parentTipLocal}${parentTipOrigin}` !== '') {
      if (headWithin(wtHead, parentTipLocal, parentTipOrigin)) headInParent = true;
      else hasCommits = true;
    }
    if (!hasCommits && !headInParent) {
      const localFeature = verify(`refs/heads/${branch}`);
      if (localFeature !== '' && !headWithin(wtHead, localFeature)) hasCommits = true;
      if (!hasCommits && parentBranch === '' && localFeature !== '' && wtHead === localFeature) {
        let base = cutField(repoResolve(db, repoRoot, env), 1);
        if (base === '') base = repoDefaultBranch(repoRoot, env);
        if (base !== '') {
          parentTipLocal = verify(`refs/heads/${base}`);
          parentTipOrigin = verify(`refs/remotes/origin/${base}`);
          let ahead = gitOut(wtPath, ['rev-list', '--count', `origin/${base}..HEAD`], env);
          if (ahead === '') ahead = gitOut(wtPath, ['rev-list', '--count', `${base}..HEAD`], env);
          if (!/^[0-9]+$/.test(ahead)) ahead = '0';
          if (Number(ahead) > 0 && !headWithin(wtHead, parentTipLocal, parentTipOrigin)) hasCommits = true;
        }
      }
    }
  } else {
    const rootBranch = gitOut(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], env);
    if (rootBranch === branch && `${parentTipLocal}${parentTipOrigin}` !== '') {
      const rootHead = gitOut(repoRoot, ['rev-parse', 'HEAD'], env);
      if (rootHead !== '' && !headWithin(rootHead, parentTipLocal, parentTipOrigin)) {
        hasCommits = true;
        wtHead = rootHead;
      }
    }
  }

  let decision: string;
  let context = '';
  const checkpointed =
    taskStatus === 'running'
      ? sqliteRo(
          db,
          `
SELECT 1 FROM tasks
 WHERE id = ${safeTaskId} AND json_valid(checkpoint)
   AND json_extract(checkpoint, '$.at') >= '${safeFirstTs}';`,
          env,
        )
      : '';

  if (checkpointed === '1') {
    decision = 'checkpoint';
    context = `SWE for task #${taskId} handed back a checkpoint; the task stays running. Resume swe on it: a fresh spawn reads task_brief.checkpoint (done, left, files) and continues from there.`;
  } else if (taskStatus === 'pending' || taskStatus === 'running') {
    if (hasCommits) {
      decision = 'auto-completed';
      const safeWtHead = sqlQuote(wtHead);
      safeNow = sqlQuote(nowIso());
      const closeJson = jqCompact({
        task_id: jqNumber(safeTaskId),
        commit_sha: wtHead,
        parent_tip_local: parentTipLocal === '' ? null : parentTipLocal,
        parent_tip_origin: parentTipOrigin === '' ? null : parentTipOrigin,
      });
      const audit = auditSql(
        {
          issueId: safeIssueId,
          branchId: branch,
          fromNode: FROM_NODE,
          eventType: 'swe_atomic_close_auto_completed',
          summary: `Task #${safeTaskId} auto-completed at ${wtHead} on SubagentStop`,
          contentJson: closeJson,
        },
        '(SELECT changes()) > 0',
        { caller: GATE_NAME, env },
      );
      if (audit.code !== 0) process.stderr.write(`${audit.error}\n`);
      const closeAuditSql = audit.code === 0 ? audit.sql : '';
      const closed = write(
        db,
        `UPDATE tasks SET status='completed', commit_sha='${safeWtHead}', updated_at='${safeNow}', completed_at='${safeNow}', checkpoint=NULL WHERE id=${safeTaskId};
${closeAuditSql}`,
        env,
        out,
      );
      if (!closed) decision = 'auto-complete-failed';
    } else {
      decision = 'warn-no-commits';
      context = `SWE for task #${taskId} stopped without committing in worktree at ${wtPath}. Bro should send SWE back or mark the task failed.`;
    }
  } else {
    decision = 'metrics-only';
  }

  const exitReason =
    decision === 'auto-completed' || ['completed', 'closed', 'needs_validation'].includes(taskStatus)
      ? 'completed'
      : taskStatus === 'escalated'
        ? 'escalated'
        : 'failed';

  const runWritten = write(
    db,
    `
UPDATE agent_runs
   SET ${tokensSetSql},
       tool_uses = ${safeToolUses},
       duration_ms = ${safeDurationMs},
       started_at = COALESCE(started_at, '${safeFirstTs}'),
       completed_at = '${safeNow}',
       spawn_id = '${safeSpawnId}',
       session_id = COALESCE(${sessionSql}, session_id),
       ${usageSetSql},
       model = COALESCE(${modelSql}, model),
       host = COALESCE(host, 'claude'),
       root_dir = COALESCE(root_dir, '${safeRootDir}'),
       exit_reason = '${exitReason}',
       effort = COALESCE(effort, (SELECT effort FROM tasks WHERE id = ${safeTaskId}))
 WHERE id = (
   SELECT id FROM agent_runs
    WHERE task_id = ${safeTaskId}
      AND (spawn_id = '${safeSpawnId}'
           OR ((spawn_id IS NULL OR spawn_id GLOB 'tool_use:*') AND agent_type = 'swe'
               AND (completed_at IS NULL
                    OR started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', '${safeFirstTs}', '-2 seconds'))))
    ORDER BY (spawn_id IS '${safeSpawnId}') DESC, id DESC
    LIMIT 1);
INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, cache_read_tokens,
                        cache_creation_tokens, tool_uses, duration_ms, started_at, completed_at,
                        repo, spawn_id, session_id, usage_source, model, host, root_dir, exit_reason, effort,
                        plugin_version)
SELECT ${safeTaskId}, ${safeIssueId}, 'swe', ${safeTokensIn}, ${safeTokensOut}, ${safeCacheRead},
       ${safeCacheCreation}, ${safeToolUses}, ${safeDurationMs}, '${safeFirstTs}', '${safeNow}',
       (SELECT repo FROM tasks WHERE id = ${safeTaskId}), '${safeSpawnId}', ${sessionSql}, ${usageInsertSql},
       ${modelSql}, 'claude', '${safeRootDir}', '${exitReason}', (SELECT effort FROM tasks WHERE id = ${safeTaskId}),
       ${versionSql}
 WHERE (SELECT changes()) = 0;
UPDATE agent_runs
   SET usage_source = 'unmeasured',
       exit_reason = COALESCE(exit_reason, 'swept_orphan'),
       completed_at = COALESCE(completed_at, '${safeNow}')
 WHERE task_id = ${safeTaskId}
   AND agent_type = 'swe'
   AND ((spawn_id IS NULL
         AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', '${safeFirstTs}', '-2 seconds'))
        OR (spawn_id GLOB 'tool_use:*' AND completed_at IS NULL
            AND started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 seconds')))
   AND COALESCE(tokens_in, 0) = 0 AND COALESCE(tokens_out, 0) = 0
   AND COALESCE(cache_read_tokens, 0) = 0 AND COALESCE(cache_creation_tokens, 0) = 0
   AND COALESCE(usage_source, '') <> 'subagent_stop';`,
    env,
    out,
  );
  if (!runWritten) log.write({ ts, kind: 'agent-runs-write-failed', task_id: jqNumber(taskId) });

  const stop = { TMB_STOP_TASK_ID: safeTaskId, TMB_STOP_SPAWN_ID: spawnId, TMB_STOP_SINCE: safeFirstTs };
  runRecorder(sweStopCause, inputText, { ...env, ...stop });
  runRecorder(toolOutputSize, inputText, { ...env, TMB_STOP_AGENT_TYPE: 'swe', ...stop });

  const hookBlock = sqliteRo(
    db,
    `
SELECT CASE WHEN stop_cause = 'hook_block' THEN 'B' || COALESCE(substr(stop_detail, 1, 200), '') END
  FROM agent_runs
 WHERE task_id = ${safeTaskId} AND agent_type = 'swe' AND spawn_id = '${safeSpawnId}'
 ORDER BY id DESC LIMIT 1;`,
    env,
  );
  if (hookBlock.startsWith('B')) {
    const detail = hookBlock.slice(1).replaceAll('\n', ' ');
    const blockContext = `SWE for task #${taskId} ended on a hook block with no completion report ("${detail}"), which task_brief.last_stop carries; name the block in the rework spawn_note so the next swe applies the allowed form and continues.`;
    context = context === '' ? blockContext : `${context} ${blockContext}`;
  }

  if (decision === 'auto-completed' || decision === 'auto-complete-failed') {
    log.write({ ts, kind: 'swe-atomic-close', task_id: jqNumber(taskId), branch, decision, commit_sha: wtHead });
  } else {
    log.write({ ts, kind: 'swe-atomic-close', task_id: jqNumber(taskId), branch, decision, worktree: wtPath });
  }

  if (context !== '') {
    out.stdout += `${jqCompact({ hookSpecificOutput: { hookEventName: 'SubagentStop', additionalContext: context } })}\n`;
  }
  return { stdout: out.stdout, code: 0 };
};
