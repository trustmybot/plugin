// The L2 concept layer (ADR 0002, GH 1680): agent-written, ordered runs of
// steps over the L1 symbol index, each step anchored by the ADR 0001 key and
// re-checked against the current index after every scan. Read in-process by
// the world_model_concept* tools and the dashboard. Adapted from the GH 1680
// MVP's conceptUpsert / refreshConcepts / evalClaim.
import { spawnSync } from 'node:child_process';
import { nowISO } from '../db.js';
import { keywordSearchSymbols, outsideConceptLane, symbolById } from '../symbol-index.js';
import { splitWords, STOPWORDS } from '../parsing/extract.js';
import { SUBPROCESS_TIMEOUT_MS } from '../utils/timeouts.js';
import { CLAIMS, CONCEPT_KINDS, HANDOFFS, parseStoredReport } from '../success-criteria.js';
import { HAS_PASS_SQL } from '../review-sql.js';
import { insertAudit } from '../tools/audit.js';
export { CLAIMS, CONCEPT_KINDS, HANDOFFS };
export const DERIVED_LABEL = 'derived, unverified';
const DERIVED_MAX_DEPTH = 4;
const DERIVED_MAX_STEPS = 8;
export const DERIVED_SEED_HITS = 5;
const DERIVED_HELPER_FAN_IN = 5;
const DERIVED_EDGES = ['calls', 'sources', 'runs'];
const OR_FALLBACK_MIN_HITS = 3;
const PASS = 'pass';
function anchorLabel(ordinal, a) {
    return `step ${ordinal} ${a.qualified_name || a.path}`;
}
// The hash a step is verified against: the symbol's body_hash, or the file's
// content_md5 for a file anchor (kind ''). null when the anchor is gone.
function currentHash(db, a) {
    if (!a.kind) {
        return db.get(`SELECT content_md5 AS h FROM wm_files WHERE repo = ? AND path = ?`, [a.repo, a.path])?.h ?? null;
    }
    return (db.get(`SELECT body_hash AS h FROM wm_symbols WHERE repo = ? AND path = ? AND kind = ? AND qualified_name = ?`, [a.repo, a.path, a.kind, a.qualified_name])?.h ?? null);
}
function symbolIdAt(db, repo, path, qualifiedName) {
    if (typeof path !== 'string' || typeof qualifiedName !== 'string')
        return null;
    const row = db.get(`SELECT id FROM wm_symbols WHERE repo = ? AND path = ? AND qualified_name = ? ORDER BY kind = 'module', id LIMIT 1`, [repo, path, qualifiedName]);
    return row ? Number(row.id) : null;
}
const ref = (v) => typeof v === 'object' && v !== null ? v : {};
// 'pass', or 'fail: <why>'.
export function evalClaim(db, repo, claim, args) {
    switch (claim) {
        case 'exists':
            return symbolIdAt(db, repo, args['path'], args['qualified_name']) !== null ? PASS : 'fail: no such symbol';
        case 'calls': {
            const from = ref(args['from']);
            const to = ref(args['to']);
            const a = symbolIdAt(db, repo, from.path, from.qualified_name);
            const b = symbolIdAt(db, repo, to.path, to.qualified_name);
            if (a === null || b === null)
                return `fail: no such ${a === null ? 'caller' : 'callee'}`;
            return db.get(`SELECT 1 AS hit FROM wm_edges WHERE src_id = ? AND dst_id = ?`, [a, b]) ? PASS : 'fail: no edge';
        }
        case 'only_writers_of': {
            const table = args['table'];
            const writers = args['writers'];
            if (typeof table !== 'string' || !Array.isArray(writers))
                return 'fail: needs table and writers[]';
            const actual = db
                .all(`SELECT DISTINCT s.path FROM wm_edges e
             JOIN wm_symbols s ON s.id = e.src_id
             JOIN wm_symbols t ON t.id = e.dst_id
            WHERE e.kind = 'writes_table' AND t.qualified_name = ? AND s.repo = ?
            ORDER BY s.path`, [table, repo])
                .map((r) => r.path)
                .filter((p) => !outsideConceptLane(p));
            const extra = actual.filter((p) => !writers.includes(p));
            return extra.length > 0 ? `fail: also written by ${extra.join(', ')}` : PASS;
        }
        case 'tested_by': {
            const a = symbolIdAt(db, repo, args['path'], args['qualified_name']);
            if (a === null)
                return 'fail: no such symbol';
            const hit = db.get(`SELECT 1 AS hit FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id WHERE e.dst_id = ? AND s.path = ?`, [a, args['test_path']]);
            return hit ? PASS : 'fail: no reference from test_path';
        }
        default:
            return 'fail: unknown claim';
    }
}
function headSha(repoPath) {
    if (!repoPath)
        return null;
    const r = spawnSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: SUBPROCESS_TIMEOUT_MS });
    return r.status === 0 ? r.stdout.trim() || null : null;
}
// Replace the concept (repo, name) in one transaction: every step must anchor
// a current symbol (or file, kind '') outside the test lane and every claim
// must pass, or nothing is written. An existing concept keeps its id.
export function upsertConcept(db, input, opts) {
    const name = input.name?.trim();
    if (!name)
        throw new Error('name is required');
    const kind = input.kind ?? 'flow';
    if (!CONCEPT_KINDS.includes(kind))
        throw new Error(`kind must be one of ${CONCEPT_KINDS.join(', ')}`);
    if (!Array.isArray(input.steps) || input.steps.length === 0)
        throw new Error('steps must be a non-empty array');
    const claims = input.claims ?? [];
    if (!Array.isArray(claims))
        throw new Error('claims must be an array');
    const steps = input.steps.map((s, i) => {
        const ordinal = i + 1;
        const anchor = {
            repo: input.repo,
            path: typeof s?.path === 'string' ? s.path : '',
            kind: s?.kind ?? '',
            qualified_name: s?.kind ? (s.qualified_name ?? '') : '',
        };
        const description = typeof s?.description === 'string' ? s.description.trim() : '';
        if (!anchor.path)
            throw new Error(`step ${ordinal}: path is required`);
        if (!description)
            throw new Error(`step ${ordinal}: description is required`);
        if (outsideConceptLane(anchor.path))
            throw new Error(`step ${ordinal}: ${anchor.path} is a test or fixture path`);
        const handoff = ordinal === input.steps.length ? null : (s.handoff ?? null);
        if (handoff !== null && !HANDOFFS.includes(handoff)) {
            throw new Error(`step ${ordinal}: handoff must be one of ${HANDOFFS.join(', ')}`);
        }
        const hash = currentHash(db, anchor);
        if (hash === null) {
            throw new Error(`anchor not found: ${anchorLabel(ordinal, anchor)} (${anchor.path} ${anchor.kind || 'file'})`);
        }
        return { ...anchor, ordinal, description, handoff, hash };
    });
    const evaluated = claims.map((c, i) => {
        if (!CLAIMS.includes(c?.claim))
            throw new Error(`claim ${i + 1}: claim must be one of ${CLAIMS.join(', ')}`);
        const args = typeof c.args === 'object' && c.args !== null ? c.args : {};
        const result = evalClaim(db, input.repo, c.claim, args);
        if (result !== PASS)
            throw new Error(`claim fails at write time: ${c.claim} ${JSON.stringify(args)} → ${result}`);
        return { claim: c.claim, args };
    });
    const sha = headSha(opts.repoPath);
    const now = nowISO();
    const stepsText = steps.map((s) => s.description).join('\n');
    return db.transaction(() => {
        const existing = db.get(`SELECT id FROM wm_concepts WHERE repo = ? AND name = ?`, [input.repo, name]);
        let id;
        if (existing) {
            id = Number(existing.id);
            db.run(`UPDATE wm_concepts
            SET kind = ?, body = ?, status = 'verified', status_reason = NULL, verified_sha = ?, verified_by = ?,
                verified_at = ?, updated_at = ?, steps_text = ?
          WHERE id = ?`, [kind, input.body ?? '', sha, opts.agent, now, now, stepsText, id]);
            db.run(`DELETE FROM wm_concept_steps WHERE concept_id = ?`, [id]);
            db.run(`DELETE FROM wm_concept_claims WHERE concept_id = ?`, [id]);
        }
        else {
            id = Number(db.run(`INSERT INTO wm_concepts (repo, kind, name, body, status, verified_sha, verified_by, verified_at, created_at, updated_at, steps_text)
           VALUES (?, ?, ?, ?, 'verified', ?, ?, ?, ?, ?, ?)`, [input.repo, kind, name, input.body ?? '', sha, opts.agent, now, now, now, stepsText]).lastInsertRowid);
        }
        for (const s of steps) {
            db.run(`INSERT INTO wm_concept_steps (concept_id, ordinal, repo, path, kind, qualified_name, description, handoff, hash_at_verify, trust)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified')`, [id, s.ordinal, s.repo, s.path, s.kind, s.qualified_name, s.description, s.handoff, s.hash]);
        }
        for (const c of evaluated) {
            db.run(`INSERT INTO wm_concept_claims (concept_id, claim, args, last_result) VALUES (?, ?, ?, ?)`, [
                id,
                c.claim,
                JSON.stringify(c.args),
                PASS,
            ]);
        }
        return { id, status: 'verified', steps: steps.length, claims: evaluated.length };
    });
}
const WORST = { verified: 0, suspect: 1, broken: 2 };
// Re-check every live concept of repo against the current index: a step
// whose anchor's hash moved is suspect, one whose anchor is gone is broken,
// a failing claim breaks the concept. The concept takes its worst step's
// trust, with a reason naming each step or claim that is off.
export function refreshConcepts(db, repo) {
    const concepts = db.all(`SELECT id, status, status_reason FROM wm_concepts WHERE repo = ? AND status <> 'retired' ORDER BY id`, [repo]);
    let changed = 0;
    db.transaction(() => {
        for (const c of concepts) {
            let status = 'verified';
            const reasons = [];
            for (const s of db.all(`SELECT * FROM wm_concept_steps WHERE concept_id = ? ORDER BY ordinal`, [c.id])) {
                const hash = currentHash(db, s);
                const trust = hash === null ? 'broken' : hash !== s.hash_at_verify ? 'suspect' : 'verified';
                const reason = trust === 'broken' ? 'anchor gone' : trust === 'suspect' ? 'changed since verification' : null;
                if (reason)
                    reasons.push(`${anchorLabel(Number(s.ordinal), s)}: ${reason}`);
                if (WORST[trust] > WORST[status])
                    status = trust;
                if (trust !== s.trust || reason !== s.trust_reason) {
                    db.run(`UPDATE wm_concept_steps SET trust = ?, trust_reason = ? WHERE concept_id = ? AND ordinal = ?`, [
                        trust,
                        reason,
                        c.id,
                        s.ordinal,
                    ]);
                }
            }
            for (const cl of db.all(`SELECT id, claim, args, last_result FROM wm_concept_claims WHERE concept_id = ? ORDER BY id`, [c.id])) {
                let args = {};
                try {
                    args = JSON.parse(cl.args);
                }
                catch {
                    args = {};
                }
                const result = evalClaim(db, repo, cl.claim, args);
                if (result !== cl.last_result)
                    db.run(`UPDATE wm_concept_claims SET last_result = ? WHERE id = ?`, [result, cl.id]);
                if (result !== PASS) {
                    status = 'broken';
                    reasons.push(`claim ${cl.claim}: ${result}`);
                }
            }
            const reason = reasons.length > 0 ? reasons.join('; ') : null;
            if (status !== c.status || reason !== c.status_reason) {
                db.run(`UPDATE wm_concepts SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?`, [status, reason, nowISO(), c.id]);
                changed++;
            }
        }
    });
    return { checked: concepts.length, changed };
}
export const PROPOSAL_REJECT_AFTER_DAYS = 14;
const DAY_MS = 86_400_000;
const PROPOSAL_EVENTS = ['concept_proposal_applied', 'concept_proposal_rejected'];
// The concept proposals (report.concepts, GH 1680) of closed tasks with a
// passing code-reviewer verdict for their commit, applied to repo: each
// (task, name) is upserted once, as swe, and recorded by a
// concept_proposal_applied row. A proposal that does not upsert (its anchors
// are not in this checkout's index yet) stays pending until the task has been
// closed PROPOSAL_REJECT_AFTER_DAYS, then gets a concept_proposal_rejected row
// with the error. A proposal with no repo (its task had none) belongs to the
// sole repos row. A task's close time is its updated_at (tasks has no
// closed_at).
export function applyConceptProposals(db, repo, repoPath, now = new Date()) {
    const stats = { applied: 0, rejected: 0, pending: 0 };
    const repos = db.get(`SELECT COUNT(*) AS n, MAX(name) AS name FROM repos`);
    const soleRepo = Number(repos?.n) === 1 ? repos?.name ?? null : null;
    const tasks = db.all(`SELECT t.id, t.issue_id, t.branch_id, t.repo, t.updated_at, t.completion_report FROM tasks t
      WHERE t.status = 'closed'
        AND CASE WHEN json_valid(t.completion_report) THEN json_type(t.completion_report, '$.concepts') END = 'array'
        AND ${HAS_PASS_SQL}
      ORDER BY t.id`);
    if (tasks.length === 0)
        return stats;
    const settled = new Set(db
        .all(`SELECT json_extract(content_json, '$.task_id') AS task_id, json_extract(content_json, '$.name') AS name
           FROM audit WHERE event_type IN (${PROPOSAL_EVENTS.map((e) => `'${e}'`).join(', ')}) AND json_valid(content_json)`)
        .map((r) => `${Number(r.task_id)}\u0000${r.name}`));
    const at = now.toISOString();
    for (const t of tasks) {
        const expired = (now.getTime() - Date.parse(t.updated_at)) / DAY_MS >= PROPOSAL_REJECT_AFTER_DAYS;
        for (const c of parseStoredReport(t.completion_report)?.concepts ?? []) {
            if ((c.repo ?? t.repo ?? soleRepo) !== repo)
                continue;
            const taskId = Number(t.id);
            if (settled.has(`${taskId}\u0000${c.name}`))
                continue;
            const audit = { issue_id: Number(t.issue_id), branch_id: t.branch_id, from_node: 'bro', repo, created_at: at };
            try {
                const out = upsertConcept(db, { ...c, repo }, { repoPath, agent: 'swe' });
                insertAudit(db, {
                    ...audit,
                    event_type: 'concept_proposal_applied',
                    summary: `Concept '${c.name}' proposed by task ${taskId} applied`,
                    content_json: JSON.stringify({ task_id: taskId, concept_id: out.id, name: c.name }),
                });
                stats.applied++;
            }
            catch (e) {
                if (!expired) {
                    stats.pending++;
                    continue;
                }
                insertAudit(db, {
                    ...audit,
                    event_type: 'concept_proposal_rejected',
                    summary: `Concept '${c.name}' proposed by task ${taskId} rejected`,
                    content_json: JSON.stringify({ task_id: taskId, name: c.name, error: e.message }),
                });
                stats.rejected++;
            }
        }
    }
    return stats;
}
function queryWords(query) {
    return [...new Set(splitWords(query).split(' ').filter((w) => w.length > 1 && !STOPWORDS.has(w)))];
}
const WORD_MATCH_SQL = {
    wm_concepts_fts: 'SELECT 1 AS hit FROM wm_concepts_fts WHERE wm_concepts_fts MATCH ? AND rowid = CAST(? AS INTEGER)',
    wm_symbols_fts: 'SELECT 1 AS hit FROM wm_symbols_fts WHERE wm_symbols_fts MATCH ? AND rowid = CAST(? AS INTEGER)',
    wm_files_fts: 'SELECT 1 AS hit FROM wm_files_fts WHERE wm_files_fts MATCH ? AND rowid = CAST(? AS INTEGER)',
};
// How many query words the row's own FTS entry matches, one quoted MATCH per
// word so the count follows the porter tokenizer. The CAST matters: a bound
// JS number arrives as REAL, and FTS5's rowid lookup then drops the MATCH.
function wordsMatched(db, table, rowid, words) {
    return words.filter((w) => db.get(WORD_MATCH_SQL[table], [`"${w}"`, rowid]) !== undefined).length;
}
function majority(words) {
    return Math.floor(words.length / 2) + 1;
}
// bm25 over name, body and the joined step descriptions, a name match
// weighted highest: every word first, then, when that finds fewer than 3,
// any concept that matches a majority of the words.
export function searchConcepts(db, repo, query, limit) {
    const words = queryWords(query);
    if (words.length === 0)
        return [];
    const search = (op) => db.all(`SELECT c.id, c.name, c.body
         FROM wm_concepts_fts CROSS JOIN wm_concepts c ON c.id = wm_concepts_fts.rowid
        WHERE wm_concepts_fts MATCH ? AND c.repo = ? AND c.status <> 'retired'
        ORDER BY bm25(wm_concepts_fts, 10.0, 4.0, 2.0), c.id
        LIMIT ?`, [words.map((w) => `"${w}"`).join(` ${op} `), repo, limit]);
    let rows = search('AND');
    if (rows.length < OR_FALLBACK_MIN_HITS && words.length > 1) {
        const seen = new Set(rows.map((r) => Number(r.id)));
        const covered = (id) => wordsMatched(db, 'wm_concepts_fts', id, words) >= majority(words);
        rows = [...rows, ...search('OR').filter((r) => !seen.has(Number(r.id)) && covered(Number(r.id)))].slice(0, limit);
    }
    return rows.map((r, i) => {
        const counts = db.all(`SELECT trust, COUNT(*) AS n FROM wm_concept_steps WHERE concept_id = ? GROUP BY trust`, [r.id]);
        const trust = { verified: 0, suspect: 0, broken: 0 };
        for (const c of counts)
            trust[c.trust] = Number(c.n);
        return {
            id: Number(r.id),
            name: r.name,
            body: r.body,
            step_count: trust.verified + trust.suspect + trust.broken,
            trust,
            rank: i + 1,
        };
    });
}
function stepSymbol(s) {
    return {
        id: s.id,
        repo: s.repo,
        path: s.path,
        kind: s.kind,
        qualified_name: s.qualified_name,
        signature: s.signature,
        doc: s.doc,
        line_start: s.start_line,
        line_end: s.end_line,
    };
}
function fileAnchor(db, a) {
    if (!db.get(`SELECT 1 AS hit FROM wm_files WHERE repo = ? AND path = ?`, [a.repo, a.path]))
        return null;
    return {
        id: null,
        repo: a.repo,
        path: a.path,
        kind: 'file',
        qualified_name: a.path,
        signature: null,
        doc: null,
        line_start: null,
        line_end: null,
    };
}
// A step's anchor resolved by its key at read time, or null when it is gone.
function anchorSymbol(db, a) {
    if (!a.kind)
        return fileAnchor(db, a);
    const row = db.get(`SELECT id FROM wm_symbols WHERE repo = ? AND path = ? AND kind = ? AND qualified_name = ?`, [a.repo, a.path, a.kind, a.qualified_name]);
    const symbol = row ? symbolById(db, Number(row.id)) : null;
    return symbol ? stepSymbol(symbol) : null;
}
export function getConcept(db, id) {
    const c = db.get(`SELECT id, name, body, status, status_reason, updated_at FROM wm_concepts WHERE id = ?`, [id]);
    if (!c)
        return null;
    const steps = db.all(`SELECT * FROM wm_concept_steps WHERE concept_id = ? ORDER BY ordinal`, [id]).map((s) => {
        const symbol = anchorSymbol(db, s);
        return {
            ordinal: Number(s.ordinal),
            description: s.description,
            trust: symbol === null && s.kind ? 'broken' : s.trust,
            trust_reason: symbol === null && s.kind ? 'anchor gone' : s.trust_reason,
            handoff: s.handoff,
            symbol,
        };
    });
    return {
        id: Number(c.id),
        name: c.name,
        body: c.body,
        status: c.status,
        status_reason: c.status_reason,
        updated_at: c.updated_at,
        steps,
    };
}
function outgoingDerived(db, id) {
    return Number(db.get(`SELECT COUNT(*) AS n FROM wm_edges
        WHERE src_id = ? AND resolution = 'exact' AND kind IN (SELECT value FROM json_each(?))`, [id, JSON.stringify(DERIVED_EDGES)]).n);
}
// A utility many callers reach that leads nowhere, e.g. an error_json.
function isLeafHelper(db, id) {
    const callers = db.get(`SELECT COUNT(DISTINCT src_id) AS n FROM wm_edges WHERE dst_id = ? AND kind = 'calls' AND resolution = 'exact'`, [id]).n;
    return Number(callers) >= DERIVED_HELPER_FAN_IN && outgoingDerived(db, id) === 0;
}
// A file's best symbol: most query words matched, then most outgoing derived
// edges, then the earliest. Module rows are left to the file, as in symbol
// search.
function fileSeed(db, repo, path, words) {
    const ids = db.all(`SELECT id FROM wm_symbols WHERE repo = ? AND path = ? AND kind <> 'module' ORDER BY start_line, id`, [repo, path]);
    let best = null;
    for (const row of ids) {
        const id = Number(row.id);
        const c = { id, matched: wordsMatched(db, 'wm_symbols_fts', id, words), out: outgoingDerived(db, id) };
        if (!best || c.matched > best.matched || (c.matched === best.matched && c.out > best.out))
            best = c;
    }
    return best ? symbolById(db, best.id) : null;
}
// The first search hit, in rank order, outside the test lane whose own FTS
// entry covers a majority of the query words: a symbol seeds itself, a file
// its best symbol.
function seedSymbol(db, repo, query, candidates) {
    const words = queryWords(query);
    if (words.length === 0)
        return null;
    for (const c of candidates) {
        if (c.kind === 'symbol') {
            const s = symbolById(db, c.id);
            if (s && !outsideConceptLane(s.path) && wordsMatched(db, 'wm_symbols_fts', s.id, words) >= majority(words))
                return s;
            continue;
        }
        if (outsideConceptLane(c.path))
            continue;
        const file = db.get(`SELECT id FROM wm_files WHERE repo = ? AND path = ?`, [repo, c.path]);
        if (!file || wordsMatched(db, 'wm_files_fts', Number(file.id), words) < majority(words))
            continue;
        const s = fileSeed(db, repo, c.path, words);
        if (s)
            return s;
    }
    return null;
}
// A chain read off the index when no concept matches: the first of the
// caller's ranked search hits with majority word coverage seeds a
// breadth-first walk over exact calls, sources and runs edges (in source-line
// order), depth 4, at most 8 steps, test and fixture paths and leaf helpers
// skipped. Unverified by construction. A caller with no world-model ranking
// (the dashboard) passes no candidates and gets the top keyword symbol hits.
export function derivedChain(db, repo, query, candidates = keywordSearchSymbols(db, repo, query, DERIVED_SEED_HITS).hits.map((h) => ({ kind: 'symbol', id: h.id }))) {
    const seed = seedSymbol(db, repo, query, candidates);
    if (!seed)
        return null;
    const order = [];
    const seen = new Set([seed.id]);
    let frontier = [seed];
    for (let depth = 0; frontier.length > 0 && order.length < DERIVED_MAX_STEPS; depth++) {
        const next = [];
        for (const s of frontier) {
            if (order.length >= DERIVED_MAX_STEPS)
                break;
            const via = new Map();
            order.push({ symbol: s, via });
            if (depth >= DERIVED_MAX_DEPTH)
                continue;
            const out = db.all(`SELECT e.dst_id, e.kind, d.path
           FROM wm_edges e JOIN wm_symbols d ON d.id = e.dst_id
          WHERE e.src_id = ? AND e.resolution = 'exact' AND e.kind IN (SELECT value FROM json_each(?))
          ORDER BY e.line, e.rowid`, [s.id, JSON.stringify(DERIVED_EDGES)]);
            for (const e of out) {
                const dst = Number(e.dst_id);
                if (seen.has(dst) || outsideConceptLane(e.path))
                    continue;
                seen.add(dst);
                if (isLeafHelper(db, dst))
                    continue;
                const row = symbolById(db, dst);
                if (!row)
                    continue;
                via.set(dst, e.kind);
                next.push(row);
            }
        }
        frontier = next;
    }
    const steps = order.map(({ symbol, via }, i) => {
        const following = order[i + 1]?.symbol.id;
        return {
            ordinal: i + 1,
            description: symbol.doc || symbol.signature,
            trust: null,
            trust_reason: null,
            handoff: following !== undefined ? (via.get(following) ?? null) : null,
            symbol: stepSymbol(symbol),
        };
    });
    return { label: DERIVED_LABEL, steps };
}
//# sourceMappingURL=concepts.js.map