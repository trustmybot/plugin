/**
 * Stop hook (GH 1692): the
 * session's one bro agent_runs row (task_id and issue_id NULL) rewritten with
 * the sums of the transcript's main-loop assistant usage, inserted when
 * absent, in one tmb_db_write transaction. The transcript reduction follows
 * a jq program value for value: lines grouped by message id in jq's
 * order (last usage wins, tool_use blocks summed), numbers floored and
 * printed as jq prints them, the model with the most tokens, and no write
 * when jq would have stopped on an error. Bypass:
 * TMB_DISABLE_BRO_TURN_USAGE_HOOK=1. It never denies; a failed write is one
 * stderr line. After a written row it runs the tool-output-size recorder on
 * the session row (GH 1957), fail-open.
 *
 * It runs async (decision 937), so Stop runs of one session can overlap: a run
 * holding an older transcript read must not overwrite a newer one, so the
 * UPDATE skips a row whose completed_at is later than this run's. A lost run
 * is recovered by the next, whose row is always the sums over the whole
 * transcript.
 *
 * Each run reads only the transcript bytes appended since the last (GH 2699).
 * A per-session cursor at <dirname(db)>/bro-turn-usage/<session_id>.json holds
 * the byte offset past the last complete line read and the partial reduction
 * up to it; a run folds the new lines into it and finishes the same row a full
 * read would. A missing, corrupt or mismatched cursor (other transcript, file
 * shorter than the offset, changed head bytes) or a tail that does not parse
 * falls back to the full read, which rewrites the cursor. A cursor is replaced
 * only by one at or past its offset unless it no longer fits the transcript as
 * it is at save time. A transcript read error writes nothing (GH 2711).
 *
 * It needs neither jq nor the sqlite3 CLI (node:sqlite writes the row).
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ALLOW, type SyncGate } from './gate.js';
import { dbWrite } from './lib/audit.js';
import { dbLocation, dbPath, sqlQuote, stripTrailingNewlines } from './lib/db.js';
import { byteCompare, commandSubstitution } from './lib/host.js';
import { jsonStream, jsonValues } from './lib/jq.js';
import { jqRawText, posixDirname } from './lib/project-env.js';
import { completedAfter, toolOutputSize, TOOL_OUTPUT_COMPLETED_AT_ENV } from './tool-output-size.js';

export const GATE_NAME = 'bro-turn-usage';

const ISO = /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(\.([0-9]+))?Z\n?$/;
const STAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const MODEL_STRIP = /[^A-Za-z0-9._:@/[\]-]/gu;
const DBL_MAX = Number.MAX_VALUE;
const CURSOR_VERSION = 1;
const CURSOR_DIR = 'bro-turn-usage';
const HEAD_BYTES = 4096;
const SAFE_SESSION = /^[A-Za-z0-9_-]{1,128}$/;

class JqError extends Error {}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function index(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new JqError(`Cannot index with ${key}`);
  const v = (value as Record<string, unknown>)[key];
  return v === undefined ? null : v;
}

function truthy(v: unknown): boolean {
  return v !== null && v !== undefined && v !== false;
}

/** `jq -r '.<key> // <fallback>'` over every value of <text>, as `$(...)` captures it. */
export function jqKeyOr(text: string, key: string, fallback: string): string {
  const out: string[] = [];
  for (const value of jsonValues(text)) {
    try {
      const v = index(value, key);
      out.push(truthy(v) ? jqRawText(v) : fallback);
    } catch (e) {
      if (!(e instanceof JqError)) throw e;
    }
  }
  return stripTrailingNewlines(out.join('\n'));
}

function typeRank(v: unknown): number {
  if (v === null) return 0;
  if (v === false) return 1;
  if (v === true) return 2;
  if (typeof v === 'number') return 3;
  if (typeof v === 'string') return 4;
  return Array.isArray(v) ? 5 : 6;
}

