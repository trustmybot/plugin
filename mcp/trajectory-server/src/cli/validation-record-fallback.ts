/**
 * `cli.js validation-record-fallback` (GH 1692): code-reviewer's honor-system
 * validation_record while the MCP trajectory-server is down. Validates the
 * findings[] as validation_record's parseFindings does, with SQLite's JSON
 * functions, and the probes[] with validation_record's parseProbes (a pass
 * needs them, GH 2866), then writes the validation_attempts row with
 * mcp_available = 0, its probes_json and the attempt's review_findings through
 * tmb_db_write's port (busy timeout, foreign keys on, one BEGIN IMMEDIATE
 * transaction, a retry on a busy DB).
 * Rows are append-only: an attempt_n that already has a row is stored as the
 * task's highest attempt_n + 1, and the JSON reports the stored attempt; each
 * finding attaches to it with id F<task_id>-<n>, n continuing after the task's
 * highest.
 */
import { dbWrite, nowIso } from '../hooks/lib/audit.js';
import { sqlQuote } from '../hooks/lib/db.js';
import { loadNodeSqlite } from '../hooks/lib/sqlite-shell.js';
import { ProbesError, parseProbes, probesJson, type ReviewProbe } from '../tools/review-probes.js';
import { type CliIo, dbNotFoundJson, fallbackDbPath, isFile } from './fallback-db.js';

const USAGE =
  '{"error":"usage","message":"validation-record-fallback <task_id> <attempt_n> <verdict> <feedback> <subagent_session_id> [<findings_json>] [<probes_json>]"}\n';

/** The whitespace String.prototype.trim strips, so text is trimmed as on the server. */
const WS = 'char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)';
const FINDING_SHAPE = '{criterion_id?, probe_cmd, expected, observed, severity?, class?}';
const ALLOWED_KEYS = "('criterion_id', 'probe_cmd', 'expected', 'observed', 'severity', 'class')";
const SEVERITIES = "('blocking', 'nit', 'pre_existing')";
const SEVERITY_SQL = "COALESCE(json_extract(e.value, '$.severity'), 'blocking')";

function badText(field: string): string {
  return `WHEN json_type(e.value, '$.${field}') IS NOT 'text' OR trim(json_extract(e.value, '$.${field}'), ${WS}) = '' THEN 'findings[' || e.key || '].${field} must be a non-empty string'`;
}

function badOptionalText(field: string): string {
  return `WHEN json_type(e.value, '$.${field}') NOT IN ('null', 'text') OR trim(json_extract(e.value, '$.${field}'), ${WS}) = ''
      THEN 'findings[' || e.key || '].${field} must be a non-empty string or null'`;
}

