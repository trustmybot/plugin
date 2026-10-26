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

1. **Typed columns.** `tasks.files` and `tasks.verification` are `TEXT` columns holding JSON arrays, defaulting to `'[]'`. `files[]` is the task's expected scope at directory granularity, judged at close; `verification[]` is the command list the verification gate runs.
2. **Flat schema, no combinators.** The `task_create_batch` per-task schema exposes `files` / `verification` as plain `array` of `string`. No `oneOf` / `allOf` / `anyOf` — flat schemas keep the MCP boundary legible to the model and to the validator.
3. **Validate at the MCP boundary.** Bad shape is rejected at write time with a named error (`typed_field_violation`) so the model can retry. When present, each field must be a **non-empty array of non-empty strings**. Omitting a field is allowed and means "no enforcement" for that hook.
4. **Hooks read columns, not markdown.** `swe-scope-fence.sh` reads `tasks.files`; `swe-verification-gate.sh` reads `tasks.verification`. The `## Files` / `## Verification` awk/sed scraping is deleted.
5. **Author the ADR with the code.** This document ships in the same PR as the mechanism (Human reviews them together) rather than as a separate gate.

## The typed-field contract

| Field | Type (column) | Type (API) | Read by | Empty → |
|---|---|---|---|---|
| `files` | `TEXT` JSON array, default `'[]'` | `files?: string[]` | `swe-scope-fence.sh`, `swe-boundary.sh`, `bro_atomic_close` | no edit-time notes; every changed path is an extra at close |
| `verification` | `TEXT` JSON array, default `'[]'` | `verification?: string[]` | `swe-verification-gate.sh` | verification gate skips with a warning |
| `effort` | `TEXT NOT NULL DEFAULT 'medium'`, `CHECK (effort IN ('low','medium','high'))` | `effort?: 'low' \| 'medium' \| 'high'` (`task_create_batch`, `task_provision`; `task_reopen` / `task_retry` may raise it) | `require-spawn-effort.sh` (the swe Agent call must pass it), `swe-atomic-close.sh` (copies it onto the swe `agent_runs.effort`) | `plugin_config.swe_default_effort`, `medium` when unset |

Write-time validation (`task_create_batch`, before any side effect):

- A field that is present but **not an array** → `typed_field_violation`.
- A field that is present but an **empty array** → `typed_field_violation` (omit the field to disable the hook; don't pass `[]`).
- Any array element that is **not a non-empty string** → `typed_field_violation`.
- An `effort` that is present but not `low`, `medium` or `high` → `typed_field_violation` (also on `task_provision`, `task_reopen`, `task_retry`).

Enforcement semantics:

- A `files[]` entry covers the path itself and everything beneath it, never its siblings (the CODEOWNERS / git-pathspec rule): `src/a/b.ts` covers only that file, `src/a/` (or `src/a`) the whole directory, and any `tests/` entry covers all of `tests/`. `lib/scope-fence.sh` and `bro_atomic_close` apply the same rule. An edit outside it is allowed; `swe-scope-fence.sh` (Edit/Write) and `swe-boundary.sh` (Bash) add a once-per-path note asking the swe to report it. `bro_atomic_close` diffs the task's own commits (from the merge-base with the base `task_provision` cut from, or with `origin/<pr_target>` when that is newer) against `files[]` and refuses on extras, listed by surface, until bro reverts them or accepts them with `waive_scope_gate` + `scope_waiver_reason`.
- `swe-verification-gate.sh` runs each `verification[]` entry verbatim as a shell command in the task's worktree, bounded by `plugin_config.verification_timeout_s` (default 900 s of command time, clamped to 1–1800 s; `TMB_VERIFICATION_TIMEOUT_S` overrides it for tests), and records the run in `verification_runs` / `verification_run_commands` — the record writes are budgeted apart from the commands, and a worktree whose HEAD does not resolve is verified without a record. A non-zero exit (including a command's own 124) denies the completion naming the command and its timing; a spent budget or the gate's own timeout firing denies naming the command that was running. A passing run for the same task, worktree HEAD and `verification[]` recorded within the hour is reused instead of re-run. On a rework commit, a command whose inputs declared in `.config/tmb/verification-inputs.json` the commits since the task's last passing run did not touch is recorded as carried from that run instead of re-run (GH 1950). A `>=10` char `waive_verification_gate_reason` bypasses with an audit row. `bro_atomic_close` refuses with `verification_run_missing` unless the closing commit has a passing run of the current `verification[]` or a `verification_gate_waived` row, so an amended `verification[]` needs a new run (GH 1672).

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
