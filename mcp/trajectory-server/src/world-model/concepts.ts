// The L2 concept layer (ADR 0002, GH 1680): agent-written, ordered runs of
// steps over the L1 symbol index, each step anchored by the ADR 0001 key and
// re-checked against the current index after every scan. Read in-process by
// the world_model_concept* tools and the dashboard. Adapted from the GH 1680
// MVP's conceptUpsert / refreshConcepts / evalClaim.
import { spawnSync } from 'node:child_process';
import { nowISO, type TrajectoryDB } from '../db.js';
import { keywordSearchSymbols, outsideConceptLane, symbolById, type SymbolRow } from '../symbol-index.js';
import { splitWords, STOPWORDS } from '../parsing/extract.js';
import { SUBPROCESS_TIMEOUT_MS } from '../utils/timeouts.js';

export const CONCEPT_KINDS = ['flow', 'subsystem', 'invariant'] as const;
export const HANDOFFS = ['calls', 'sources', 'runs', 'hook_fires'] as const;
export const CLAIMS = ['exists', 'calls', 'only_writers_of', 'tested_by'] as const;

export type ConceptKind = (typeof CONCEPT_KINDS)[number];
export type Handoff = (typeof HANDOFFS)[number];
export type ClaimKind = (typeof CLAIMS)[number];
export type StepTrust = 'verified' | 'suspect' | 'broken';
export type ConceptStatus = StepTrust | 'retired';

export const DERIVED_LABEL = 'derived, unverified';
const DERIVED_MAX_DEPTH = 4;
const DERIVED_MAX_STEPS = 8;
const DERIVED_SEED_POOL = 20;
const DERIVED_EDGES = ['calls', 'sources', 'runs'];
const OR_FALLBACK_MIN_HITS = 3;

export interface StepInput {
  path: string;
  kind?: string;
  qualified_name?: string;
  description: string;
  handoff?: Handoff | null;
}

export interface ClaimInput {
  claim: ClaimKind;
  args: Record<string, unknown>;
}

export interface ConceptInput {
  repo: string;
  name: string;
  kind?: ConceptKind;
  body?: string;
  steps: StepInput[];
  claims?: ClaimInput[];
}

export interface StepSymbol {
  id: number;
  repo: string;
  path: string;
  kind: string;
  qualified_name: string;
  signature: string;
  doc: string;
  line_start: number;
  line_end: number;
}

// A file anchor (kind '') resolves to the file itself, named by its path.
export interface StepFile {
  id: null;
  repo: string;
  path: string;
  kind: 'file';
  qualified_name: string;
  signature: null;
  doc: null;
  line_start: null;
  line_end: null;
}

export interface Step {
  ordinal: number;
  description: string;
  trust: StepTrust | null;
  trust_reason: string | null;
  handoff: Handoff | null;
  symbol: StepSymbol | StepFile | null;
}

export interface ConceptHit {
  id: number;
  name: string;
  body: string;
  step_count: number;
  trust: Record<StepTrust, number>;
  rank: number;
}

export interface DerivedChain {
  label: typeof DERIVED_LABEL;
  steps: Step[];
}

export interface ConceptDetail {
  id: number;
  name: string;
  body: string;
  status: ConceptStatus;
  status_reason: string | null;
  updated_at: string;
  steps: Step[];
}

interface Anchor {
  repo: string;
  path: string;
  kind: string;
  qualified_name: string;
}

interface StepRow extends Anchor {
  concept_id: number;
  ordinal: number;
  description: string;
  handoff: Handoff | null;
  hash_at_verify: string;
  trust: StepTrust;
  trust_reason: string | null;
}

interface ClaimRow {
  id: number;
  claim: ClaimKind;
  args: string;
  last_result: string | null;
}

const PASS = 'pass';

function anchorLabel(ordinal: number, a: Anchor): string {
  return `step ${ordinal} ${a.qualified_name || a.path}`;
}

