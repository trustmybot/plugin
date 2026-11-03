/**
 * UserPromptSubmit hook (GH 1692), the port of scripts/hooks/roundtable-slash-detect.sh:
 * when the Human types /roundtable (at the start of the prompt, or after a
 * newline or a space) it records a roundtable_slash_invoked audit row, the
 * signal roundtable_create's gate checks so a phrase trigger cannot fire the
 * ceremony. A harness turn quoting /roundtable is not the Human. Fail-open: a
 * write that fails after its retries prints a loud stderr line and exits 0.
 * Unlike the .sh, it needs neither jq nor the sqlite3 CLI (decision 703).
 */
import { ALLOW, type GateResult } from './gate.js';
import { isHarnessTurn } from './cmd-analysis/harness-turn.js';
import { auditAppend } from './lib/audit.js';
import { dbPath, haveSqlite } from './lib/db.js';
import { jqFieldOr } from './lib/jq.js';
import { commandSubstitution } from './lib/project-env.js';

export const GATE_NAME = 'roundtable-slash-detect';
export const SUMMARY_MAX_BYTES = 200;

const WRITE_ENV = { TMB_DB_WRITE_TIMEOUT_MS: '5000', TMB_DB_WRITE_RUN_BUDGET_MS: '10200' };

/** The .sh's `case`: /roundtable at the start, after a newline or after a space. */
export function slashInvoked(prompt: string): boolean {
  return prompt.startsWith('/roundtable') || prompt.includes('\n/roundtable') || prompt.includes(' /roundtable');
}

/**
 * `printf '%s' "$PROMPT" | head -c 200` as a `$(...)` capture. A multibyte
 * character cut at byte 200 decodes to U+FFFD, where the .sh kept its bytes.
 */
export function promptSummary(prompt: string): string {
  return commandSubstitution(Buffer.from(prompt, 'utf8').subarray(0, SUMMARY_MAX_BYTES).toString('utf8'));
}

export function roundtableSlashDetect(payload: string, env: NodeJS.ProcessEnv): GateResult {
  try {
    if (!haveSqlite(env)) return ALLOW;
    const prompt = commandSubstitution(jqFieldOr(`${commandSubstitution(payload)}\n`, 'prompt'));
    if (isHarnessTurn(prompt) || !slashInvoked(prompt)) return ALLOW;
    const db = dbPath(env);
    if (db === null || db === '') return ALLOW;
    const written = auditAppend(
      db,
      {
        issueId: '-1',
        branchId: '',
        fromNode: `hook:${GATE_NAME}`,
        eventType: 'roundtable_slash_invoked',
        summary: `User typed /roundtable: ${promptSummary(prompt)}`,
        contentJson: '{}',
      },
      { caller: GATE_NAME, env: { ...env, ...WRITE_ENV } },
    );
    if (!written.ok) {
      if (written.error !== '') process.stderr.write(`${written.error}\n`);
      process.stderr.write(
        `tmb slash-detect: FAILED to record roundtable_slash_invoked after retrying (${db}) — roundtable_create's gate will refuse\n`,
      );
    }
    return ALLOW;
  } catch {
    return ALLOW;
  }
}