/** jq's total order of JSON values. */
export function jqCompare(a: unknown, b: unknown): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 3) return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  if (ra === 4) return byteCompare(a as string, b as string);
  if (ra === 5) {
    const x = a as unknown[];
    const y = b as unknown[];
    for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
      const c = jqCompare(x[i], y[i]);
      if (c !== 0) return c;
    }
    return x.length - y.length;
  }
  if (ra === 6) {
    const x = a as Record<string, unknown>;
    const y = b as Record<string, unknown>;
    const kx = Object.keys(x).sort(byteCompare);
    const ky = Object.keys(y).sort(byteCompare);
    const c = jqCompare(kx, ky);
    if (c !== 0) return c;
    for (const k of kx) {
      const d = jqCompare(x[k], y[k]);
      if (d !== 0) return d;
    }
  }
  return 0;
}

/** jq's number literal clamp: JSON.parse's ±Infinity is ±DBL_MAX in jq. */
function jqNumber(v: number): number {
  return v === Infinity ? DBL_MAX : v === -Infinity ? -DBL_MAX : v;
}

/** `n`: a number ≥ 0 floored, anything else 0. */
function n(v: unknown): number {
  return typeof v === 'number' && jqNumber(v) >= 0 ? Math.floor(jqNumber(v)) : 0;
}

/** `tostring` of an integer-valued double as jq 1.7 prints it (shortest digits, exponent past 15 padding zeros). */
export function jqIntText(x: number): string {
  if (Object.is(x, -0)) return '-0';
  if (!Number.isFinite(x)) return x > 0 ? '1.7976931348623157e+308' : '-1.7976931348623157e+308';
  if (x === 0) return '0';
  const sign = x < 0 ? '-' : '';
  const [mant, exp] = Math.abs(x).toExponential().split('e');
  const digits = mant.replace('.', '');
  const decpt = Number(exp) + 1;
  if (decpt > digits.length + 15 || decpt <= -4) {
    const e = Number(exp);
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${m}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  }
  if (decpt >= digits.length) return `${sign}${digits}${'0'.repeat(decpt - digits.length)}`;
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}

function iso(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = ISO.exec(v);
  if (m === null) return null;
  return `${m[1]}.${`${m[3] ?? ''}000`.slice(0, 3)}Z`;
}

function model(v: unknown): string {
  return typeof v === 'string' && !v.startsWith('<') ? v.replace(MODEL_STRIP, '') : '';
}

function add(values: number[]): number {
  return values.reduce((s, v) => s + v);
}

export interface TurnUsage {
  first: string;
  last: string;
  tokensIn: string;
  tokensOut: string;
  cacheRead: string;
  cacheCreation: string;
  toolUses: string;
  model: string;
}

interface Counts {
  ti: number;
  to: number;
  cr: number;
  cc: number;
}

/**
 * A message id as JSON that decodes to a value jqCompare holds equal to it;
 * its text is the group key: ['n', digits], ['a', ...items], ['o', ...[key, value]] in byte order.
 */
type IdCode = null | boolean | string | IdCode[];

/** One message id's group: the last entry's usage counts (null where indexing them errors) and model, the summed tool_use blocks. */
interface Group {
  id: unknown;
  code: IdCode;
  counts: Counts | null;
  m: string;
  tu: number;
}

/** The reduction of a transcript prefix: main-loop values seen, ISO stamp bounds, a jq error, the message groups. */
export interface UsageFold {
  main: number;
  first: string | null;
  last: string | null;
  failed: boolean;
  groups: Map<string, Group>;
}

class CursorError extends Error {}

const utf8 = (s: string): string => Buffer.from(s, 'utf8').toString('utf8');

function encodeId(v: unknown): IdCode {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return ['n', String(v)];
  if (typeof v === 'string') return utf8(v);
  if (Array.isArray(v)) return ['a', ...v.map(encodeId)];
  const o = v as Record<string, unknown>;
  const fields = Object.keys(o).map((k): [string, IdCode] => [utf8(k), encodeId(o[k])]);
  return ['o', ...fields.sort((a, b) => byteCompare(a[0], b[0]))];
}

