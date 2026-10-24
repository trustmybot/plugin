# ADR 0002: World model concept layer — ordered, anchored steps and derived chains

- **Status:** Accepted (2026-10-24)
- **Date:** 2026-10-24
- **Issue:** GH 1680
- **Deciders:** Human (approved in the World Model session, 2026-10-24), bro (proposal)

## Context

[ADR 0001](./0001-world-model-structural-layer.md) built L1: symbols and edges kept fresh by scan (schema v44). It left L2, the concepts an agent writes about the code, to this ADR, and fixed the key L2 anchors by: `repo + path + kind + qualified_name`, with `body_hash` for staleness. It reserved `wm_concepts`, `wm_concept_anchors` and `wm_concept_claims`.

L1 answers "where is X" and "who calls X". It cannot answer "how does a scan reach the parser" or "what runs at session start, in what order". Those answers are flows: an ordered run of symbols, with a handoff from each to the next. Today an agent rebuilds them by reading code, every time.

The GH 1680 MVP (`conceptUpsert`, `refreshConcepts`, `evalClaim`) showed concepts with unordered anchors and write-time claims. A refactored anchor turned its concept `suspect`, and a second writer of a table turned an `only_writers_of` claim `broken`, with no LLM involved. It also showed two gaps: an unordered anchor set cannot describe a flow, and a concept with one stale anchor gave no hint which part was stale.

## Decision

1. **Steps replace anchors.** A concept is an ordered list of steps, each anchored by the ADR 0001 key. `wm_concept_steps` takes the place of the reserved `wm_concept_anchors`. Anchors store the key, not a symbol id, and resolve to a symbol at read time, so a re-parse that changes ids never orphans a step.

   ```sql
   CREATE TABLE wm_concepts (
     id INTEGER PRIMARY KEY,
     repo TEXT NOT NULL,
     kind TEXT NOT NULL,           -- flow, subsystem, invariant
     name TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL,         -- verified, suspect, broken, retired
     status_reason TEXT,
     verified_sha TEXT, verified_by TEXT, verified_at TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
     steps_text TEXT NOT NULL DEFAULT '',  -- the step descriptions, joined, for FTS
     UNIQUE (repo, name)
   );
   CREATE TABLE wm_concept_steps (
     concept_id INTEGER NOT NULL REFERENCES wm_concepts(id) ON DELETE CASCADE,
     ordinal INTEGER NOT NULL,
     repo TEXT NOT NULL, path TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT '',        -- '' anchors the whole file
     qualified_name TEXT NOT NULL DEFAULT '',
     description TEXT NOT NULL,
     handoff TEXT,                 -- calls, sources, runs, hook_fires; NULL on the last step
     hash_at_verify TEXT NOT NULL, -- body_hash, or the file's content_md5 for kind ''
     trust TEXT NOT NULL,          -- verified, suspect, broken
     trust_reason TEXT,
     PRIMARY KEY (concept_id, ordinal)
   );
   CREATE TABLE wm_concept_claims (
     id INTEGER PRIMARY KEY,
     concept_id INTEGER NOT NULL REFERENCES wm_concepts(id) ON DELETE CASCADE,
     claim TEXT NOT NULL,          -- exists, calls, only_writers_of, tested_by
     args TEXT NOT NULL,           -- JSON
     last_result TEXT              -- 'pass' or 'fail: <why>'
   );
   -- wm_concepts_fts: external-content FTS5 over (name, body, steps_text), tokenize 'porter unicode61'
   ```

   `steps_text` is stored rather than joined at query time because an external-content FTS5 delete needs the exact old values.
2. **Writes are all or nothing.** `world_model_concept_upsert` (bro and consultants) replaces a concept by `(repo, name)` in one transaction and keeps its id. Every step must resolve to a current `wm_symbols` row (a `wm_files` row when `kind` is `''`) outside the test lane, and every claim must pass. Otherwise it returns an error and writes nothing. `hash_at_verify` is the anchor's current hash and `verified_sha` is `git rev-parse HEAD`.
3. **Trust rules.** After symbol indexing, every scan re-checks each live concept of the repo:
   - an anchor whose hash moved makes its step `suspect` (`changed since verification`);
   - an anchor that is gone makes its step `broken` (`anchor gone`);
   - a failing claim makes the concept `broken`;
   - the concept takes its worst step's trust, and `status_reason` names each step (`step 3 isTestPath: changed since verification`) or claim that is off. A re-upsert restores `verified`; `retired` concepts are skipped.
