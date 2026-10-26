# Label Doctrine

**Source of truth for the issue labels on the trustmybot/plugin GitHub board.** The taxonomy governs TMB development only. It does not ship to TMB users: no shipped default, prompt, skill or tool description names these labels.

Every label lives in [`.github/labels.json`](../../.github/labels.json) as `{name, color, description, group}`. The tables below are generated from it.

## Rule: one type, one priority, one area

Every issue carries exactly **one type**, **one priority** and **one area**. Themes are optional. An issue that misses the rule gets `needs-triage` until it is fixed.

Names stay flat and self-explanatory; groups that need a prefix use the `Prefix: Value` form (`Priority: High`, `Area: Hooks`), per GH 101.

Adding, renaming or removing a label is a doctrine change: edit `labels.json` in a PR, regenerate this file, and let the sync workflow apply it.

---

## Canonical list

<!-- BEGIN GENERATED labels: scripts/maintenance/labels.mjs -->

### Type — exactly one

| Label | Means |
|---|---|
| **Bug** | Something isn't working |
| **Feature** | New feature or request |
| **Improvement** | Refactor / polish / quality work |
| **Docs** | Documentation-only changes |
| **Test** | Test-only changes |
| **Chore** | Tooling, deps, release mechanics |
| **Research** | Papers, experiments and open design questions |

### Priority — exactly one

| Label | Means |
|---|---|
| **Priority: Urgent** | Critical priority — broken-in-prod class |
| **Priority: High** | High priority — blocks meaningful workflows |
| **Priority: Medium** | Medium priority — quality / UX |
| **Priority: Low** | Low priority — polish / nice-to-have |

### Area — exactly one

| Label | Means |
|---|---|
| **Area: Hooks** | Hook entry points, containment-guard, cmd-analysis, intent hints, git and push guards |
| **Area: Trajectory Server** | MCP tools, schema, DB layer, task and issue flow, server-side gates |
| **Area: World Model** | Scan, code graph, concepts, world_model_* tools, embeddings |
| **Area: Dashboard** | dashboard/ server and UI |
| **Area: Install** | Deps installer, plugin payload, marketplace channels, OS compatibility |
| **Area: Agents** | agents/, skills/, commands/, CLAUDE.md and the bro/swe/code-reviewer workflow |
| **Area: Cheatcode** | Cheatcode search, vet, install and ranking |
| **Area: Adapters** | Codex, Cursor and Gemini adapters |
| **Area: Release** | CI workflows, dev-build, release-gate, integrate.sh, versioning |

### Theme — optional

| Label | Means |
|---|---|
| **token-burn** | Cost/perf cleanup to reduce LLM/API token consumption |

### Status — set by the triage workflow

| Label | Means |
|---|---|
| **needs-triage** | Missing exactly one type, one priority or one area |

<!-- END GENERATED labels -->

---

## Enforcement

| Piece | What it does |
|---|---|
| `scripts/maintenance/labels.mjs --sync` | Creates or updates GH labels to match `labels.json`. Extra labels on GH are printed, never deleted. |
| `scripts/maintenance/labels.mjs --doc` | Regenerates the canonical list above. `--check` fails when it is stale. |
| `scripts/maintenance/labels.mjs --check-live` | Diffs the GH labels against `labels.json`. Skips without `gh` or with `TMB_L1_OFFLINE=1`. |
| `.github/workflows/label-sync.yml` | Runs `--sync` on a push to `dev` that changes `labels.json`, and on demand. |
| `.github/ISSUE_TEMPLATE/` | Bug, Improvement, Feature and Research forms set the type and require an Area. Blank issues are disabled. |
| `.github/workflows/issue-triage.yml` | Runs `--triage` on every issue open, edit, label and unlabel. It turns the form's Area answer into its label when the issue has no area, then adds `needs-triage` unless the issue has exactly one type, one priority and one area, and removes it once it does. |
| `tests/l1-lint/labels.test.mjs` | Unit tests for the triage rule plus the doc-sync check. |

## How agents use labels

When bro files an issue, it applies one type, one priority and one area from the list above. **Don't invent labels.** If none fits, surface it to the Human: the answer is a `labels.json` change, never an ad-hoc label.

## Lifecycle / stale — no label

Use `gh issue list --state open --search 'updated:<2026-01-01'` (or similar) to surface stale items. We dropped `lifecycle/stale` (GH 101): a label for time-based state is double bookkeeping.

---

## Migration history

- **2026-04-25 (v0.4.1, PR GH 98)**: First migration — invented `area:install`, `p:high`, `stale`, etc. (8 invented labels) → adopted K8s convention (`area/install`, `priority/critical-urgent`).
- **2026-04-25 (v0.4.1, PR for GH 101)**: Second migration — K8s prefixes proved opaque; pivoted to a flat style. `area/install` → `Install`, `priority/high` → `Priority: High`. Dropped `lifecycle/stale` and 6 unused GH defaults. Added `Improvement` and `Docs`.
- **2026-10-25 (GH 1770)**: Third migration — one type, one priority and one area per issue, sourced from `labels.json`.
  - Renamed: Hooks → Area: Hooks, MCP → Area: Trajectory Server, Install → Area: Install, Multi-platform → Area: Adapters, Workflow → Area: Agents, Discussion → Research.
  - Merged, then deleted: Tests → Test, Performance → token-burn, enforcement → Area: Hooks, Doctrine → Area: Agents.
  - Deleted: design, architecture, campaign, Roundtable, javascript, dependencies.
  - Added: Area: World Model, Area: Dashboard, Area: Cheatcode, Area: Release, needs-triage.

---

## Related

- [`ENUMS.md`](./ENUMS.md) — same governance rule applied to DB column ENUMs
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md#filing-an-issue) — filing an issue