function decodeId(c: unknown): unknown {
  if (c === null || typeof c === 'boolean' || typeof c === 'string') return c;
  if (!Array.isArray(c)) throw new CursorError('id');
  const [tag, ...rest] = c as unknown[];
  if (tag === 'n' && rest.length === 1 && typeof rest[0] === 'string' && String(Number(rest[0])) === rest[0]) return Number(rest[0]);
  if (tag === 'a') return rest.map(decodeId);
  if (tag === 'o') {
    return Object.fromEntries(
      rest.map((f) => {
        if (!Array.isArray(f) || f.length !== 2 || typeof f[0] !== 'string') throw new CursorError('id field');
        return [f[0], decodeId(f[1])];
      }),
    );
  }
  throw new CursorError('id tag');
}

export function emptyFold(): UsageFold {
  return { main: 0, first: null, last: null, failed: false, groups: new Map() };
}

function toolUses(message: unknown): number {
  let content = index(message, 'content');
  if (!truthy(content)) content = [];
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const block of content) if (index(block, 'type') === 'tool_use') count += 1;
  return count;
}

function counts(usage: unknown): Counts | null {
  try {
    return {
      ti: n(index(usage, 'input_tokens')),
      to: n(index(usage, 'output_tokens')),
      cr: n(index(usage, 'cache_read_input_tokens')),
      cc: n(index(usage, 'cache_creation_input_tokens')),
    };
  } catch (e) {
    if (e instanceof JqError) return null;
    throw e;
  }
}

function foldEntry(s: UsageFold, v: Record<string, unknown>, i: number, ts: string | null): void {
  const message = v.message;
  const usage = index(message, 'usage');
  if (usage === null) return;
  const mid = index(message, 'id');
  const id = truthy(mid) ? mid : truthy(v.uuid) ? v.uuid : `line-${i}`;
  const m = model(index(message, 'model'));
  const tu = toolUses(message);
  if (ts === null) return;
  const code = encodeId(id);
  const key = JSON.stringify(code);
  const g = s.groups.get(key);
  if (g === undefined) {
    s.groups.set(key, { id, code, counts: counts(usage), m, tu });
  } else {
    g.counts = counts(usage);
    g.m = m;
    g.tu += tu;
  }
}

/** Folds transcript values into <s> in file order; jq's group_by keeps file order within a group, so the last line wins. */
export function foldUsage(s: UsageFold, values: unknown[]): void {
  for (const v of values) {
    if (s.failed) return;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) continue;
    const o = v as Record<string, unknown>;
    if (truthy(o.isSidechain) || o.message === undefined || o.message === null) continue;
    const i = s.main;
    s.main += 1;
    const ts = iso(o.timestamp);
    if (ts !== null && (s.first === null || byteCompare(ts, s.first) < 0)) s.first = ts;
    if (ts !== null && (s.last === null || byteCompare(ts, s.last) > 0)) s.last = ts;
    try {
      foldEntry(s, o, i, ts);
    } catch (e) {
      if (!(e instanceof JqError)) throw e;
      s.failed = true;
    }
  }
}

/** The row of a finished fold, null where the jq program prints nothing (or stops on an error). */
export function finishUsage(s: UsageFold): TurnUsage | null {
  if (s.failed) return null;
  const groups = [...s.groups.values()].sort((a, b) => jqCompare(a.id, b.id));
  const rows: Array<Counts & { tu: number; m: string }> = [];
  for (const g of groups) {
    if (g.counts === null) return null;
    rows.push({ ...g.counts, tu: g.tu, m: g.m });
  }
  const byModel = new Map<string, number>();
  for (const r of rows) {
    if (r.m === '') continue;
    const tok = r.ti + r.to + r.cr + r.cc;
    byModel.set(r.m, byModel.has(r.m) ? (byModel.get(r.m) as number) + tok : tok);
  }
  const ranked = [...byModel.entries()].sort((a, b) => jqCompare([-a[1], a[0]], [-b[1], b[0]]));
  if (ranked.length === 0 || !(add(rows.map((r) => r.to)) > 0)) return null;
  return {
    first: s.first ?? '',
    last: s.last ?? '',
    tokensIn: jqIntText(add(rows.map((r) => r.ti))),
    tokensOut: jqIntText(add(rows.map((r) => r.to))),
    cacheRead: jqIntText(add(rows.map((r) => r.cr))),
    cacheCreation: jqIntText(add(rows.map((r) => r.cc))),
    toolUses: jqIntText(add(rows.map((r) => r.tu))),
    model: ranked[0][0],
  };
}

