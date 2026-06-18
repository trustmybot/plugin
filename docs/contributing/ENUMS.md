# DB ENUM Doctrine

**Source of truth for every controlled vocabulary in the trajectory DB.** Same governance rule as [`LABELS.md`](./LABELS.md): adopt established conventions where they exist; invent only when no industry analog applies.

## Why this matters

Hooks branch on these values. Skills assert on them. Bro chooses paths based on them. A typo or a silent rename breaks downstream code without a compile error. A canonical doc + a lint guard catches drift before it ships.

---

## Canonical ENUM tables

### `issues.status` — issue lifecycle

| Value | Source | Meaning |
|---|---|---|
| `open` | GitHub | Newly created, not yet closed |
| `closed` | GitHub | Resolved (fixed, wontfix, duplicate, etc.) |

We deliberately match GH's two-state model. K8s pod phases (`Pending/Running/Succeeded/Failed/Unknown`) don't fit issues — issues are tasks, not processes.

### `tasks.status` — task lifecycle

| Value | Source | Meaning |
|---|---|---|
| `pending` | TMB | Task spec exists; SWE has not started |
| `running` | K8s pod phase | SWE is actively executing |
| `completed` | K8s pod phase | SWE returned with commit_sha; awaiting bro task-gate |
| `closed` | TMB | Bro task-gate verified, task is done |
| `failed` | K8s pod phase | SWE returned with error; awaiting bro decision |
| `escalated` | TMB | Bro escalated to Human after max retries |

Hybrid: K8s pod phases for the SWE-execution states (`running`/`completed`/`failed`), TMB-specific for the workflow gates (`pending`/`closed`/`escalated`).

### `validation_attempts.verdict` — pr-reviewer verdict at push gate

| Value | Source | Meaning |
|---|---|---|
| `pass` | TMB | Commits OK to push |
| `fail` | TMB | Issues found; SWE re-spawn or Human override needed |
| `escalate` | TMB | Outside pr-reviewer's authority; Human decides |

We considered aligning to GH PR review states (`approved`/`changes_requested`/`commented`/`dismissed`), but `pass`/`fail`/`escalate` reads cleaner for our 2-gate model. **TMB-specific by deliberate choice** — documented here, lint-guarded.

### `roundtables.state` — roundtable state machine

| Value | Source | Meaning |
|---|---|---|
| `collecting` | TMB | Votes being gathered from participants |
| `awaiting_human` | TMB | All expected votes received; pending Human ratification |
| `closed` | TMB | Human ratified; decisions finalized |
| `skipped` | TMB | Roundtable cancelled or consensus reached without full vote |

Server enforces valid transitions: `collecting → awaiting_human → closed | skipped`. Other transitions return `is_error: true`.

### `issues.remote_kind` — git remote host for issue sync

| Value | Source | Meaning |
|---|---|---|
| `github` | TMB | GitHub (github.com or GHE) |
| `gitlab` | TMB | GitLab (gitlab.com or self-hosted) |