// The hash a step is verified against: the symbol's body_hash, or the file's
// content_md5 for a file anchor (kind ''). null when the anchor is gone.
function currentHash(db: TrajectoryDB, a: Anchor): string | null {
  if (!a.kind) {
    return db.get<{ h: string }>(`SELECT content_md5 AS h FROM wm_files WHERE repo = ? AND path = ?`, [a.repo, a.path])?.h ?? null;
  }
  return (
    db.get<{ h: string }>(
      `SELECT body_hash AS h FROM wm_symbols WHERE repo = ? AND path = ? AND kind = ? AND qualified_name = ?`,
      [a.repo, a.path, a.kind, a.qualified_name],
    )?.h ?? null
  );
}

function symbolIdAt(db: TrajectoryDB, repo: string, path: unknown, qualifiedName: unknown): number | null {
  if (typeof path !== 'string' || typeof qualifiedName !== 'string') return null;
  const row = db.get<{ id: number }>(
    `SELECT id FROM wm_symbols WHERE repo = ? AND path = ? AND qualified_name = ? ORDER BY kind = 'module', id LIMIT 1`,
    [repo, path, qualifiedName],
  );
  return row ? Number(row.id) : null;
}

const ref = (v: unknown): { path?: unknown; qualified_name?: unknown } =>
  typeof v === 'object' && v !== null ? (v as { path?: unknown; qualified_name?: unknown }) : {};

// 'pass', or 'fail: <why>'.
export function evalClaim(db: TrajectoryDB, repo: string, claim: string, args: Record<string, unknown>): string {
  switch (claim) {
    case 'exists':
      return symbolIdAt(db, repo, args['path'], args['qualified_name']) !== null ? PASS : 'fail: no such symbol';
    case 'calls': {
      const from = ref(args['from']);
      const to = ref(args['to']);
      const a = symbolIdAt(db, repo, from.path, from.qualified_name);
      const b = symbolIdAt(db, repo, to.path, to.qualified_name);
      if (a === null || b === null) return `fail: no such ${a === null ? 'caller' : 'callee'}`;
      return db.get(`SELECT 1 AS hit FROM wm_edges WHERE src_id = ? AND dst_id = ?`, [a, b]) ? PASS : 'fail: no edge';
    }
    case 'only_writers_of': {
      const table = args['table'];
      const writers = args['writers'];
      if (typeof table !== 'string' || !Array.isArray(writers)) return 'fail: needs table and writers[]';
      const actual = db
        .all<{ path: string }>(
          `SELECT DISTINCT s.path FROM wm_edges e
             JOIN wm_symbols s ON s.id = e.src_id
             JOIN wm_symbols t ON t.id = e.dst_id
            WHERE e.kind = 'writes_table' AND t.qualified_name = ? AND s.repo = ?
            ORDER BY s.path`,
          [table, repo],
        )
        .map((r) => r.path)
        .filter((p) => !outsideConceptLane(p));
      const extra = actual.filter((p) => !writers.includes(p));
      return extra.length > 0 ? `fail: also written by ${extra.join(', ')}` : PASS;
    }
    case 'tested_by': {
      const a = symbolIdAt(db, repo, args['path'], args['qualified_name']);
      if (a === null) return 'fail: no such symbol';
      const hit = db.get(
        `SELECT 1 AS hit FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id WHERE e.dst_id = ? AND s.path = ?`,
        [a, args['test_path']],
      );
      return hit ? PASS : 'fail: no reference from test_path';
    }
    default:
      return 'fail: unknown claim';
  }
}

function headSha(repoPath: string | null): string | null {
  if (!repoPath) return null;
  const r = spawnSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: SUBPROCESS_TIMEOUT_MS });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