/** The jq reduction of a transcript, null where it prints nothing (or stops on an error). */
export function turnUsage(transcript: string): TurnUsage | null {
  const { values, complete } = jsonStream(transcript);
  if (!complete) return null;
  const s = emptyFold();
  foldUsage(s, values);
  return finishUsage(s);
}

type SavedGroup = [IdCode, [number, number, number, number] | null, string, number];

interface SavedFold {
  main: number;
  first: string | null;
  last: string | null;
  failed: boolean;
  groups: SavedGroup[];
}

interface Cursor {
  v: number;
  transcript: string;
  offset: number;
  head: string;
  fold: SavedFold;
}

/** Transcript content bytes this process has read, cursor head checks aside (GH 2699). */
export const transcriptRead = { bytes: 0 };

function saveFold(s: UsageFold): SavedFold {
  const groups = [...s.groups.values()].map((g): SavedGroup => [g.code, g.counts && [g.counts.ti, g.counts.to, g.counts.cr, g.counts.cc], g.m, g.tu]);
  return { main: s.main, first: s.first, last: s.last, failed: s.failed, groups };
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isStamp = (v: unknown): boolean => v === null || (typeof v === 'string' && STAMP.test(v));

/** The fold a cursor saved, null when it is malformed. */
function loadFold(raw: unknown): UsageFold | null {
  try {
    return parseFold(raw);
  } catch (e) {
    if (e instanceof CursorError || e instanceof TypeError || e instanceof RangeError) return null;
    throw e;
  }
}

function parseFold(raw: unknown): UsageFold {
  if (raw === null || typeof raw !== 'object') throw new CursorError('fold');
  const f = raw as SavedFold;
  if (!isCount(f.main) || !isStamp(f.first) || !isStamp(f.last) || typeof f.failed !== 'boolean' || !Array.isArray(f.groups)) {
    throw new CursorError('fold');
  }
  const s: UsageFold = { main: f.main, first: f.first, last: f.last, failed: f.failed, groups: new Map() };
  for (const g of f.groups as unknown[]) {
    if (!Array.isArray(g) || g.length !== 4 || typeof g[2] !== 'string' || !isCount(g[3])) throw new CursorError('group');
    const c = g[1] as unknown;
    if (c !== null && !(Array.isArray(c) && c.length === 4 && c.every(isCount))) throw new CursorError('counts');
    const id = decodeId(g[0]);
    const code = encodeId(id);
    const key = JSON.stringify(code);
    if (s.groups.has(key)) throw new CursorError('duplicate group');
    const counts = c === null ? null : { ti: c[0] as number, to: c[1] as number, cr: c[2] as number, cc: c[3] as number };
    s.groups.set(key, { id, code, counts, m: g[2], tu: g[3] });
  }
  return s;
}

function readAt(fd: number, start: number, end: number): Buffer {
  const buf = Buffer.alloc(Math.max(0, end - start));
  let got = 0;
  while (got < buf.length) {
    const k = readSync(fd, buf, got, buf.length - got, start + got);
    if (k === 0) break;
    got += k;
  }
  return buf.subarray(0, got);
}

/** The sha256 of the first min(4096, offset) bytes, null unless the byte before <offset> is a newline. */
function headPrint(fd: number, offset: number): string | null {
  const len = Math.min(HEAD_BYTES, offset);
  const head = readAt(fd, 0, len);
  if (head.length !== len || readAt(fd, offset - 1, offset)[0] !== 0x0a) return null;
  return createHash('sha256').update(head).digest('hex');
}

/** The cursor at <file> when it fits this transcript as it is now, else null. */
function cursorAt(file: string, transcript: string, fd: number, size: number): Cursor | null {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as Cursor;
    if (c === null || typeof c !== 'object' || c.v !== CURSOR_VERSION || c.transcript !== transcript) return null;
    if (!Number.isSafeInteger(c.offset) || c.offset < 1 || c.offset > size) return null;
    return headPrint(fd, c.offset) === c.head ? c : null;
  } catch {
    return null;
  }
}

