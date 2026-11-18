/**
 * Success Criteria ids and the typed swe completion report (GH 1744).
 *
 * Every top-level bullet under a spec's `## Success Criteria` starts with an
 * id, `- SC<n>: ...`, unique within the spec; nested sub-bullets (Writer: /
 * Populated: lines) carry none. task_provision, task_update_spec and
 * task_create_batch refuse a spec_body without them (specCriteriaProblem);
 * task_update_status(status='completed') needs a report covering each id
 * exactly once (parseCompletionReport), and review_handoff refuses a handoff
 * whose stored report misses one (reportMissingIds). A spec written before
 * the ids (no SC-prefixed bullet) is legacy: specCriterionIds returns [] and
 * no report is required.
 *
 * The same three tools refuse a spec whose `## Commit` subject commit-msg-lint
 * would deny (specCommitProblem, GH 2667).
 *
 * A report may also carry `concepts` (GH 1680): up to five L2
 * concept proposals, checked here for shape only. scan_run applies a closed,
 * reviewed task's proposals once their anchors are in the index
 * (applyConceptProposals).
 *
 * An optional `case_sweep` (GH 1955) lists each bug class swe swept before
 * close and the cases it checked for it; it is stored with the report.
 *
 * An optional `wm_feedback` (GH 2417) says what the world model answered,
 * missed or got wrong during the task; task_update_status also writes it as
 * one `wm_feedback` audit row, and validation_record takes the same shape.
 */
