# Label Doctrine

**Source of truth for both GitHub issue labels AND the local DB `issue_labels` table** (when shipped — see #38). Both sides use the **same names**; no translation table.

## Rule: don't invent

Labels are a controlled vocabulary that downstream code, hooks, and humans branch on. Inventing project-specific labels creates a translation problem the moment another tool needs to read them. We adopt established conventions instead:

| Source | What we adopt |
|---|---|
| **GitHub default labels** | The 9 labels every new GH repo ships with |
| **Kubernetes label convention** | `area/<name>`, `priority/<level>`, `lifecycle/<state>` namespaces |
| **TMB-specific (documented exceptions)** | Two labels we genuinely need that have no industry analog |

If you need a new label and it's not below, ask in the PR. Adding a label is a doctrine change.

---

## Canonical list

### GitHub defaults (9) — adopt as-is

| Label | Description |
|---|---|
| `bug` | Something isn't working |
| `enhancement` | New feature or request |
| `documentation` | Improvements or additions to documentation |
| `duplicate` | This issue or pull request already exists |
| `good first issue` | Good for newcomers |
| `help wanted` | Extra attention is needed |
| `invalid` | This doesn't seem right |
| `question` | Further information is requested |
| `wontfix` | This will not be worked on |

### Area (K8s convention) — `area/<surface>` (9)

| Label | Surface |
|---|---|
| `area/install` | Install / marketplace / cold-start path |
| `area/workflow` | Bro / SWE / pr-reviewer doctrine + planning skills |
| `area/mcp` | MCP trajectory server (schema, tools, role enforcement) |
| `area/hooks` | Hook scripts (git-guards, push-guard, require-task-spec) |
| `area/roundtable` | Multi-agent roundtable feature |
| `area/multi-platform` | Codex / Cursor / OpenCode / Gemini adapters |
| `area/perf` | Latency / token cost |
| `area/docs` | Documentation (overlap with GH `documentation` is OK) |
| `area/tests` | Test infrastructure (L0–L6) |

New `area/*` labels are added when a genuinely new surface emerges. Adding one is a doctrine change.

### Priority (K8s, short levels) — `priority/<level>` (4)

| Label | Meaning |
|---|---|
| `priority/critical` | Broken-in-prod class — drop everything |
| `priority/high` | Blocks meaningful workflows |
| `priority/medium` | Quality / UX |
| `priority/low` | Polish / nice-to-have |

K8s's official priority labels are verbose (`priority/critical-urgent`, `priority/important-soon`). We use shorter levels per project doctrine: optimize for human readability since these are read by both humans and bro on every triage.

### Lifecycle (K8s convention) — `lifecycle/<state>` (1)

| Label | Meaning |
|---|---|
| `lifecycle/stale` | Possibly outdated; needs reassessment |

K8s also defines `lifecycle/rotten`, `lifecycle/frozen`, `lifecycle/active`. Add only when a real workflow needs them.

### TMB-specific (2 — documented exceptions)

These have no clean industry analog. Each is justified.

| Label | Meaning | Why invented |
|---|---|---|
| `doctrine` | Doctrine clarification or contract change | TMB has multiple doctrine documents (CLAUDE.md, planning skills, agent prompts). When an issue updates one, this label flags it for the matching review depth. K8s has nothing analogous for "design rule change." |
| `discussion` | Open design question, no decided action yet | More specific than GH `question` (which is "I need info"). `discussion` means "we need to converge before action." |

Adding any other TMB-specific label requires an entry in this table with a "why" justification.

---

## How agents use labels

When bro creates an issue:

1. Always run `gh label list --json name --jq '.[].name'` (or query the local DB once #38 lands) to see what labels exist in this repo.
2. Apply matching labels from the canonical list above. **Don't invent.**
3. If no existing label fits, surface that to the Human — the answer is "edit LABELS.md, add the label, then apply it" — never "make one up."

When pr-reviewer reviews a PR:

1. Check labels on the linked issue. `priority/critical` issues get deeper review.
2. `area/install` and `area/mcp` PRs trigger L0 install-smoke + L2 unit tests as a hard gate.

---

## Migration history

- **2026-04-25 (v0.4.1)**: Migrated 8 invented labels to K8s convention (`area:install` → `area/install`, `p:critical` → `priority/critical`, `stale` → `lifecycle/stale`). Dropped `superseded` (close issues instead).

---

## Related

- [`ENUMS.md`](./ENUMS.md) — same governance rule applied to DB column ENUMs
- Issue #38 — `issue_labels` table proposal (mirrors GH labels into local DB)
- `tests/lint/labels-stable.sh` — verifies GH label set matches this doc