/** Writes the cursor unless one past <offset> fits the transcript as it is now, which a run that started later saved. */
function saveCursor(file: string, transcript: string, fd: number, offset: number, fold: SavedFold): void {
  let tmp = '';
  try {
    const onDisk = cursorAt(file, transcript, fd, fstatSync(fd).size);
    if (onDisk !== null && onDisk.offset > offset) return;
    const head = headPrint(fd, offset);
    if (head === null) return;
    const cursor: Cursor = { v: CURSOR_VERSION, transcript, offset, head, fold };
    mkdirSync(dirname(file), { recursive: true });
    tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(cursor));
    renameSync(tmp, file);
  } catch {
    if (tmp !== '') rmSync(tmp, { force: true });
  }
}

/** jsonStream, but a BOM is skipped only at the very start of the file. */
function streamAt(text: string, atStart: boolean): { values: unknown[]; complete: boolean } {
  return !atStart && text.charCodeAt(0) === 0xfeff ? { values: [], complete: false } : jsonStream(text);
}

interface TailRead {
  usage: TurnUsage | null;
  offset: number;
  fold: SavedFold | null;
}

/**
 * Folds the bytes from <offset> to <size> into <s>: the complete lines advance
 * the cursor, a trailing partial line counts in this row only. Null when the
 * complete lines do not parse; from offset 0 that is the full read's answer.
 */
function readFrom(fd: number, size: number, offset: number, s: UsageFold): TailRead | null {
  const buf = readAt(fd, offset, size);
  transcriptRead.bytes += buf.length;
  const cut = buf.lastIndexOf(0x0a) + 1;
  const lines = streamAt(buf.subarray(0, cut).toString('utf8'), offset === 0);
  if (!lines.complete) return offset === 0 ? { usage: turnUsage(buf.toString('utf8')), offset: 0, fold: null } : null;
  foldUsage(s, lines.values);
  const end = offset + cut;
  const fold = cut > 0 ? saveFold(s) : null;
  const rest = streamAt(buf.subarray(cut).toString('utf8'), end === 0);
  if (!rest.complete) return { usage: null, offset: end, fold };
  foldUsage(s, rest.values);
  return { usage: finishUsage(s), offset: end, fold };
}