Mirrors `plugin_config.remotes[].provider` (see [`plugin_config.remotes[].provider`](#plugin_configremotesprovider---git-host-provider-per-remote)). Only these two values are supported for issue sync. Schema enforces via `CHECK(remote_kind IN ('github','gitlab'))`.

### `discussions.kind` — narrative kind in issue discussions

| Value | Source | Meaning |
|---|---|---|
| `intent` | TMB | The Human's original ask, captured verbatim |
| `note` | TMB | Bro's running narrative (planning, triage, status) |
| `question` | TMB | Open question raised by an agent or the Human |
| `answer` | TMB | Resolution to a `question` |
| `analysis` | TMB | Consultant's structured analysis on a topic |
| `decision` | TMB | Bro's architectural decision record (narrative form) |

K8s Events have a `reason` field with a similar shape but different semantics. **TMB-specific** — these mirror our agent communication patterns.

### `audit.from_node` — which agent or persona logged the event

| Value | Source | Notes |
|---|---|---|
| `bro` | TMB persona | The single Human entry point |
| `swe` | TMB agent | Executor (one task per spawn) |
| `pr-reviewer` | TMB agent | Push-gate reviewer |
| `architect` | TMB consultant template | Project consultant |
| `cto` | TMB consultant template | Project consultant |
| `ceo` | TMB consultant template | Project consultant |
| `pm` | TMB consultant template | Project consultant |
| `<custom>` | per-project | User-created agents (e.g. `legal-reviewer`, `security-reviewer`) |

**TMB-specific** — these are TMB's role names. Custom agents added to a project become valid `from_node` values for that project's DB only.

### `audit.event_type` — workflow events

| Value | Trigger |
|---|---|
| `planning_complete` | Bro finishes planning, batched task_create + SWE spawn |
| `scope_gate_waived` | Bro waives the scope gate with explicit reason |
| `bro_verification_pass` | Bro task-gate V1/V2/V3 all passed |
| `bro_verification_fail` | Bro task-gate found a check that failed |
| `deep_scan_completed` | `scan_run` finished; `content_json` carries `source`, `structural_change`, `repos_seen`, `top_dirs` |
| `swe_retry_spawned` | Bro spawned a SWE retry after failure; captures retry rationale in `content_json` |
| `cheatcode_search` | `cheatcode_search` finished; `content_json` carries `query`, `kind`, `candidate_count`, and `top` ranked candidates |

**TMB-specific** — these are TMB workflow events. New event types require a row here. Bro should not invent ad-hoc event types.

### `cheatcodes.kind` — capability kind in the unified registry

| Value | Meaning |
|---|---|
| `skill` | A SKILL.md capability (builtin `tmb_*` or installed) |
| `mcp` | An MCP server toolkit |
| `plugin` | A full plugin |

Schema enforces via `CHECK(kind IN ('skill','mcp','plugin'))`. The `cheatcodes` table is the single typed registry for every capability the project knows about.

### `cheatcodes.origin` — provenance of the capability

| Value | Meaning |
|---|---|
| `builtin` | Plugin-shipped `tmb_*` capability; `source_url` is NULL |
| `installed` | Acquired via the discover → vet → install pipeline; `source_url` carries the candidate identity |

Schema enforces via `CHECK(origin IN ('builtin','installed'))`, plus paired `CHECK`s: `installed` rows require `source_url`, `builtin` rows forbid it.

### `cheatcodes.scope` — where the capability lives

| Value | Meaning |
|---|---|
| `global` | Plugin-shipped / user-wide |
| `template` | `templates/` copied per-project on demand |
| `project-local` | `<project>/.claude/` authored locally |

Schema enforces via `CHECK(scope IN ('global','template','project-local'))`. The `agents.scope` column uses the same three-value vocabulary.

### `cheatcodes.status` — install lifecycle

| Value | Meaning |
|---|---|
| `installed` | Recorded but not confirmed loaded (new installs land here) |
| `active` | Loaded / usable (builtin skills seed here) |
| `broken` | Recorded but failed (e.g. an uninstall whose teardown left the artifact on disk) |

No `CHECK` constraint — runtime reconciliation to `active`/`broken` is the health-check's job. `trust_tier` is free-form text carrying the vet classification for installed rows and the curation tier (`curated`) for builtin ones.

### `plugin_meta.schema_version` — DB schema version (integer)

Currently `22`. Bumped on any breaking schema change. **NOT free-form** — every increment requires a migration step in `db.ts:runMigrations`.

### `agent_runs.agent_type` (open enum)

Common values: `swe`, `pr-reviewer`, `architect`, `cto`, `pm`, `ceo`. Open enum — accept any string. Document the canonical values for query convenience.

### `plugin_config.remotes[].provider` — git host provider per remote

| Value | Meaning |
|---|---|
| `github` | github.com or GitHub Enterprise |
| `gitlab` | gitlab.com or self-hosted GitLab |
| `bitbucket` | Atlassian's git host (bitbucket.org) |
| `codeberg` | codeberg.org (Forgejo-based public forge) |
| `gitea` | Self-hosted Gitea instance |
| `forgejo` | Self-hosted Forgejo instance |
| `azuredev` | Azure DevOps (dev.azure.com) |
| `other` | Unrecognised or custom host |

URL-pattern auto-detection rules:

- `github.com` → `github`
- `gitlab.com` or `gitlab.<corp>.<tld>` → `gitlab`
- `bitbucket.org` → `bitbucket`
- `codeberg.org` → `codeberg`
- `dev.azure.com` → `azuredev`
- everything else → `other`

`remotes` is a `plugin_config` key whose value is a JSON array of `{ name, provider, url }` objects (e.g. `[{ "name": "origin", "provider": "gitlab", "url": "git@gitlab.com:org/repo.git" }]`). An empty array means no remote is configured.

---

## How to add a new ENUM value

1. Open a PR that adds the value to this doc AND to the schema/code that consumes it.
2. Add a test that covers the new value's path.
3. Update `tests/l1-lint/enums-stable.sh` if it has a hardcoded list.

---

## Lint guard

`tests/l1-lint/enums-stable.sh` checks that this doc and `mcp/trajectory-server/src/schema.sql` agree on the ENUM-bearing columns. Drift fails CI.

---

## Related

- [`LABELS.md`](./LABELS.md) — same governance rule for GH issue labels and `issue_labels` DB table (when shipped, see #38)
- `mcp/trajectory-server/src/schema.sql` — schema source of truth
- `mcp/trajectory-server/docs/CONFIG_KEYS.md` — `plugin_config` key registry (different doc because keys are looser than ENUMs)
