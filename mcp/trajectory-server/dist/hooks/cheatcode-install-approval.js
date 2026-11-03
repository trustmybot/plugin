/**
 * PreToolUse(cheatcode_install) gate of the trajectory-gates chain (GH 1692),
 * the port of scripts/hooks/cheatcode-install-approval.sh: installs are
 * human-approved, never silent, so a tool whose name holds cheatcode_install
 * is allowed only when a cheatcode_approved audit row carries the
 * candidate's source_url. It fails closed: no source_url, no trajectory DB,
 * or no approval row (a DB that does not read included) denies.
 *
 * Unlike the .sh, it needs neither jq nor the sqlite3 CLI: without jq the .sh
 * let every install through, where this checks the approval; without sqlite3
 * the .sh denied every install as unverifiable, where this reads the DB
 * through node:sqlite (decision 703).
 */
import { ALLOW } from './gate.js';
import { denyJson } from './agent-arg-matches-caller.js';
import { dbPath, haveSqlite, sqlQuote, sqliteRo } from './lib/db.js';
import { jqCapture, jqInput } from './lib/jq-raw.js';
export const GATE_NAME = 'cheatcode-install-approval';
export const NO_SOURCE_URL_REASON = 'BLOCKED: cheatcode_install requires a candidate.source_url so the per-candidate approval can be verified. Recovery: call cheatcode_install with candidate={name,kind,source_url}.';
export const UNVERIFIABLE_REASON = 'BLOCKED: cheatcode_install approval cannot be verified (trajectory DB unavailable) — failing closed. Installs are human-approved, never silent.';
export function notApprovedReason(name, url) {
    return `BLOCKED: no human-approval record for cheatcode '${name || url}' (${url}). Installs are human-approved, never silent. Recovery: record approval via cheatcode_approve(agent='bro', candidate={name,kind,source_url}) after the Human confirms, then retry cheatcode_install.`;
}
export function approvalSql(url) {
    return `
  SELECT COUNT(*) FROM audit
   WHERE event_type = 'cheatcode_approved'
     AND json_extract(content_json, '$.source_url') = '${sqlQuote(url)}'
  LIMIT 1;
`;
}
function deny(reason) {
    return { stdout: denyJson(reason), code: 0 };
}
export const cheatcodeInstallApproval = (payload, env) => {
    const input = jqInput(payload);
    if (!jqCapture(input, ['tool_name'], true).includes('cheatcode_install'))
        return ALLOW;
    const url = jqCapture(input, ['tool_input', 'candidate', 'source_url'], true);
    const name = jqCapture(input, ['tool_input', 'candidate', 'name'], true);
    if (url === '')
        return deny(NO_SOURCE_URL_REASON);
    const db = dbPath(env, (line) => process.stderr.write(`${line}\n`));
    if (db === null || !haveSqlite(env))
        return deny(UNVERIFIABLE_REASON);
    const approved = sqliteRo(db, approvalSql(url), env);
    if (/^[0-9]+$/.test(approved) && Number(approved) > 0)
        return ALLOW;
    return deny(notApprovedReason(name, url));
};
//# sourceMappingURL=cheatcode-install-approval.js.map