const FINDINGS_CHECK_SQL = `
WITH f(v) AS (SELECT ?1),
bad(k, msg) AS (
  SELECT e.key, CASE
    WHEN e.type <> 'object' THEN 'findings[' || e.key || '] must be an object ${FINDING_SHAPE}'
    WHEN EXISTS (SELECT 1 FROM json_each(e.value) k WHERE k.key NOT IN ${ALLOWED_KEYS})
      THEN 'findings[' || e.key || '] has unknown field(s) ' || (SELECT group_concat(k.key, ', ') FROM json_each(e.value) k WHERE k.key NOT IN ${ALLOWED_KEYS}) || '; allowed: criterion_id, probe_cmd, expected, observed, severity, class'
    ${badText('probe_cmd')}
    ${badText('expected')}
    ${badText('observed')}
    ${badOptionalText('criterion_id')}
    WHEN json_type(e.value, '$.severity') NOT IN ('null', 'text') OR json_extract(e.value, '$.severity') NOT IN ${SEVERITIES}
      THEN 'findings[' || e.key || '].severity must be one of blocking, nit, pre_existing'
    ${badOptionalText('class')}
  END
  FROM f, json_each(f.v) e
  WHERE json_valid(f.v) AND json_type(f.v) = 'array'
),
blocking(n) AS (
  SELECT COUNT(*) FROM f, json_each(f.v) e
  WHERE json_valid(f.v) AND json_type(f.v) = 'array' AND ${SEVERITY_SQL} = 'blocking'
)
SELECT CASE
  WHEN NOT json_valid(v) THEN 'invalid_findings|findings is not valid JSON'
  WHEN json_type(v) NOT IN ('array', 'null') THEN 'invalid_findings|findings must be a JSON array of ${FINDING_SHAPE}'
  WHEN ?2 = 'fail' AND COALESCE(json_array_length(v), 0) = 0 THEN 'findings_required|a fail verdict needs a non-empty findings array, one ${FINDING_SHAPE} per defect, each probe_cmd a command that exits 0 once the defect is fixed'
  WHEN EXISTS (SELECT 1 FROM bad WHERE msg IS NOT NULL) THEN (SELECT 'invalid_findings|' || msg FROM bad WHERE msg IS NOT NULL ORDER BY k LIMIT 1)
  WHEN ?2 = 'pass' AND (SELECT n FROM blocking) > 0 THEN 'findings_refused|a pass verdict records only nit or pre_existing findings (an omitted severity is blocking); send a blocking finding with verdict fail'
  WHEN ?2 = 'fail' AND (SELECT n FROM blocking) = 0 THEN 'findings_required|a fail verdict needs at least one finding with severity blocking (an omitted severity is blocking); nit and pre_existing findings alone ride on a pass'
  ELSE 'ok'
END
FROM f;`;

