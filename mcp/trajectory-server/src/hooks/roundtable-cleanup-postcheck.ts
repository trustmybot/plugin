/**
 * PostToolUse hook on roundtable_close / roundtable_close_with_decisions
 * (GH 1692), the port of scripts/hooks/roundtable-cleanup-postcheck.sh:
 * advisory additionalContext naming each capture surface the closed
 * roundtable lacks (analysis and decision discussions, closed state, outcome,
 * votes, the roundtable_summary audit row). Never blocks; silent on any local
 * failure. Unlike the .sh, it needs neither jq nor the sqlite3 CLI
 * (decision 703).
 */
import { ALLOW, type GateResult } from './gate.js';
import { dbPath, haveSqlite, sqlInt, sqliteRo } from './lib/db.js';
import { jqCompact, jqFieldOr, jqIndex, jqLiteralNumbers, jqMap, jqOr } from './lib/jq.js';
import { commandSubstitution, jqRawText } from './lib/project-env.js';

export const GATE_NAME = 'roundtable-cleanup-postcheck';

const CLOSE_TOOLS = ['roundtable_close', 'roundtable_close_with_decisions'] as const;

/** `jq -r '.tool_input.roundtable_id // ""'` as a `$(...)` capture, number literals spelled as jq 1.7 prints them. */
export function roundtableIdField(echoed: string): string {
  return commandSubstitution(
    jqMap(echoed, (value) => jqRawText(jqOr(jqIndex(jqIndex(value, 'tool_input'), 'roundtable_id'), '')), jqLiteralNumbers).join('\n'),
  );
}

export function captureSql(rtId: string): string {
  return `SELECT r.issue_id,
    (SELECT COUNT(*) FROM discussions d WHERE d.issue_id = r.issue_id AND d.kind = 'analysis'),
    (SELECT COUNT(*) FROM discussions d WHERE d.issue_id = r.issue_id AND d.kind = 'decision'),
    (SELECT COUNT(*) FROM roundtable_votes v WHERE v.roundtable_id = r.id),
    (SELECT COUNT(*) FROM audit a WHERE a.event_type = 'roundtable_summary' AND a.issue_id = r.issue_id),
    r.state, COALESCE(r.outcome, '')
  FROM roundtables r WHERE r.id = ${rtId} LIMIT 1;`;
}

const atLeastOne = (count: string): boolean => /^[0-9]+$/.test(count) && Number(count) >= 1;

/**
 * The capture surfaces missing from <row>, the query's list-mode output, read
 * as the .sh's `IFS='|' read -r`: the first line only, the outcome the rest of
 * it, and an outcome of a lone `|` read as empty. Null when the row names no
 * issue.
 */
export function missingSurfaces(row: string): string[] | null {
  const [issueId = '', analyses = '', decisions = '', votes = '', summaries = '', state = '', ...rest] = row.split('\n')[0].split('|');
  if (sqlInt(issueId) === '') return null;
  const outcome = rest.join('|');
  const missing: string[] = [];
  if (!atLeastOne(analyses)) missing.push('analysis-discussions');
  if (!atLeastOne(decisions)) missing.push('decision-discussions');
  if (state !== 'closed') missing.push('roundtable.status=closed');
  if (outcome === '' || outcome === '|') missing.push('roundtable.outcome');
  if (!atLeastOne(votes)) missing.push('votes');
  if (!atLeastOne(summaries)) missing.push('audit(roundtable_summary)');
  return missing;
}

export function cleanupContext(rtId: string, missing: readonly string[]): string {
  return `${jqCompact({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `[tmb roundtable-cleanup] roundtable_id=${rtId} closed but the following capture surfaces are missing: ${missing.join(' ')}. Re-call the relevant tools (discussion_append for analysis/decision, roundtable_vote, roundtable_summarize, audit_append) so the trajectory is auditable.`,
    },
  })}\n`;
}

export function roundtableCleanupPostcheck(payload: string, env: NodeJS.ProcessEnv): GateResult {
  try {
    const echoed = `${commandSubstitution(payload)}\n`;
    const tool = commandSubstitution(jqFieldOr(echoed, 'tool_name'));
    if (!CLOSE_TOOLS.some((name) => tool.endsWith(name))) return ALLOW;
    const rtId = sqlInt(roundtableIdField(echoed));
    if (rtId === '') return ALLOW;
    const db = dbPath(env);
    if (db === null || db === '' || !haveSqlite(env)) return ALLOW;
    const missing = missingSurfaces(sqliteRo(db, captureSql(rtId), env));
    if (missing === null || missing.length === 0) return ALLOW;
    return { stdout: cleanupContext(rtId, missing), code: 0 };
  } catch {
    return ALLOW;
  }
}
