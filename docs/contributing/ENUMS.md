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

### `discussions.kind` — narrative kind in issue discussions

| Value | Source | Meaning |
|---|---|---|
| `intent` | TMB | The Human's original ask, captured verbatim |
| `note` | TMB | Bro's running narrative (planning, triage, status) |
| `question` | TMB | Open question raised by an agent or the Human |
| `answer` | TMB | Resolution to a `question` |
| `concern` | TMB | An agent's surfaced concern about the plan |

K8s Events have a `reason` field with a similar shape but different semantics. **TMB-specific** — these mirror our agent communication patterns.

### `ledger.from_node` — which agent or persona logged the event

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

### `ledger.event_type` — workflow events

| Value | Trigger |
|---|---|
| `planning_complete` | Bro finishes planning, batched task_create + SWE spawn |
| `scope_gate_waived` | Bro waives the scope gate with explicit reason |
| `direct_mode_used` | Bro fixes ≤3 lines without SWE spawn |
| `bro_verification_pass` | Bro task-gate V1/V2/V3 all passed |
| `bro_verification_fail` | Bro task-gate found a check that failed |
| `architecture_regen_complete` | docs/trustmybot/architecture/auto/ refreshed |
| `swe_attempt_n_failed` | SWE returned with status=failed; counts toward retry cap |

**TMB-specific** — these are TMB workflow events. New event types require a row here. Bro should not invent ad-hoc event types.

### `skills.trust_tier` — skill provenance

| Value | Meaning |
|---|---|
| `curated` | Plugin-shipped or hand-reviewed |
| `agent` | Agent-created via `tmb_skill-creator` |

**TMB-specific** — these are TMB's skill governance tiers.

### `skills.status` — skill lifecycle

| Value | Source | Meaning |
|---|---|---|
| `draft` | TMB | Created but not yet validated |
| `pending_review` | TMB | Awaiting human review before activation |
| `active` | TMB | Discoverable + invocable |
| `deprecated` | TMB | Kept for back-compat; new code should not invoke |

Inspired by typical lifecycle states; not from a single named convention.

### `plugin_meta.schema_version` — DB schema version (integer)

Currently `1`. Bumped on any breaking schema change. **NOT free-form** — every increment requires a migration script.

---

## How to add a new ENUM value

1. Open a PR that adds the value to this doc AND to the schema/code that consumes it.
2. Add a test that covers the new value's path.
3. Update `tests/lint/enums-stable.sh` if it has a hardcoded list.

---

## Lint guard

`tests/lint/enums-stable.sh` checks that this doc and `mcp/trajectory-server/src/schema.sql` agree on the ENUM-bearing columns. Drift fails CI.

---

## Related

- [`LABELS.md`](./LABELS.md) — same governance rule for GH issue labels and `issue_labels` DB table (when shipped, see #38)
- `mcp/trajectory-server/src/schema.sql` — schema source of truth
- `mcp/trajectory-server/docs/CONFIG_KEYS.md` — `plugin_config` key registry (different doc because keys are looser than ENUMs)