/** 'ok', else `<code>|<message>` for the first defect of <findings>. */
export function findingsCheck(findings: string, verdict: string): string {
  try {
    const sqlite = loadNodeSqlite();
    if (!sqlite) throw new Error('node:sqlite is unavailable in this Node');
    const db = new sqlite.DatabaseSync(':memory:');
    try {
      const stmt = db.prepare(FINDINGS_CHECK_SQL);
      stmt.setReturnArrays(true);
      const [result] = stmt.get(findings.replace(/\n+$/, ''), verdict) as unknown as [unknown];
      return String(result).replace(/\n+$/, '');
    } finally {
      db.close();
    }
  } catch (e) {
    return `invalid_findings|sqlite3 could not read the findings: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** The parsed probes of <raw> (absent when undefined), else the ProbesError that refuses them. */
function probesCheck(raw: string | undefined, verdict: string): ReviewProbe[] | ProbesError {
  let parsed: unknown;
  if (raw !== undefined) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return new ProbesError('probes_invalid', 'probes is not valid JSON');
    }
  }
  try {
    return parseProbes(verdict, parsed);
  } catch (e) {
    if (e instanceof ProbesError) return e;
    throw e;
  }
}

function jsonError(code: string, message: string): string {
  return `{"error":"${code}","message":"${message.replace(/\n/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"}\n`;
}

function writeSql(
  taskId: string,
  attemptN: string,
  verdict: string,
  feedback: string,
  session: string,
  findings: string,
  probes: readonly ReviewProbe[],
  createdAt: string,
): string {
  const safeFindings = sqlQuote(findings);
  const stored = probesJson(probes);
  const probesValue = stored === null ? 'NULL' : `'${sqlQuote(stored)}'`;
  const findingsArray = `CASE json_type('${safeFindings}') WHEN 'array' THEN json('${safeFindings}') ELSE '[]' END`;
  return `CREATE TEMP TABLE fallback_attempt AS
  SELECT CASE WHEN EXISTS (SELECT 1 FROM validation_attempts WHERE task_id = ${taskId} AND attempt_n = ${attemptN})
    THEN (SELECT MAX(attempt_n) + 1 FROM validation_attempts WHERE task_id = ${taskId})
    ELSE ${attemptN} END AS n;
INSERT INTO validation_attempts
  (task_id, attempt_n, agent, verdict, feedback, mcp_available, subagent_session_id, created_at, probes_json)
VALUES
  (${taskId}, (SELECT n FROM fallback_attempt), 'code-reviewer', '${verdict}', '${sqlQuote(feedback)}', 0, '${sqlQuote(session)}', '${createdAt}', ${probesValue});
CREATE TEMP TABLE fallback_last_finding AS
  SELECT COALESCE(MAX(CAST(substr(id, instr(id, '-') + 1) AS INTEGER)), 0) AS n
  FROM review_findings WHERE task_id = ${taskId};
INSERT INTO review_findings (id, task_id, attempt_n, criterion_id, probe_cmd, expected, observed, status, created_at, severity, class)
  SELECT 'F${taskId}-' || ((SELECT n FROM fallback_last_finding) + e.key + 1), ${taskId}, (SELECT n FROM fallback_attempt),
    CASE WHEN json_type(e.value, '$.criterion_id') = 'text' THEN trim(json_extract(e.value, '$.criterion_id'), ${WS}) END,
    trim(json_extract(e.value, '$.probe_cmd'), ${WS}),
    trim(json_extract(e.value, '$.expected'), ${WS}),
    trim(json_extract(e.value, '$.observed'), ${WS}),
    'open', '${createdAt}',
    ${SEVERITY_SQL},
    CASE WHEN json_type(e.value, '$.class') = 'text' THEN trim(json_extract(e.value, '$.class'), ${WS}) END
  FROM json_each(${findingsArray}) e
  ORDER BY e.key;
SELECT n FROM fallback_attempt;
SELECT json_group_array(id) FROM (
  SELECT 'F${taskId}-' || ((SELECT n FROM fallback_last_finding) + e.key + 1) AS id
  FROM json_each(${findingsArray}) e
  ORDER BY e.key);
DROP TABLE fallback_last_finding;
DROP TABLE fallback_attempt;`;
}

/** Runs the subcommand on <argv> (the arguments after its name); returns the exit code. */
export function validationRecordFallback(argv: readonly string[], env: NodeJS.ProcessEnv, io: CliIo): number {
  if (argv.length < 5 || argv.length > 7) {
    io.out(USAGE);
    return 1;
  }
  const [taskId, attemptN, verdict, feedback, session] = argv;
  const findings = argv[5] || '[]';
  const probesArg = argv[6] || undefined;
  if (!/^[0-9]+$/.test(taskId)) {
    io.out(`{"error":"invalid_task_id","value":"${taskId}"}\n`);
    return 1;
  }
  if (!/^[0-9]+$/.test(attemptN)) {
    io.out(`{"error":"invalid_attempt_n","value":"${attemptN}"}\n`);
    return 1;
  }
  if (verdict !== 'pass' && verdict !== 'fail') {
    io.out(`{"error":"invalid_verdict","value":"${verdict}","allowed":["pass","fail"]}\n`);
    return 1;
  }
  const check = findingsCheck(findings, verdict);
  if (check !== 'ok') {
    const bar = check.indexOf('|');
    const code = bar < 0 ? check : check.slice(0, bar);
    io.out(jsonError(code, bar < 0 ? check : check.slice(bar + 1)));
    return 1;
  }
  const probes = probesCheck(probesArg, verdict);
  if (probes instanceof ProbesError) {
    io.out(jsonError(probes.code, probes.detail));
    return 1;
  }
  const db = fallbackDbPath(env);
  if (!isFile(db)) {
    io.out(dbNotFoundJson(db));
    return 1;
  }
  const r = dbWrite(db, writeSql(taskId, attemptN, verdict, feedback, session, findings, probes, nowIso()), {
    caller: 'validation-record-fallback',
    env,
  });
  if (!r.ok) {
    io.err(`${r.error}\n`);
    io.out(`{"error":"db-write-failed","path":"${db}","hint":"tmb_db_write reported the cause on stderr."}\n`);
    return 1;
  }
  const out = r.stdout.replace(/\n+$/, '').split('\n');
  const ids = out.pop() || '[]';
  const stored = out.pop() || attemptN;
  io.out(`{"ok":true,"task_id":${taskId},"attempt_n":${stored},"verdict":"${verdict}","findings":${ids}}\n`);
  return 0;
}
