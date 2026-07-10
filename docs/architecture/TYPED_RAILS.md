# Typed Rails (introduced v0.10.0)

Architecture-of-record for promoting `files` and `verification` from markdown sections in `spec_body` to typed, schema-validated columns on the `tasks` table — and for rewriting the two enforcement hooks to read those columns instead of scraping markdown. Epic #65 (ratified); shipped incrementally as #673 / local #66.

## Principle

Anything a hook or tool **enforces** must travel as a typed, validated field — never as prose scraped from markdown at enforcement time. Markdown is for the reader (reasoning, context, intent); the machine reads columns.

`spec_body`'s `## Description` stays markdown — it is prose for the SWE agent to read. `## Files` and `## Verification` markdown are non-load-bearing: the scope fence and the verification gate read typed columns instead, and the authoritative source for both is the column.

## Motivation — the markdown-scrape bug class

Scraping a structured allowlist or command list out of free-form markdown is brittle by construction: the parser and the author drift, and the gate either over-blocks or runs the wrong thing. Two production repros, same root cause:

- **`## Files` → "The"** (#137): the scope-fence parser pulled the first whitespace-delimited token off each bullet. A bullet that opened with a prose word ("The handler in `src/...`") contributed `The` as an "allowed dir", and legitimate edits were denied.
- **`## Verification` runs a prose line** (#658/#137, 2026-06-16): `swe-verification-gate.sh` extracted the `## Verification` block and ran **every line** through `bash -c` in the worktree. A spec whose block ended with a prose instruction — `run the new L5/L6 row per the chain-manifest harness` (not a one-line command) — had that sentence executed as a shell command. It exited non-zero and the gate denied the legitimate `task_update_status(completed)`.

Both failures are impossible against a typed array: `files: string[]` and `verification: string[]` are validated at the write boundary, so a bad shape is rejected at authoring time (the model retries) rather than misinterpreted at enforcement time.

## Ratified decisions (#65)

1. **Typed columns.** `tasks.files` and `tasks.verification` are `TEXT` columns holding JSON arrays, defaulting to `'[]'`. `files[]` is the scope-fence allowlist; `verification[]` is the command list the verification gate runs.
2. **Flat schema, no combinators.** The `task_create_batch` per-task schema exposes `files` / `verification` as plain `array` of `string`. No `oneOf` / `allOf` / `anyOf` — flat schemas keep the MCP boundary legible to the model and to the validator.
3. **Validate at the MCP boundary.** Bad shape is rejected at write time with a named error (`typed_field_violation`) so the model can retry. When present, each field must be a **non-empty array of non-empty strings**. Omitting a field is allowed and means "no enforcement" for that hook.
4. **Hooks read columns, not markdown.** `swe-scope-fence.sh` reads `tasks.files`; `swe-verification-gate.sh` reads `tasks.verification`. The `## Files` / `## Verification` awk/sed scraping is deleted.
5. **Author the ADR with the code.** This document ships in the same PR as the mechanism (Human reviews them together) rather than as a separate gate.

## The typed-field contract

| Field | Type (column) | Type (API) | Read by | Empty → |
|---|---|---|---|---|
| `files` | `TEXT` JSON array, default `'[]'` | `files?: string[]` | `swe-scope-fence.sh` | scope fence skips with a warning |
| `verification` | `TEXT` JSON array, default `'[]'` | `verification?: string[]` | `swe-verification-gate.sh` | verification gate skips with a warning |

Write-time validation (`task_create_batch`, before any side effect):

- A field that is present but **not an array** → `typed_field_violation`.
- A field that is present but an **empty array** → `typed_field_violation` (omit the field to disable the hook; don't pass `[]`).
- Any array element that is **not a non-empty string** → `typed_field_violation`.

Enforcement semantics:

- `swe-scope-fence.sh` builds its dir allowlist from `files[]` (each path contributes its containing directory; a root-level file is allowed exactly; a `tests/` parent allows any `tests/` path). An edit outside the allowlist is denied with the allowed dirs + recovery instructions.
- `swe-verification-gate.sh` runs each `verification[]` entry verbatim as a shell command in the task's worktree, bounded by `TMB_VERIFICATION_TIMEOUT_S` (default 240s total). A non-zero exit denies the completion; a timeout denies with a timeout message. A `>=10` char `waive_verification_gate_reason` bypasses with an audit row.

## Clean break — no markdown fallback

The compat rule is a **clean break** (Human's call): the rewritten hooks read the typed columns *only*. There is no fallback to scraping `spec_body` when a typed field is empty.

A task with empty typed fields — pre-migration rows, or a task where bro omitted the field — skips that hook's enforcement with an advisory `additionalContext` message. The migration preserves every existing task row with the empty `'[]'` default, so old open tasks simply run unenforced (acceptable; flagged in the advisory).

To make the break atomic, bro's emission of the typed fields lands in the same PR-set: the `tmb_planning` skill is updated (sibling Task B, prompt-surface) so bro always passes `files[]` / `verification[]` as typed args and never leaves itself unable to satisfy the write-time gate.

## Schema / migration

- `schema.sql` declares `files TEXT NOT NULL DEFAULT '[]'` and `verification TEXT NOT NULL DEFAULT '[]'` on `tasks`, and seeds `plugin_meta` at the current target schema version.
- `db.ts` adds `migrateV12toV13` (the `prompt_bearing` ALTER-TABLE precedent): `ALTER TABLE tasks ADD COLUMN files ...` / `... verification ...`. Existing rows keep the empty-array default; no backfill from `spec_body`.
- Coverage: `schema-upgrade.test.ts` (v12→v13 migration + fresh-DB columns), `schema.test.ts` (column shape + version), `tasks.test.ts` (persistence + validation), and L3 for both hooks reading the typed columns (including the empty→skip-with-warning path).

## Out of scope

- TOON / the full comms-substrate refactor (#65 deferred).
- Promoting any non-task field to typed.
- Resuming #658 (#138).