import { EXPECTED_FORM, MAX_SUBJECT_CHARS, subjectViolation } from './commit-subject.js';
export const CONCEPT_KINDS = ['flow', 'subsystem', 'invariant'];
export const HANDOFFS = ['calls', 'sources', 'runs', 'hook_fires'];
export const CLAIMS = ['exists', 'calls', 'only_writers_of', 'tested_by'];
export const MAX_CONCEPT_PROPOSALS = 5;
export const CRITERION_STATUSES = ['met', 'not_met', 'not_applicable'];
/** The longest spawn_note review_handoff / task_reopen store, and the reviewer-prompt prose cap. */
export const SPAWN_NOTE_MAX_CHARS = 300;
export const WM_FEEDBACK_KEYS = ['answered', 'missed', 'wrong'];
/** Why `raw` is not a WmFeedback, named at `at`, or null when it is. */
export function wmFeedbackProblem(raw, at) {
    const shape = `{${WM_FEEDBACK_KEYS.map((k) => `${k}?: string`).join(', ')}}`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return `${at} must be an object ${shape}.`;
    const entry = raw;
    const unknown = Object.keys(entry).filter((k) => !WM_FEEDBACK_KEYS.includes(k));
    if (unknown.length > 0)
        return `${at} has unknown field(s) ${unknown.join(', ')}; allowed: ${WM_FEEDBACK_KEYS.join(', ')}.`;
    const bad = WM_FEEDBACK_KEYS.find((k) => entry[k] !== undefined && entry[k] !== null && typeof entry[k] !== 'string');
    return bad === undefined ? null : `${at}.${bad} must be a string.`;
}
/** `raw` as a WmFeedback without its null fields; check it with wmFeedbackProblem first. */
export function toWmFeedback(raw) {
    const entry = raw;
    const out = {};
    for (const k of WM_FEEDBACK_KEYS) {
        const v = entry[k];
        if (typeof v === 'string')
            out[k] = v;
    }
    return out;
}
const SECTION_RE = /^## Success Criteria\s*$/i;
const COMMIT_SECTION_RE = /^## Commit\s*$/i;
const SECTION_END_RE = /^#{1,2}\s/;
const FENCE_RE = /^(```|~~~)/;
const TOP_BULLET_RE = /^[-*+]\s+(.*)$/;
const ID_RE = /^SC(\d+):/;
const MAX_LISTED = 5;
const FORMAT_HINT = 'Start each top-level bullet under ## Success Criteria with a unique id, e.g.\n' +
    '- SC1: <first criterion>\n' +
    '- SC2: <second criterion>\n' +
    '  - Writer: ... (nested sub-bullets carry no id)';
function scanCriteria(specBody) {
    const scan = { found: false, ids: [], unlabeled: [] };
    let inSection = false;
    let inFence = false;
    for (const line of specBody.split('\n')) {
        const trimmed = line.trimEnd();
        if (FENCE_RE.test(trimmed.trimStart())) {
            inFence = !inFence;
            continue;
        }
        if (inFence)
            continue;
        if (SECTION_RE.test(trimmed)) {
            inSection = true;
            scan.found = true;
            continue;
        }
        if (!inSection)
            continue;
        if (SECTION_END_RE.test(trimmed)) {
            inSection = false;
            continue;
        }
        const bullet = TOP_BULLET_RE.exec(trimmed);
        if (!bullet)
            continue;
        const id = ID_RE.exec(bullet[1]);
        if (id)
            scan.ids.push(`SC${id[1]}`);
        else
            scan.unlabeled.push(bullet[1]);
    }
    return scan;
}
function listed(items) {
    const shown = items.slice(0, MAX_LISTED).join('; ');
    return items.length > MAX_LISTED ? `${shown}; (+${items.length - MAX_LISTED} more)` : shown;
}
function duplicatesOf(ids) {
    const seen = new Set();
    const dups = new Set();
    for (const id of ids) {
        if (seen.has(id))
            dups.add(id);
        seen.add(id);
    }
    return [...dups];
}
/** Why a spec_body being written fails the id rule, or null when it passes. */
export function specCriteriaProblem(specBody) {
    const scan = scanCriteria(specBody);
    if (!scan.found)
        return `spec_body must contain a ## Success Criteria H2 section. ${FORMAT_HINT}`;
    if (scan.ids.length === 0) {
        return `success_criteria_ids_missing: no bullet under ## Success Criteria starts with an SC<n>: id. ${FORMAT_HINT}`;
    }
    if (scan.unlabeled.length > 0) {
        return (`success_criteria_ids_missing: ${scan.unlabeled.length} top-level bullet(s) under ## Success Criteria carry no SC<n>: id: ` +
            `${listed(scan.unlabeled.map((b) => JSON.stringify(b.slice(0, 60))))}. ${FORMAT_HINT}`);
    }
    const dups = duplicatesOf(scan.ids);
    if (dups.length > 0) {
        return `success_criteria_ids_duplicate: ${dups.join(', ')} appear more than once under ## Success Criteria; ids are unique within a spec.`;
    }
    return null;
}
/**
 * The `## Commit` section's first non-empty line outside code fences, or the
 * first non-empty line inside the fence that line opens; null when there is
 * no such section or it holds no subject.
 */
function specCommitSubject(specBody) {
    let inFence = false;
    let inSection = false;
    let inSectionFence = false;
    for (const line of specBody.split('\n')) {
        const heading = line.trimEnd();
        const text = line.trim();
        const isFence = FENCE_RE.test(text);
        if (inSectionFence) {
            if (isFence)
                return null;
            if (text !== '')
                return text;
            continue;
        }
        if (isFence) {
            if (inSection)
                inSectionFence = true;
            else
                inFence = !inFence;
            continue;
        }
        if (inFence)
            continue;
        if (inSection) {
            if (SECTION_END_RE.test(heading))
                return null;
            if (text !== '')
                return text;
            continue;
        }
        if (COMMIT_SECTION_RE.test(heading))
            inSection = true;
    }
    return null;
}
/** Why a spec_body's `## Commit` subject would fail commit-msg-lint, or null when it passes or has none. */
export function specCommitProblem(specBody) {
    if (process.env.TMB_SKIP_COMMIT_MSG_LINT === '1')
        return null;
    const line = specCommitSubject(specBody);
    if (line === null)
        return null;
    const subject = line.replace(/^`+|`+$/g, '').trim();
    if (subject === '')
        return null;
    const violation = subjectViolation(subject);
    if (violation === null)
        return null;
    return (`commit_subject_invalid: ## Commit subject "${subject}" — ${violation}. ` +
        `Write the subject the swe will commit, in '${EXPECTED_FORM}' within ${MAX_SUBJECT_CHARS} code points.`);
}
/** The spec's criterion ids in order, each once; [] for a legacy spec. */
export function specCriterionIds(specBody) {
    return [...new Set(scanCriteria(specBody ?? '').ids)];
}
function examplePayload(ids) {
    const criteria = (ids.length > 0 ? ids : ['SC1']).map((id) => ({ id, status: 'met' }));
    return JSON.stringify({ criteria });
}
function optionalString(value, field) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string')
        throw new Error(`completion_report_invalid: ${field} must be a string.`);
    return value;
}
function shapeError(ids, detail) {
    return new Error(`completion_report_invalid: ${detail} A minimal valid report: report=${examplePayload(ids)}`);
}
/**
 * The report task_update_status stores with a move to completed, validated
 * against the spec's ids; null when none is given and none is needed. Throws
 * naming the missing / unknown / repeated ids and a minimal valid payload.
 */