// Replace the concept (repo, name) in one transaction: every step must anchor
// a current symbol (or file, kind '') outside the test lane and every claim
// must pass, or nothing is written. An existing concept keeps its id.
export function upsertConcept(
  db: TrajectoryDB,
  input: ConceptInput,
  opts: { repoPath: string | null; agent: string },
): { id: number; status: 'verified'; steps: number; claims: number } {
  const name = input.name?.trim();
  if (!name) throw new Error('name is required');
  const kind = input.kind ?? 'flow';
  if (!CONCEPT_KINDS.includes(kind)) throw new Error(`kind must be one of ${CONCEPT_KINDS.join(', ')}`);
  if (!Array.isArray(input.steps) || input.steps.length === 0) throw new Error('steps must be a non-empty array');
  const claims = input.claims ?? [];
  if (!Array.isArray(claims)) throw new Error('claims must be an array');

  const steps = input.steps.map((s, i) => {
    const ordinal = i + 1;
    const anchor: Anchor = {
      repo: input.repo,
      path: typeof s?.path === 'string' ? s.path : '',
      kind: s?.kind ?? '',
      qualified_name: s?.kind ? (s.qualified_name ?? '') : '',
    };
    const description = typeof s?.description === 'string' ? s.description.trim() : '';
    if (!anchor.path) throw new Error(`step ${ordinal}: path is required`);
    if (!description) throw new Error(`step ${ordinal}: description is required`);
    if (outsideConceptLane(anchor.path)) throw new Error(`step ${ordinal}: ${anchor.path} is a test or fixture path`);
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
    if (!CLAIMS.includes(c?.claim)) throw new Error(`claim ${i + 1}: claim must be one of ${CLAIMS.join(', ')}`);
    const args = typeof c.args === 'object' && c.args !== null ? c.args : {};
    const result = evalClaim(db, input.repo, c.claim, args);
    if (result !== PASS) throw new Error(`claim fails at write time: ${c.claim} ${JSON.stringify(args)} → ${result}`);
    return { claim: c.claim, args };
  });

  const sha = headSha(opts.repoPath);
  const now = nowISO();
  const stepsText = steps.map((s) => s.description).join('\n');
  return db.transaction(() => {
    const existing = db.get<{ id: number }>(`SELECT id FROM wm_concepts WHERE repo = ? AND name = ?`, [input.repo, name]);
    let id: number;
    if (existing) {
      id = Number(existing.id);
      db.run(
        `UPDATE wm_concepts
            SET kind = ?, body = ?, status = 'verified', status_reason = NULL, verified_sha = ?, verified_by = ?,
                verified_at = ?, updated_at = ?, steps_text = ?
          WHERE id = ?`,
        [kind, input.body ?? '', sha, opts.agent, now, now, stepsText, id],
      );
      db.run(`DELETE FROM wm_concept_steps WHERE concept_id = ?`, [id]);
      db.run(`DELETE FROM wm_concept_claims WHERE concept_id = ?`, [id]);
    } else {
      id = Number(
        db.run(
          `INSERT INTO wm_concepts (repo, kind, name, body, status, verified_sha, verified_by, verified_at, created_at, updated_at, steps_text)
           VALUES (?, ?, ?, ?, 'verified', ?, ?, ?, ?, ?, ?)`,
          [input.repo, kind, name, input.body ?? '', sha, opts.agent, now, now, now, stepsText],
        ).lastInsertRowid,
      );
    }
    for (const s of steps) {
      db.run(
        `INSERT INTO wm_concept_steps (concept_id, ordinal, repo, path, kind, qualified_name, description, handoff, hash_at_verify, trust)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified')`,
        [id, s.ordinal, s.repo, s.path, s.kind, s.qualified_name, s.description, s.handoff, s.hash],
      );
    }
    for (const c of evaluated) {
      db.run(`INSERT INTO wm_concept_claims (concept_id, claim, args, last_result) VALUES (?, ?, ?, ?)`, [
        id,
        c.claim,
        JSON.stringify(c.args),
        PASS,
      ]);
    }
    return { id, status: 'verified' as const, steps: steps.length, claims: evaluated.length };
  });
}

