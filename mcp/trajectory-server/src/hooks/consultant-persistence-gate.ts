/**
 * SubagentStop hook (#468, GH 1692), the port of
 * scripts/hooks/consultant-persistence-gate.sh: a TMB consultant (an agents
 * row of kind consultant) may stop only once it has a discussion row on the
 * most recent open issue; otherwise the stop is blocked with a recovery
 * message teaching discussion_append. It passes on stop_hook_active, an
 * unresolvable agent, the backbone roles, a non-consultant, an unresolved DB
 * and no open issue; a DB read error blocks with the DB-unavailable reason.
 * Unlike the .sh, it needs neither jq nor the sqlite3 CLI, so it enforces on
 * a machine without them where the .sh let every stop through (decision 703).
 */
import { ALLOW, type GateResult } from './gate.js';
import { dbPath, dbUnavailableReason, GATE_READ_ERROR, gateRead, haveSqlite, sqlInt, sqlQuote } from './lib/db.js';
import { jqAlternatives, jqCompact, jqFieldOr } from './lib/jq.js';
import { commandSubstitution } from './lib/project-env.js';
import { normalizeRole } from './lib/role.js';

export const GATE_NAME = 'consultant-persistence-gate';

const BACKBONE_ROLES: ReadonlySet<string> = new Set(['bro', 'swe', 'code-reviewer']);

const block = (reason: string): GateResult => ({ stdout: `${jqCompact({ decision: 'block', reason })}\n`, code: 0 });

export function recoveryMessage(agent: string, issueId: string): string {
  return `Consultant persistence gate: you must persist your analysis before returning. Append your analysis via discussion_append(agent='${agent}', issue_id=${issueId}, author='${agent}', kind='analysis', body=<your analysis>) then return.`;
}

/** The stopping agent's role: agent_type, else subagent_type, else tool_input.subagent_type, normalized. */
export function stoppingAgent(echoed: string): string {
  return normalizeRole(
    commandSubstitution(jqAlternatives(echoed, [['agent_type'], ['subagent_type'], ['tool_input', 'subagent_type']])),
  );
}

export function consultantPersistenceGate(payload: string, env: NodeJS.ProcessEnv): GateResult {
  const echoed = `${commandSubstitution(payload)}\n`;
  if (commandSubstitution(jqFieldOr(echoed, 'stop_hook_active', 'false')) === 'true') return ALLOW;
  const agent = stoppingAgent(echoed);
  if (agent === '' || BACKBONE_ROLES.has(agent)) return ALLOW;
  const db = dbPath(env);
  if (db === null || db === '' || !haveSqlite(env)) return ALLOW;
  const unavailable = (): GateResult => block(dbUnavailableReason(GATE_NAME, env));
  const safeAgent = sqlQuote(agent);

  const isConsultant = gateRead(db, `SELECT COUNT(*) FROM agents WHERE name='${safeAgent}' AND kind='consultant';`, env);
  if (isConsultant === GATE_READ_ERROR) return unavailable();
  if (isConsultant !== '1') return ALLOW;

  const openIssue = gateRead(db, "SELECT id FROM issues WHERE status='open' ORDER BY updated_at DESC, id DESC LIMIT 1;", env);
  if (openIssue === GATE_READ_ERROR) return unavailable();
  const issueId = sqlInt(openIssue);
  if (issueId === '') return ALLOW;

  const discussions = gateRead(db, `SELECT COUNT(*) FROM discussions WHERE author='${safeAgent}' AND issue_id=${issueId};`, env);
  if (discussions === GATE_READ_ERROR) return unavailable();
  if (/^[0-9]+$/.test(discussions) && Number(discussions) >= 1) return ALLOW;
  return block(recoveryMessage(agent, issueId));
}
