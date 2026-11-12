# Labels

The issue labels on the trustmybot/plugin GitHub board. The taxonomy governs TMB development only. It does not ship to TMB users: no shipped default, prompt, skill or tool description names these labels.

Every label lives in [`.github/labels.json`](../../.github/labels.json) as `{name, color, description, group}`. The tables below are generated from it.

## Rule: one type, one priority, one area

Every issue carries exactly **one type**, **one priority** and **one area**. Themes are optional. An issue that misses the rule gets `needs-triage` until it is fixed.

Names stay flat and self-explanatory; groups that need a prefix use the `Prefix: Value` form (`Priority: High`, `Area: Hooks`), per GH 101.

To add, rename or remove a label, edit `labels.json` in a PR, regenerate this file, and let the sync workflow apply it.


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
| **Area: Release** | CI workflows, dev-build, release-gate, cli.js integrate, versioning |

### Theme — optional

| Label | Means |
|---|---|
| **token-burn** | Cost/perf cleanup to reduce LLM/API token consumption |

### Status — set by the triage workflow

| Label | Means |
|---|---|
| **needs-triage** | Missing exactly one type, one priority or one area |

<!-- END GENERATED labels -->


## Checks

| Piece | What it does |
|---|---|
| `scripts/maintenance/labels.mjs --sync` | Creates or updates GH labels to match `labels.json`. Extra labels on GH are printed, never deleted. |
| `scripts/maintenance/labels.mjs --doc` | Regenerates the canonical list above. `--check` fails when it is stale. |
| `scripts/maintenance/labels.mjs --check-live` | Diffs the GH labels against `labels.json`. Skips without `gh` or with `TMB_L1_OFFLINE=1`. |
| `.github/workflows/label-sync.yml` | Runs `--sync` on a push to `dev` that changes `labels.json`, and on demand. |
| `.github/ISSUE_TEMPLATE/` | Bug, Improvement, Feature and Research forms set the type and require an Area. Blank issues are disabled. |
| `.github/workflows/issue-triage.yml` | Runs `--triage` on every issue open, edit, label and unlabel. It turns the form's Area answer into its label when the issue has no area. A report filed from the CLI carries a `<!-- tmb-report v1 sig=… -->` marker but no labels, so on a marked body it also adds `Bug` when the issue has no type, and the priority for the Impact answer when it has no priority (Blocks all TMB work → `Priority: High`, Blocks one task, has a workaround → `Priority: Medium`, Annoying or cosmetic → `Priority: Low`); an existing type or priority is never replaced. It then adds `needs-triage` unless the issue has exactly one type, one priority and one area, and removes it once it does. |
| `tests/l1-lint/labels.test.mjs` | Unit tests for the triage rule plus the doc-sync check. |
| `tests/l1-lint/bug-form.test.mjs` | Checks that `bug.yml` lists the same fields, labels, types and options as `FORM_FIELDS` in the bug-report module. |

## Filing with labels

Whoever files an issue, a contributor or an agent working on TMB, applies one type, one priority and one area from the list above. When none fits, the answer is a `labels.json` change, never an ad-hoc label.

No label tracks staleness: a label for time-based state duplicates the issue's update time, so search by it instead (`gh issue list --state open --search 'updated:<YYYY-MM-DD>'`).


## Related

- [`ENUMS.md`](./ENUMS.md) — same rule for the DB vocabularies: adopt an established convention, invent only where none applies
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md#filing-an-issue) — filing an issue