export function parseCompletionReport(raw, ids) {
    if (raw === undefined || raw === null) {
        if (ids.length === 0)
            return null;
        throw new Error(`completion_report_missing: the spec's Success Criteria carry ids ${ids.join(', ')}; ` +
            `task_update_status(status='completed') needs a report with one criteria entry per id ` +
            `(status met | not_met | not_applicable). A minimal valid report: report=${examplePayload(ids)}`);
    }
    if (typeof raw !== 'object' || Array.isArray(raw))
        throw shapeError(ids, 'report must be an object.');
    const r = raw;
    if (!Array.isArray(r['criteria']))
        throw shapeError(ids, 'report.criteria must be an array.');
    const criteria = [];
    for (const [i, item] of r['criteria'].entries()) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            throw shapeError(ids, `report.criteria[${i}] must be an object {id, status, evidence_cmd?, note?}.`);
        }
        const c = item;
        if (typeof c['id'] !== 'string' || c['id'].trim() === '') {
            throw shapeError(ids, `report.criteria[${i}].id must be a non-empty string.`);
        }
        if (!CRITERION_STATUSES.includes(c['status'])) {
            throw shapeError(ids, `report.criteria[${i}].status must be one of ${CRITERION_STATUSES.join(', ')}.`);
        }
        const evidence = optionalString(c['evidence_cmd'], `report.criteria[${i}].evidence_cmd`);
        const note = optionalString(c['note'], `report.criteria[${i}].note`);
        criteria.push({
            id: c['id'].trim(),
            status: c['status'],
            ...(evidence !== undefined ? { evidence_cmd: evidence } : {}),
            ...(note !== undefined ? { note } : {}),
        });
    }
    if (ids.length > 0) {
        const given = criteria.map((c) => c.id);
        const missing = ids.filter((id) => !given.includes(id));
        const unknown = [...new Set(given.filter((id) => !ids.includes(id)))];
        const repeated = duplicatesOf(given);
        if (missing.length > 0 || unknown.length > 0 || repeated.length > 0) {
            const parts = [
                missing.length > 0 ? `missing ids: ${missing.join(', ')}` : null,
                unknown.length > 0 ? `unknown ids: ${unknown.join(', ')}` : null,
                repeated.length > 0 ? `ids listed more than once: ${repeated.join(', ')}` : null,
            ].filter((p) => p !== null);
            throw new Error(`completion_report_incomplete: report.criteria must cover the spec's ids ${ids.join(', ')} exactly once (${parts.join('; ')}). ` +
                `A minimal valid report: report=${examplePayload(ids)}`);
        }
    }
    const report = { criteria };
    if (r['extras'] !== undefined && r['extras'] !== null) {
        if (!Array.isArray(r['extras']))
            throw shapeError(ids, 'report.extras must be an array of {path, reason}.');
        report.extras = r['extras'].map((e, i) => {
            const x = (typeof e === 'object' && e !== null ? e : {});
            if (typeof x['path'] !== 'string' || typeof x['reason'] !== 'string') {
                throw shapeError(ids, `report.extras[${i}] must be {path: string, reason: string}.`);
            }
            return { path: x['path'], reason: x['reason'] };
        });
    }
    if (r['findings_fixed'] !== undefined && r['findings_fixed'] !== null) {
        const fixed = r['findings_fixed'];
        if (!Array.isArray(fixed) || fixed.some((f) => typeof f !== 'string')) {
            throw shapeError(ids, 'report.findings_fixed must be an array of finding ids (strings).');
        }
        report.findings_fixed = fixed;
    }
    if (r['case_sweep'] !== undefined && r['case_sweep'] !== null) {
        report.case_sweep = parseCaseSweep(r['case_sweep'], ids);
    }
    if (r['concepts'] !== undefined && r['concepts'] !== null) {
        report.concepts = parseConceptProposals(r['concepts'], ids);
    }
    if (r['wm_feedback'] !== undefined && r['wm_feedback'] !== null) {
        const problem = wmFeedbackProblem(r['wm_feedback'], 'report.wm_feedback');
        if (problem)
            throw shapeError(ids, problem);
        report.wm_feedback = toWmFeedback(r['wm_feedback']);
    }
    return report;
}
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const CONCEPT_SHAPE = '{name, steps, kind?, body?, claims?, repo?}';
const CASE_SWEEP_SHAPE = '{class: non-empty string, checked: non-empty array of non-empty strings}';
function parseCaseSweep(raw, ids) {
    if (!Array.isArray(raw))
        throw shapeError(ids, `report.case_sweep must be an array of ${CASE_SWEEP_SHAPE}.`);
    return raw.map((item, i) => {
        const at = `report.case_sweep[${i}]`;
        if (!isObject(item))
            throw shapeError(ids, `${at} must be an object ${CASE_SWEEP_SHAPE}.`);
        const unknown = Object.keys(item).filter((k) => k !== 'class' && k !== 'checked');
        if (unknown.length > 0)
            throw shapeError(ids, `${at} has unknown field(s) ${unknown.join(', ')}; allowed: class, checked.`);
        if (!nonEmpty(item['class']))
            throw shapeError(ids, `${at}.class must be a non-empty string.`);
        const checked = item['checked'];
        if (!Array.isArray(checked) || checked.length === 0 || !checked.every(nonEmpty)) {
            throw shapeError(ids, `${at}.checked must be a non-empty array of non-empty strings.`);
        }
        return { class: item['class'].trim(), checked: checked.map((c) => c.trim()) };
    });
}
function parseConceptProposals(raw, ids) {
    if (!Array.isArray(raw))
        throw shapeError(ids, `report.concepts must be an array of concepts ${CONCEPT_SHAPE}.`);
    if (raw.length > MAX_CONCEPT_PROPOSALS) {
        throw shapeError(ids, `report.concepts holds ${raw.length} concepts (max ${MAX_CONCEPT_PROPOSALS}).`);
    }
    const names = new Set();
    return raw.map((item, i) => {
        const at = `report.concepts[${i}]`;
        if (!isObject(item))
            throw shapeError(ids, `${at} must be an object ${CONCEPT_SHAPE}.`);
        if (!nonEmpty(item['name']))
            throw shapeError(ids, `${at}.name must be a non-empty string.`);
        const name = item['name'].trim();
        if (names.has(name))
            throw shapeError(ids, `${at}.name '${name}' repeats an earlier concept in this report.`);
        names.add(name);
        const repo = optionalString(item['repo'], `${at}.repo`);
        const body = optionalString(item['body'], `${at}.body`);
        const kind = item['kind'] ?? undefined;
        if (kind !== undefined && !CONCEPT_KINDS.includes(kind)) {
            throw shapeError(ids, `${at}.kind must be one of ${CONCEPT_KINDS.join(', ')}.`);
        }
        const steps = item['steps'];
        if (!Array.isArray(steps) || steps.length === 0) {
            throw shapeError(ids, `${at}.steps must be a non-empty array of {path, description, kind?, qualified_name?, handoff?}.`);
        }
        const claims = item['claims'] ?? undefined;
        if (claims !== undefined && !Array.isArray(claims))
            throw shapeError(ids, `${at}.claims must be an array of {claim, args}.`);
        return {
            name,
            ...(kind !== undefined ? { kind: kind } : {}),
            ...(body !== undefined ? { body } : {}),
            ...(repo !== undefined && repo.trim() !== '' ? { repo: repo.trim() } : {}),
            steps: steps.map((s, j) => parseProposalStep(s, `${at}.steps[${j}]`, ids)),
            ...(Array.isArray(claims) ? { claims: claims.map((c, j) => parseProposalClaim(c, `${at}.claims[${j}]`, ids)) } : {}),
        };
    });
}
function parseProposalStep(raw, at, ids) {
    if (!isObject(raw))
        throw shapeError(ids, `${at} must be an object {path, description, kind?, qualified_name?, handoff?}.`);
    if (!nonEmpty(raw['path']))
        throw shapeError(ids, `${at}.path must be a non-empty string.`);
    if (!nonEmpty(raw['description']))
        throw shapeError(ids, `${at}.description must be a non-empty string.`);
    const kind = optionalString(raw['kind'], `${at}.kind`);
    const qualifiedName = optionalString(raw['qualified_name'], `${at}.qualified_name`);
    const handoff = raw['handoff'] ?? undefined;
    if (handoff !== undefined && !HANDOFFS.includes(handoff)) {
        throw shapeError(ids, `${at}.handoff must be one of ${HANDOFFS.join(', ')}.`);
    }
    return {
        path: raw['path'],
        description: raw['description'],
        ...(kind !== undefined ? { kind } : {}),
        ...(qualifiedName !== undefined ? { qualified_name: qualifiedName } : {}),
        ...(handoff !== undefined ? { handoff: handoff } : {}),
    };
}
function parseProposalClaim(raw, at, ids) {
    if (!isObject(raw) || !CLAIMS.includes(raw['claim'])) {
        throw shapeError(ids, `${at}.claim must be one of ${CLAIMS.join(', ')}.`);
    }
    if (!isObject(raw['args']))
        throw shapeError(ids, `${at}.args must be an object.`);
    return { claim: raw['claim'], args: raw['args'] };
}
/** The spec ids a stored completion_report (JSON text) does not cover; every id when there is none. */
export function reportMissingIds(stored, ids) {
    if (ids.length === 0)
        return [];
    const report = parseStoredReport(stored);
    const covered = new Set(report?.criteria.map((c) => c.id) ?? []);
    return ids.filter((id) => !covered.has(id));
}
/** A stored completion_report, parsed; null when absent or unreadable. */
export function parseStoredReport(stored) {
    if (!stored)
        return null;
    try {
        const parsed = JSON.parse(stored);
        return parsed && Array.isArray(parsed.criteria) ? parsed : null;
    }
    catch {
        return null;
    }
}
/** A spawn_note argument: null when absent or blank; throws when not a string or over the cap. */
export function parseSpawnNote(raw, tool) {
    if (raw === undefined || raw === null)
        return null;
    if (typeof raw !== 'string')
        throw new Error(`${tool}: spawn_note must be a string.`);
    const note = raw.trim();
    if (note.length > SPAWN_NOTE_MAX_CHARS) {
        throw new Error(`${tool}: spawn_note is ${note.length} characters (max ${SPAWN_NOTE_MAX_CHARS}). ` +
            'Keep it to the context a reviewer cannot read from task_brief; the spec, discussions and completion report are already there.');
    }
    return note === '' ? null : note;
}
//# sourceMappingURL=success-criteria.js.map