4. **Search contract.** `world_model_concepts({query, repo?})` returns `{available, concepts: [{id, name, body, step_count, trust: {verified, suspect, broken}, rank}], derived}`. Concepts rank by bm25 (name 10, body 4, step text 2): every query word first, then any word when that finds fewer than 3. `world_model_concept_get({id})` returns the concept with its steps in ordinal order, each step's symbol resolved now (`null`, with trust `broken`, when the anchor is gone). A file anchor (`kind` `''`) resolves to `{id: null, repo, path, kind: 'file', qualified_name: <path>, signature: null, doc: null, line_start: null, line_end: null}` whether or not the file is parsed, and keeps the trust the last refresh gave it.
5. **Derived rule.** When no concept matches, `derived` is a chain read off L1, labelled `derived, unverified`: the top symbol hit seeds a breadth-first walk over `exact` `calls`, `sources` and `runs` edges in source-line order, to depth 4 and at most 8 steps. Each step's description is the symbol's doc, else its signature. It is never stored and carries no trust.
6. **Lane.** `test/`, `tests/`, `fixtures/` and `__fixtures__/` paths (and `*.test.*` files) never anchor a step or join a derived chain.
7. **L1 additions the layer needs.**
   - `hooks/hooks.json` entries become `kind='hook'` symbols named `<Event>#<pos>:<gate>`, with `wm_symbols.run_order` = event rank × 100 + position. Rank follows the Claude Code lifecycle; events it does not name go right after `Stop`, in file order. Each hook has a `runs` edge to `scripts/hooks/<gate>.sh`, or one per member, in order, when `scripts/hooks/lib/registrations.sh` makes the gate a dispatch chain. `run_order` is NULL for every other symbol.
   - `doc` holds a symbol's full leading comment block, capped at 1000 characters, and a `description:` string inside it.
   - `wm_edges.hint` keeps each edge's import specifier, so a later scan can re-resolve it without re-parsing the caller: after indexing, edges whose `dst_name` names a symbol this scan inserted and that are not exact or lost their target, plus every edge whose target this scan deleted (`dst_id` cleared by `ON DELETE SET NULL`), are resolved again. A callee that is added, moved to another file or re-created under a new kind therefore leaves the caller's edge as a fresh full index would.

## Options considered

| Option | Why not chosen |
|---|---|
| Keep the MVP's unordered `wm_concept_anchors` | Cannot express a flow's order or its handoffs, and one stale anchor marks the whole concept with no pointer to where. |
| Store `symbol_id` on a step | Ids change when a file's definitions are rebuilt; the anchor key survives that and is what ADR 0001 fixed. |
| Store derived chains as concepts | They would look as trusted as a verified flow. Derived chains stay computed and labelled. |
| LLM-written step descriptions or embeddings | Out of scope here: descriptions come from the agent that writes the concept, and FTS5 is enough to find concepts by name and step text. |

## Consequences

**Gains**

- A flow, written once, is found by search and checked on every scan. Drift shows the step that moved, not just the concept.
- Hook order is queryable from the index, so "what runs at session start" is a derived chain even before anyone writes the concept.
- An edge to a symbol that lands later resolves on the next scan without touching the caller.

**Costs and risks**

- A rename turns every concept anchored to the old name `broken` until someone re-upserts it.
- The migration rebuilds `wm_symbols` (new `kind` CHECK and `run_order`) keeping ids, and clears `wm_files.symbols_md5`, so the first scan after upgrading re-parses every file.
- Claims are a fixed set of four. A new claim kind is a code change.

## Validation

| # | Check | Result |
|---|---|---|
| 1 | A 3-step concept over the indexed worktree writes 1 verified concept, 3 ordered steps (last handoff NULL) and a passing `calls` claim, and is found by a word only a step uses | **Pass** (`world-model-concepts.test.ts`) |
| 2 | Editing an anchored body makes step and concept `suspect`, deleting it `broken`, re-upserting `verified`; an unknown anchor or failing claim writes nothing | **Pass** |
| 3 | SessionStart hooks have strictly increasing `run_order` and exact `runs` edges | **Pass** |
| 4 | A caller edge goes from unresolved to exact once its callee lands, and stays exact when the callee moves to another sourced file or is re-created as a class, without re-parsing the caller and matching a fresh full index | **Pass** |
| 5 | A query no concept matches returns a derived chain of 2+ steps with no test paths | **Pass** |
