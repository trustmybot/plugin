# Project Metadata + Consultant Role Doctrine + Skill Audit Tier 1

**Issue**: #179
**ADR**: `manual/decisions/0002-deterministic-stack-detection.md` (sibling)
**Status**: comprehensive PR — design ratified by decision rows #223 (scope A) and #228 (scope expansion to B + C). SWE-bound.

## Scopes in this PR

This PR bundles three concerns. Each is independently reviewable but ships in one merge for coherence (every prompt/MCP/hook issue we've identified, in one pass).

- **Scope A — Stack detection** (the original feature): bash script + MCP tool + skill consumption. Detail: §§A.1–A.6 below.
- **Scope B — Consultant role doctrine fix**: replace architect-named writes with a consultant role category. Detail: §B below.
- **Scope C — Skill audit Tier 1**: drop wire-enforced prose from `tmb_mcp-error-handling`; tighten 4 thin descriptions. Detail: §C below.

---

# Scope A — Deterministic Stack Detection

## Problem

Bro's planning skills (`tmb_planning-difficult`, `tmb_planning-simple`) currently re-probe the project's stack via prompt-engineered bash blocks every time they fire — `python3 --version`, `command -v uv`, `ls pyproject.toml`, etc. Three failures:

1. **Non-deterministic**: a probe block in a prompt is interpreted by the LLM. Output formatting drifts.
2. **Stack-baked**: the prompt enumerates Python/Node/Go/Rust/etc.; adding a new ecosystem means editing every planning skill.
3. **Re-run every turn**: every fresh-session bro probes again. The probe outcome is never persisted.

GitHub solved this class with **Linguist** — a deterministic tool that scans a repo on push, persists language metadata, and is read by the UI. Zero LLM. Mirror that pattern.

## Goal

A deterministic, persisted stack-detection layer:

- **Detection**: pure shell script, hookable, hybrid with OSS detectors when installed.
- **Persistence**: trajectory DB row, MCP-tool API.
- **Consumption**: skills read via `project_metadata_get`; never re-probe.
- **Drift**: re-run idempotent on every prescan; act on `changed=true` from `lazy-regen-check`.

## Architecture

```
                                    ┌────────────────────────────────────┐
                                    │ trajectory DB (config table)       │
                                    │ key: _meta_detected_stack          │
                                    │ value: {languages, package_managers,│
                                    │        test_runners, linters,       │
                                    │        git_remotes, detected_at,    │
                                    │        detector}                    │
                                    └────────────────────────────────────┘
                                             ▲                ▲
                            persists on detect│                │reads on get
                                             │                │
┌──────────────────────────────────┐   ┌─────┴────────┐   ┌───┴──────────────┐
│ skills/tmb_project-prescan/      │   │ MCP server   │   │ skills/          │
│   scripts/detect-stack.sh        │   │ tools/       │   │   tmb_planning-  │
│   (bash, hookable, JSON stdout)  ├──▶│   project-   │◀──┤   difficult      │
│                                  │   │   metadata.ts│   │   tmb_planning-  │
│                                  │   │              │   │   simple         │
└──────────────────────────────────┘   └──────────────┘   └──────────────────┘
        ▲                                       ▲
        │ exec (bash <path>)                    │ requireRoles
        │                                       │
   ┌────┴──────────────────┐               ┌────┴────────────────────┐
   │ tmb_project-prescan   │               │ project_metadata_detect │
   │   (Phase 3, idempotent)│               │   roles: ['bro']        │
   │                       │               │ project_metadata_get    │
   │ lazy-regen-check      │               │   roles: ['bro','swe',  │
   │   (drift trigger)     │               │           'pr-reviewer']│
   └───────────────────────┘               └─────────────────────────┘
```

## Components

### 1. Bash script — `plugin/skills/tmb_project-prescan/scripts/detect-stack.sh`

**Contract**:
- Pure POSIX-ish bash (target macOS + Linux).
- Args: optional `--cwd <path>` (default: `$PWD`).
- Exit 0 on success; exit ≥1 on argument or runtime error.
- Stdout: a single JSON object matching the schema below. No stderr noise on the happy path.
- Hookable: any hook (PreToolUse, PostToolUse, SessionStart) can invoke and pipe.

**Detection ladder** (languages):

```
1. enry --json    if installed → use enry's languages list
2. tokei --output json if installed → use tokei's languages list
3. file-presence heuristic (always available) → used as primary when neither OSS detector is on PATH
```

**Detection** (package managers, test runners, linters, remotes): always file-presence + `command -v` + `git remote -v` (no OSS solves these).

**Output schema** (JSON):

```json
{
  "files_present": ["pyproject.toml", "package.json", "tsconfig.json"],
  "languages": ["python", "typescript", "javascript"],
  "package_managers": ["uv", "bun", "npm"],
  "test_runners": ["pytest", "vitest"],
  "linters": ["ruff", "eslint"],
  "git_remotes": [
    {"name": "origin", "provider": "github", "url": "git@github.com:foo/bar.git"}
  ],
  "detector": "file-presence",
  "detected_at": "2026-05-05T12:34:56Z"
}
```

`detector` field values: `"enry"`, `"tokei"`, or `"file-presence"`. Used by callers to know which signal generated `languages`.

**File-presence heuristic table**:

| File present | Adds language |
|---|---|
| `pyproject.toml`, `requirements.txt`, `setup.py`, `Pipfile` | `python` |
| `package.json` | `javascript` |
| `tsconfig.json` | `typescript` |
| `Cargo.toml` | `rust` |
| `go.mod` | `go` |
| `Gemfile` | `ruby` |
| `pom.xml`, `build.gradle` | `java` |
| `build.gradle.kts` | `kotlin` |
| `composer.json` | `php` |
| `mix.exs` | `elixir` |

`languages` is deduplicated and sorted.

**`command -v` table**:

- package_managers: uv, poetry, pip, pipx, bun, pnpm, npm, yarn, cargo, go, bundler, maven, gradle, composer, mix
- test_runners: pytest, jest, vitest, mvn, gradle, rspec
- linters: ruff, black, eslint, prettier, clippy, gofmt, rubocop

(Note: `cargo` and `go` appear in both package_managers and test_runners conceptually — emit them once in package_managers; test invocations use `cargo test` / `go test` which the planning skill knows.)

**Git remote provider mapping** (re-uses the mapping from `tmb_reonboard` Step 1.5):

| URL contains | provider |
|---|---|
| `github.com` | `github` |
| `gitlab.com` or `gitlab.<corp>.<tld>` | `gitlab` |
| `bitbucket.org` | `bitbucket` |
| `codeberg.org` | `codeberg` |
| `dev.azure.com` | `azuredev` |
| anything else | `other` |

### 2. MCP tool — `plugin/mcp/trajectory-server/src/tools/project-metadata.ts`

Two handlers in one module, registered by `tools/index.ts`.

**`project_metadata_detect(agent, repo_path?)`**

```typescript
inputSchema: {
  agent: 'bro',
  repo_path?: string  // default: process.cwd(); used as --cwd to the script
}
```

Behavior:

1. Resolve script path: `${PLUGIN_ROOT}/skills/tmb_project-prescan/scripts/detect-stack.sh`. Error if missing.
2. `execFileSync('bash', [script_path, '--cwd', repo_path], { timeout: 5000, encoding: 'utf-8' })`. Surface non-zero exits as `is_error: true` with the captured stderr in the message.
3. Parse stdout as JSON. On parse failure → `is_error: true`.
4. Read existing `_meta_detected_stack` from `config` table.
5. Compare detected `languages`, `package_managers`, `test_runners`, `linters` (sorted, stringified) against existing. `changed = old !== new` OR `existing === null`.
6. Persist via existing `config` table write logic (same shape as `config_set(key='_meta_detected_stack', value=detected)`).
7. Return:

```json
{
  "detected": <full schema object>,
  "changed": true|false,
  "previous_detected_at": "2026-05-04T12:00:00Z" | null
}
```

`requireRoles: ['bro']` — only bro persists; other agents must trigger detection through bro.

**`project_metadata_get(agent)`**

```typescript
inputSchema: {
  agent: 'bro' | 'swe' | 'pr-reviewer'
}
```

Behavior:

1. Read `_meta_detected_stack` from `config` table.
2. Return parsed object or `null`.
3. No write side-effects.

`requireRoles: ['bro', 'swe', 'pr-reviewer']` — read-side is broader.

### 3. Storage

Existing `config` table. New row:

```sql
-- key: '_meta_detected_stack'
-- value_json: <full schema object>
```

**Naming contract**: keys prefixed `_meta_` are auto-detected metadata, written by `project_metadata_detect` (NOT by `config_set`). Keys without that prefix (`branching_model`, `pr_target`, `protected_branches`, `remotes`) remain user-set policy. The `config` table doesn't enforce the prefix — convention only — but `project_metadata_detect` MUST always use the `_meta_` prefix when writing.

No migration. No new table.

### 4. Skill consumption

**`tmb_project-prescan` SKILL.md** — gain a new Phase 3 step:

```
### Phase 3 — stack detection

Call once per prescan. Idempotent — the handler diffs the previous value before persisting.

```
project_metadata_detect(agent='bro')
```

If `changed=true`: persisted value differs from prior run. Downstream skills that already loaded a stale read should re-fetch.
```

**`lazy-regen-check`** — already detects file-registry drift. Add a sibling call to `project_metadata_detect`; act on `changed=true` by emitting a `kind='note'` discussion row noting the stack delta.

**`tmb_planning-difficult` SKILL.md** — replace §1 probe paragraph:

Before:
> Probe the stack the project announces: read whichever of `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`, etc. exist. Run `git remote -v` once. The project tells you what it is.

After:
> Read the project stack via `project_metadata_get(agent='bro')`. If it returns null, the prescan didn't run — load `tmb_project-prescan` first.

Also gain a top-of-file Preconditions/Glossary block (founder feedback). Content listed in spec.

**`tmb_planning-simple` SKILL.md** — same one-line replacement at its probe paragraph.

### 5. Drift trigger semantics

`lazy-regen-check` already runs at the start of every code-touching ask. After this change, it adds:

```
result = project_metadata_detect(agent='bro')
if result.changed:
  discussion_append(
    agent='bro',
    issue_id=<current>,
    kind='note',
    body='Stack drift detected at <result.detected.detected_at>: <delta summary>'
  )
```

This gives bro visibility when the stack changes mid-session (e.g., user installs `uv` and re-runs).

### 6. Hookability

The script runs standalone. A hook can invoke it directly:

```bash
# example: a hypothetical SessionStart hook that warms the cache
bash "${CLAUDE_PLUGIN_ROOT}/skills/tmb_project-prescan/scripts/detect-stack.sh" \
  > "${TRAJECTORY_DB_DIR}/cache/last-stack-detect.json"
```

No MCP boundary needed for hooks; they get raw JSON.

## Test matrix

| Layer | Target | Coverage |
|---|---|---|
| Unit (shell) | `plugin/tests/unit/detect-stack.test.sh` | Empty repo (no files) → `languages=[]`. Python repo (`pyproject.toml`) → `languages` includes `python`. Polyglot repo → both languages. Detection-ladder fallback when `enry`/`tokei` absent. JSON validity. |
| Unit (TS) | `plugin/mcp/trajectory-server/src/test/project-metadata.test.ts` | Detect persists. Get reads. `changed` flag correct on second run. `requireRoles` rejects non-bro on detect. |
| L4 workflow-sim | `plugin/tests/workflow-sim/flow-XX-stack-detect.test.ts` | Prescan → detect → planning skill reads metadata, no probe in trajectory. |
| L1 lint | `skill-frontmatter` (existing) | New skill files have valid frontmatter. |
| L1 lint | `dist-fresh` (existing) | dist/ rebuild after source change. |

## Out of scope (v1)

- **Hard dep on enry/tokei**: hybrid only; the script works without them.
- **Linguist Ruby gem**: too heavy for v1.
- **Byte-count language %**: collected only if `enry`/`tokei` provides it; we don't compute it ourselves.
- **GitHub UI integration**: this is bro's metadata, not GH's.
- **New `project_metadata` table**: re-using `config` is sufficient for v1.
- **Cross-repo metadata (multi-root workspaces)**: single repo per detect call; multi-root is `#174` territory.

## Risks

1. `execFileSync` from Node — handler must time out (5s) and capture stderr. Failure modes: missing bash (rare on macOS/Linux), script error, JSON parse failure.
2. L5 flows that exercise `tmb_planning-*` may have fixtures that assert specific probe behavior. Spec verification step must run L4 to surface any regression.
3. The `_meta_` key prefix is convention only. If someone calls `config_set(key='_meta_xxx', value=...)` directly, it'll collide with our namespace. Mitigation: future hardening can add a `_meta_*` write block in `config_set`.

## Acceptance (Scope A)

- `bash plugin/skills/tmb_project-prescan/scripts/detect-stack.sh` emits valid JSON with all 8 fields on this repo.
- `project_metadata_detect(agent='bro')` returns `{detected, changed, previous_detected_at}` and persists.
- `project_metadata_get(agent='bro')` returns the detected object.
- `requireRoles` enforces detect=bro-only, get=bro/swe/pr-reviewer/consultant (per Scope B's role model).
- `tmb_project-prescan` Phase 3 calls detect.
- `tmb_planning-difficult` reads via get; gains Preconditions/Glossary block.
- `tmb_planning-simple` reads via get.

---

# Scope B — Consultant Role Doctrine Fix

## Problem

The wire-level role enum at `mcp/trajectory-server/src/middleware/agent-scope.ts` lists `architect` as a first-class role alongside `bro`, `swe`, `pr-reviewer`. But:

1. **The plugin ships only 3 first-class agents**: `bro` (the persona), `swe` (executor), `pr-reviewer` (push gate). All three are referenced by name in core workflows.
2. **`architect` is one of 4 shipped consultant templates** in `templates/agents/` (alongside `cto`, `ceo`, `pm`). Consultants are user-spawned, analysis-only, decide nothing — per `templates/agents/architect.md` line 18: "You decide nothing."
3. **User-created consultants** (e.g. `legal-reviewer`, `security-reviewer`) work via `tmb_agent-creator` and have no special name in the wire — they currently normalize to `'unknown'` and get rejected from even read-side calls.

Three bugs follow from this:

- The enum **bakes in `architect`** but excludes the other 3 shipped consultants (`cto`, `ceo`, `pm`). Either special-case all 4, or drop the special-casing entirely.
- Architect is granted **5 write tools** (`regen_state_set`, `architecture_regen`, `file_registry_upsert`, `file_registry_delete`, `issue_snapshot_md`) that it has no business calling — `file_registry_upsert` writes the file-summary cache that gates `task_update_status(closed)`, which is bro's commit gate, not a consultant's domain.
- User-created consultants get `'unknown'` and are wire-rejected from `discussion_append(kind='analysis')` even though that's literally how they're supposed to record findings.

## Decision

Introduce `'consultant'` as a wire-level role category. Identity (the agent's name — `architect`, `cto`, `legal-reviewer`) is preserved for audit/discussion attribution; role is collapsed to one of 5 categories: `bro | swe | pr-reviewer | consultant | unknown`.

```typescript
// mcp/trajectory-server/src/middleware/agent-scope.ts (after)
export type AgentRole = 'bro' | 'swe' | 'pr-reviewer' | 'consultant' | 'unknown';

const FIRST_CLASS_ROLES = new Set<AgentRole>(['bro', 'swe', 'pr-reviewer']);

export function normalizeAgent(name?: string): AgentRole {
  if (!name) return 'unknown';
  const lower = name.toLowerCase();
  if (FIRST_CLASS_ROLES.has(lower as AgentRole)) return lower as AgentRole;
  if (/^[a-z][a-z0-9_-]*$/.test(lower)) return 'consultant';
  return 'unknown';
}
```

`KNOWN_ROLES` is replaced by `FIRST_CLASS_ROLES` (the 3 plugin-shipped first-class agents). Any non-empty, well-formed name that isn't first-class is `'consultant'`. Truly malformed input is `'unknown'` and gets rejected.

## requireRoles updates per tool

| Tool | Before | After | Rationale |
|---|---|---|---|
| `discussion_append` | `['bro','architect','swe','pr-reviewer']` | `['bro','swe','pr-reviewer','consultant']` | Consultants record `kind='analysis'/'concern'`. |
| `regen_state_set` | `['architect','bro','pr-reviewer']` | `['bro','pr-reviewer']` | Bro orchestrates regen. Architecture-regen is invoked through bro, not by consultants directly. |
| `architecture_regen` | `['architect','bro','pr-reviewer']` | `['bro','pr-reviewer']` | Same. Auto-architecture writes are bro's via `tmb_refresh-architecture`. |
| `file_registry_upsert` | `['architect','bro']` | `['bro']` | File-summary cache is bro's commit gate. |
| `file_registry_delete` | `['architect','bro']` | `['bro']` | Same. |
| `issue_snapshot_md` | `['architect','pr-reviewer']` | `['bro','pr-reviewer']` | Bro and pr-reviewer generate reports; consultants don't. |
| `branch_report_md` | `['bro','architect','swe','pr-reviewer']` | `['bro','swe','pr-reviewer','consultant']` | Read-side. |
| `stats.ts ALLOWED_ROLES` | `['bro','architect','swe','pr-reviewer']` | `['bro','swe','pr-reviewer','consultant']` | Read-side. |
| `labels.ts ALLOWED_ROLES` | `['bro','architect','swe','pr-reviewer']` | `['bro','swe','pr-reviewer','consultant']` | Read-side. |

## Schema enum at `tools/index.ts:43`

The `agent` parameter currently uses `enum: ['bro', 'architect', 'swe', 'pr-reviewer']` which JSON-Schema-rejects any other name BEFORE the handler runs. Replace with a name pattern:

```typescript
agent: {
  type: 'string',
  pattern: '^[a-z][a-z0-9_-]*$',
  description: 'Calling agent identity. First-class roles: bro, swe, pr-reviewer. Any other valid name is treated as consultant.',
}
```

`requireRoles` (via `normalizeAgent`) handles the actual access decision.

## Test updates

5+ tests use `agent: 'architect'` in write paths. Categorize:

- **Tests asserting architect could write to file_registry**: flip to assert `forbidden`.
- **Tests asserting architect could discussion_append**: keep, but add a parallel test using `agent: 'cto'` or `agent: 'legal-reviewer'` to demonstrate consultant equivalence.
- **`agent-scope.test.ts`**: `normalizeAgent('architect')` now returns `'consultant'`, not `'architect'`. Update.
- **`config.test.ts:232`**: architect-as-write-target → expect `forbidden`.
- **`labels.test.ts:267`**: architect on read-side → keep, label it as a consultant test.

## Acceptance (Scope B)

- `normalizeAgent('architect')` returns `'consultant'`.
- `normalizeAgent('cto')` / `normalizeAgent('legal-reviewer')` returns `'consultant'`.
- `normalizeAgent('bro')` / `normalizeAgent('swe')` / `normalizeAgent('pr-reviewer')` returns the literal name.
- `normalizeAgent('!!!')` returns `'unknown'`.
- A test client calling `file_registry_upsert(agent='architect')` gets `{error: 'forbidden'}`. Same for the other 4 dropped tools.
- A test client calling `discussion_append(agent='cto', kind='analysis', ...)` succeeds.
- `tools/index.ts` no longer enumerates `architect` in `agent` JSON Schema.
- All existing tests pass after the flip; new tests cover consultant equivalence.

---

# Scope C — Skill Audit Tier 1

## C.1 — `tmb_mcp-error-handling` rewrite

Current state: the skill has a "## Tools bro must NEVER call" section listing tools that the wire **already rejects via `requireRoles`**. This is wire-enforced redundancy — the prose tells the model "don't call X" but the server returns `forbidden` regardless of what the prompt said. Per the project's `feedback_no_negative_prompt_rules.md` memory, this is fix-it-structurally-not-prose territory.

Replace the skill with a positive, halt-and-surface protocol. ~12 lines net deletion.

**Target**: `plugin/skills/tmb_mcp-error-handling/SKILL.md`. Final shape (target ~30 lines):

- Frontmatter unchanged.
- "## Purpose": one sentence.
- "## Protocol": halt → surface verbatim → ask Human OR retry with corrected call.
- "## Errors that mean 'doctrine is wrong'": kept (forbidden / validation / constraint), reframed positively.
- DROP "## Tools bro must NEVER call" entirely.
- DROP "## Never" section (3 bullets are already covered by the positive Protocol section).

## C.2 — Tighten 4 thin descriptions

Per Anthropic's skill-creator guidance ("descriptions should be a bit pushy; include what AND when") and the audit's §3 finding.

| Skill | Current description | Proposed (more trigger-rich) |
|---|---|---|
| `tmb_naming-conventions` | "File and identifier naming patterns." | "File and identifier naming patterns. Loaded whenever bro, swe, or pr-reviewer is about to name a file, branch, identifier, or commit; ensures consistent file paths, snake_case vs kebab-case, and reserved-name avoidance across the project." |
| `tmb_git-conventions` | "Commit message style, branching rules, push safety." | "Commit message style, branching rules, push safety. Loaded whenever an agent is about to commit, branch, push, or merge — covers conventional-commit emoji prefixes, feature-branch naming, force-push guardrails, and the no-direct-to-main rule." |
| `tmb_feedback-loop` | "3-question protocol for capturing bugs into review skills." | "3-question protocol for converting newly-observed bugs into durable review-skill checks. Loaded whenever pr-reviewer or bro encounters a bug class that should be added to a review checklist; prevents one-off fixes from becoming recurring blind spots." |
| `tmb_review-protocol` | "Review phases 1-7 for PR Reviewer. Progression from staged diff scan to full design compliance check." | "Review phases 1-7 for PR Reviewer at push gate. Loaded when pr-reviewer is about to score a task's commit against its spec; covers staged-diff scan, scope drift detection, success-criteria match, and design-compliance progression." |

## Acceptance (Scope C)

- `tmb_mcp-error-handling/SKILL.md` line count drops by ≥10. No "## Tools bro must NEVER call" or "## Never" sections remain.
- 4 thin descriptions are rewritten per the table above.
- L1 lints all PASS (especially `skill-frontmatter`, `no-negative-directives`).

---

# Combined acceptance (whole PR)

- All Scope A, B, C acceptance items pass.
- `bash plugin/tests/run-all.sh` (or equivalent) — L0 not local, L1–L4 all green.
- `tests/lint/dist-fresh.sh` PASS.
- `tests/lint/no-negative-directives.sh` shows ≤ 145 findings (was 153 before).
- New unit tests for detect-stack.sh + project-metadata handler.
- New tests for consultant role equivalence (cto, legal-reviewer).

# Risks (combined)

1. `execFileSync` from Node — handler must time out (5s) and capture stderr. Failure modes: missing bash, script error, JSON parse failure.
2. L5 flows that exercise `tmb_planning-*` may have fixtures asserting specific probe behavior. SWE must run L4 to surface regressions.
3. The `_meta_` key prefix is convention only; future hardening can add a `_meta_*` write block in `config_set`.
4. Scope B's pattern-validator (`'^[a-z][a-z0-9_-]*$'`) on the `agent` JSON Schema is more permissive than the prior enum. Any caller passing a malformed agent name now reaches `normalizeAgent` instead of being JSON-Schema-rejected. Acceptable: `requireRoles` rejects `'unknown'`, so the surface area for malformed-agent-name attacks is unchanged.
