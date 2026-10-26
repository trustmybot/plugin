/**
 * TypeScript port of scripts/hooks/lib/normalize-role.sh, plus the role read
 * of cmd-analysis.sh's tmb_agent_role (GH 1692).
 */
import { jqAlternatives } from './jq.js';

export const PR_REVIEWER_ROLE = 'pr-reviewer';

/** tmb_normalize_role <value>: the value minus everything up to its first colon. */
export function normalizeRole(raw = ''): string {
  const colon = raw.indexOf(':');
  return colon < 0 ? raw : raw.slice(colon + 1);
}

/** tmb_agent_role <input_json>: the payload's agent_type (else subagent_type), normalized; "bro" when none. */
export function agentRole(input = ''): string {
  const raw = normalizeRole(jqAlternatives(input, [['agent_type'], ['subagent_type']]));
  return raw === '' ? 'bro' : raw;
}