/** The transcript's row, read from the session's cursor when it fits, else in full; the cursor moves to the new offset. */
export function transcriptUsage(transcript: string, cursorFile: string | null): TurnUsage | null {
  let fd: number;
  try {
    fd = openSync(transcript, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const cursor = cursorFile === null ? null : cursorAt(cursorFile, transcript, fd, size);
    const fold = cursor === null ? null : loadFold(cursor.fold);
    let from = 0;
    let read: TailRead | null = null;
    if (cursor !== null && fold !== null) {
      read = readFrom(fd, size, cursor.offset, fold);
      from = cursor.offset;
    }
    if (read === null) {
      from = 0;
      read = readFrom(fd, size, 0, emptyFold()) as TailRead;
    }
    if (cursorFile !== null && read.fold !== null && read.offset > from) saveCursor(cursorFile, transcript, fd, read.offset, read.fold);
    return read.usage;
  } finally {
    closeSync(fd);
  }
}

/** The session's cursor file next to the DB, null for a session_id unsafe in a file name. */
export function cursorPath(db: string, sessionId: string): string | null {
  return SAFE_SESSION.test(sessionId) ? join(dirname(db), CURSOR_DIR, `${sessionId}.json`) : null;
}

/** tmb_plugin_version: `.version // empty` of the manifest. */
export function pluginVersion(env: NodeJS.ProcessEnv): string {
  const root = env.CLAUDE_PLUGIN_ROOT ?? '';
  const manifest = `${root}/.claude-plugin/plugin.json`;
  if (root === '' || !isFile(manifest)) return '';
  let text: string;
  try {
    text = readFileSync(manifest, 'utf8');
  } catch {
    return '';
  }
  const out: string[] = [];
  for (const value of jsonValues(text)) {
    try {
      const v = index(value, 'version');
      if (truthy(v)) out.push(jqRawText(v));
    } catch (e) {
      if (!(e instanceof JqError)) throw e;
    }
  }
  return stripTrailingNewlines(out.join('\n'));
}

function usageValid(u: TurnUsage): boolean {
  return (
    STAMP.test(u.first) &&
    STAMP.test(u.last) &&
    [u.tokensIn, u.tokensOut, u.cacheRead, u.cacheCreation, u.toolUses].every((v) => /^[0-9]+$/.test(v))
  );
}

export function usageSql(db: string, sessionId: string, u: TurnUsage, env: NodeJS.ProcessEnv): string {
  const projectRoot = posixDirname(posixDirname(posixDirname(db)));
  const rootSql = dbLocation(projectRoot, env) === db ? `'${sqlQuote(projectRoot)}'` : 'NULL';
  const version = pluginVersion(env);
  const versionSql = version !== '' ? `'${sqlQuote(version)}'` : 'NULL';
  const session = sqlQuote(sessionId);
  const sessionRow = `agent_type = 'bro' AND task_id IS NULL AND session_id = '${session}'`;
  const duration = `MAX(0, CAST(ROUND((julianday('${u.last}') - julianday('${u.first}')) * 86400000) AS INTEGER))`;
  const model = `'${u.model}'`;
  return `
UPDATE agent_runs
   SET tokens_in             = ${u.tokensIn},
       tokens_out            = ${u.tokensOut},
       cache_read_tokens     = ${u.cacheRead},
       cache_creation_tokens = ${u.cacheCreation},
       tool_uses             = ${u.toolUses},
       started_at            = '${u.first}',
       completed_at          = '${u.last}',
       duration_ms           = ${duration},
       usage_source          = 'transcript',
       model                 = ${model},
       host                  = 'claude',
       root_dir              = COALESCE(${rootSql}, root_dir),
       exit_reason           = 'completed'
 WHERE ${sessionRow} AND (${completedAfter(u.last)}) IS NOT TRUE;

INSERT INTO agent_runs (agent_type, task_id, issue_id, session_id, tokens_in, tokens_out, cache_read_tokens,
                        cache_creation_tokens, tool_uses, started_at, completed_at, duration_ms,
                        usage_source, model, host, root_dir, exit_reason, plugin_version)
SELECT 'bro', NULL, NULL, '${session}', ${u.tokensIn}, ${u.tokensOut}, ${u.cacheRead}, ${u.cacheCreation}, ${u.toolUses},
       '${u.first}', '${u.last}', ${duration}, 'transcript', ${model}, 'claude', ${rootSql}, 'completed',
       ${versionSql}
 WHERE NOT EXISTS (SELECT 1 FROM agent_runs WHERE ${sessionRow});
`;
}

export const broTurnUsage: SyncGate = (payload, env) => {
  if ((env.TMB_DISABLE_BRO_TURN_USAGE_HOOK ?? '0') === '1') return ALLOW;
  const db = dbPath(env) ?? '';
  if (db === '' || !isFile(db)) return ALLOW;
  const input = commandSubstitution(payload);
  const sessionId = jqKeyOr(input, 'session_id', '');
  const transcript = jqKeyOr(input, 'transcript_path', '');
  if (sessionId === '' || transcript === '' || !isFile(transcript)) return ALLOW;
  let usage: TurnUsage | null;
  try {
    usage = transcriptUsage(transcript, cursorPath(db, sessionId));
  } catch {
    return ALLOW;
  }
  if (usage === null || !usageValid(usage)) return ALLOW;
  const r = dbWrite(db, usageSql(db, sessionId, usage, env), { env, caller: GATE_NAME });
  if (!r.ok) {
    process.stderr.write(`${r.error}\n`);
  } else {
    try {
      toolOutputSize(payload, {
        ...env,
        TMB_STOP_AGENT_TYPE: 'bro',
        TMB_STOP_SESSION_ID: sessionId,
        [TOOL_OUTPUT_COMPLETED_AT_ENV]: usage.last,
      });
    } catch {
      // The recorder never fails the gate.
    }
  }
  return { stdout: r.stdout, code: 0 };
};