const WORST: Record<StepTrust, number> = { verified: 0, suspect: 1, broken: 2 };

// Re-check every live concept of repo against the current index: a step
// whose anchor's hash moved is suspect, one whose anchor is gone is broken,
// a failing claim breaks the concept. The concept takes its worst step's
// trust, with a reason naming each step or claim that is off.
export function refreshConcepts(db: TrajectoryDB, repo: string): { checked: number; changed: number } {
  const concepts = db.all<{ id: number; status: ConceptStatus; status_reason: string | null }>(
    `SELECT id, status, status_reason FROM wm_concepts WHERE repo = ? AND status <> 'retired' ORDER BY id`,
    [repo],
  );
  let changed = 0;
  db.transaction(() => {
    for (const c of concepts) {
      let status: StepTrust = 'verified';
      const reasons: string[] = [];
      for (const s of db.all<StepRow>(`SELECT * FROM wm_concept_steps WHERE concept_id = ? ORDER BY ordinal`, [c.id])) {
        const hash = currentHash(db, s);
        const trust: StepTrust = hash === null ? 'broken' : hash !== s.hash_at_verify ? 'suspect' : 'verified';
        const reason = trust === 'broken' ? 'anchor gone' : trust === 'suspect' ? 'changed since verification' : null;
        if (reason) reasons.push(`${anchorLabel(Number(s.ordinal), s)}: ${reason}`);
        if (WORST[trust] > WORST[status]) status = trust;
        if (trust !== s.trust || reason !== s.trust_reason) {
          db.run(`UPDATE wm_concept_steps SET trust = ?, trust_reason = ? WHERE concept_id = ? AND ordinal = ?`, [
            trust,
            reason,
            c.id,
            s.ordinal,
          ]);
        }
      }
      for (const cl of db.all<ClaimRow>(`SELECT id, claim, args, last_result FROM wm_concept_claims WHERE concept_id = ? ORDER BY id`, [c.id])) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(cl.args) as Record<string, unknown>;
        } catch {
          args = {};
        }
        const result = evalClaim(db, repo, cl.claim, args);
        if (result !== cl.last_result) db.run(`UPDATE wm_concept_claims SET last_result = ? WHERE id = ?`, [result, cl.id]);
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

function queryWords(query: string): string[] {
  return [...new Set(splitWords(query).split(' ').filter((w) => w.length > 1 && !STOPWORDS.has(w)))];
}

// bm25 over name, body and the joined step descriptions, a name match
// weighted highest: every word first, then any word when that finds fewer
// than 3.
export function searchConcepts(db: TrajectoryDB, repo: string, query: string, limit: number): ConceptHit[] {
  const words = queryWords(query);
  if (words.length === 0) return [];
  const search = (op: 'AND' | 'OR') =>
    db.all<{ id: number; name: string; body: string }>(
      `SELECT c.id, c.name, c.body
         FROM wm_concepts_fts CROSS JOIN wm_concepts c ON c.id = wm_concepts_fts.rowid
        WHERE wm_concepts_fts MATCH ? AND c.repo = ? AND c.status <> 'retired'
        ORDER BY bm25(wm_concepts_fts, 10.0, 4.0, 2.0), c.id
        LIMIT ?`,
      [words.map((w) => `"${w}"`).join(` ${op} `), repo, limit],
    );
  let rows = search('AND');
  if (rows.length < OR_FALLBACK_MIN_HITS && words.length > 1) {
    const seen = new Set(rows.map((r) => Number(r.id)));
    rows = [...rows, ...search('OR').filter((r) => !seen.has(Number(r.id)))].slice(0, limit);
  }
  return rows.map((r, i) => {
    const counts = db.all<{ trust: StepTrust; n: number }>(
      `SELECT trust, COUNT(*) AS n FROM wm_concept_steps WHERE concept_id = ? GROUP BY trust`,
      [r.id],
    );
    const trust: Record<StepTrust, number> = { verified: 0, suspect: 0, broken: 0 };
    for (const c of counts) trust[c.trust] = Number(c.n);
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

function stepSymbol(s: SymbolRow): StepSymbol {
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

function fileAnchor(db: TrajectoryDB, a: Anchor): StepFile | null {
  if (!db.get(`SELECT 1 AS hit FROM wm_files WHERE repo = ? AND path = ?`, [a.repo, a.path])) return null;
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
function anchorSymbol(db: TrajectoryDB, a: Anchor): StepSymbol | StepFile | null {
  if (!a.kind) return fileAnchor(db, a);
  const row = db.get<{ id: number }>(
    `SELECT id FROM wm_symbols WHERE repo = ? AND path = ? AND kind = ? AND qualified_name = ?`,
    [a.repo, a.path, a.kind, a.qualified_name],
  );
  const symbol = row ? symbolById(db, Number(row.id)) : null;
  return symbol ? stepSymbol(symbol) : null;
}

export function getConcept(db: TrajectoryDB, id: number): ConceptDetail | null {
  const c = db.get<{ id: number; name: string; body: string; status: ConceptStatus; status_reason: string | null; updated_at: string }>(
    `SELECT id, name, body, status, status_reason, updated_at FROM wm_concepts WHERE id = ?`,
    [id],
  );
  if (!c) return null;
  const steps = db.all<StepRow>(`SELECT * FROM wm_concept_steps WHERE concept_id = ? ORDER BY ordinal`, [id]).map((s) => {
    const symbol = anchorSymbol(db, s);
    return {
      ordinal: Number(s.ordinal),
      description: s.description,
      trust: symbol === null && s.kind ? 'broken' : s.trust,
      trust_reason: symbol === null && s.kind ? 'anchor gone' : s.trust_reason,
      handoff: s.handoff,
      symbol,
    } satisfies Step;
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

// A chain read off the index when no concept matches: the top symbol hit
// seeds a breadth-first walk over exact calls, sources and runs edges (in
// source-line order), depth 4, at most 8 steps, test and fixture paths
// skipped. Unverified by construction.
export function derivedChain(db: TrajectoryDB, repo: string, query: string): DerivedChain | null {
  const seed = keywordSearchSymbols(db, repo, query, DERIVED_SEED_POOL).hits.find((h) => !outsideConceptLane(h.path));
  if (!seed) return null;
  const order: Array<{ symbol: SymbolRow; via: Map<number, Handoff> }> = [];
  const seen = new Set<number>([seed.id]);
  let frontier: SymbolRow[] = [seed];
  for (let depth = 0; frontier.length > 0 && order.length < DERIVED_MAX_STEPS; depth++) {
    const next: SymbolRow[] = [];
    for (const s of frontier) {
      if (order.length >= DERIVED_MAX_STEPS) break;
      const via = new Map<number, Handoff>();
      order.push({ symbol: s, via });
      if (depth >= DERIVED_MAX_DEPTH) continue;
      const out = db.all<{ dst_id: number; kind: Handoff; path: string }>(
        `SELECT e.dst_id, e.kind, d.path
           FROM wm_edges e JOIN wm_symbols d ON d.id = e.dst_id
          WHERE e.src_id = ? AND e.resolution = 'exact' AND e.kind IN (SELECT value FROM json_each(?))
          ORDER BY e.line, e.rowid`,
        [s.id, JSON.stringify(DERIVED_EDGES)],
      );
      for (const e of out) {
        const dst = Number(e.dst_id);
        if (seen.has(dst) || outsideConceptLane(e.path)) continue;
        const row = symbolById(db, dst);
        if (!row) continue;
        seen.add(dst);
        via.set(dst, e.kind);
        next.push(row);
      }
    }
    frontier = next;
  }
  const steps = order.map(({ symbol, via }, i): Step => {
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
