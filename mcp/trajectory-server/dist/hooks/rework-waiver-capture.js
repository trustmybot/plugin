/**
 * UserPromptSubmit gate (GH 2148), born in TypeScript: the one writer of
 * author 'human' discussions rows. For each `waive task <N>` in the Human's
 * prompt (case-insensitive, `#` before N optional, word boundaries) it writes
 * a kind 'decision' row on task N and its issue, whose body is the prompt line
 * holding the phrase, capped at 500 characters. Any other wording writes
 * nothing. A harness turn writes nothing, and injected blocks are skipped.
 * Never blocks: an unknown task, no DB or a failed write changes nothing.
 */
import { ALLOW } from './gate.js';
import { dbWrite, nowIso } from './lib/audit.js';
import { dbPath, haveSqlite, sqlQuote } from './lib/db.js';
import { jqFieldOr } from './lib/jq.js';
import { commandSubstitution } from './lib/project-env.js';
import { isHarnessTurn } from './cmd-analysis/harness-turn.js';
import { stripInjectedBlocks } from './prompt-intent-hints.js';
export const GATE_NAME = 'rework-waiver-capture';
export const WAIVER_BODY_MAX_CHARS = 500;
const WAIVER = /\bwaive task #?(\d+)\b/gi;
/** The waivers in <prompt>, one per task id, in order of first mention. */
export function waivers(prompt) {
    const seen = new Set();
    const found = [];
    for (const line of prompt.split(/\r?\n/)) {
        for (const m of line.matchAll(WAIVER)) {
            const taskId = Number(m[1]);
            if (!Number.isSafeInteger(taskId) || seen.has(taskId))
                continue;
            seen.add(taskId);
            found.push({ taskId, body: [...line.trim()].slice(0, WAIVER_BODY_MAX_CHARS).join('') });
        }
    }
    return found;
}
export function waiverSql(w, now) {
    return `INSERT INTO discussions (issue_id, author, kind, body, created_at, repo, task_id)
  SELECT t.issue_id, 'human', 'decision', '${sqlQuote(w.body)}', '${now}', (SELECT i.repo FROM issues i WHERE i.id = t.issue_id), t.id
    FROM tasks t WHERE t.id = ${w.taskId};`;
}
export function makeReworkWaiverCapture(clock = () => new Date()) {
    return (payload, env) => {
        try {
            const prompt = commandSubstitution(jqFieldOr(`${commandSubstitution(payload)}\n`, 'prompt'));
            if (prompt === '' || isHarnessTurn(prompt))
                return ALLOW;
            const found = waivers(stripInjectedBlocks(prompt));
            if (found.length === 0)
                return ALLOW;
            if (!haveSqlite(env))
                return ALLOW;
            const db = dbPath(env);
            if (db === null)
                return ALLOW;
            const now = nowIso(clock());
            dbWrite(db, found.map((w) => waiverSql(w, now)).join('\n'), { caller: GATE_NAME, env });
            return ALLOW;
        }
        catch {
            return ALLOW;
        }
    };
}
export const reworkWaiverCapture = makeReworkWaiverCapture();
//# sourceMappingURL=rework-waiver-capture.js.map