# Label Doctrine

**Source of truth for GitHub issue labels, Linear labels, AND the local DB `issue_labels` table** (when shipped — see #38). All three sides use the **same names**; no translation.

## Rule: keep labels self-explanatory

Labels are read by humans on every triage. The name should answer "what is this?" without consulting a glossary. We picked Linear-native flat style after the K8s `area/install` / `priority/critical-urgent` convention proved opaque (per #101).

If you need a new label and it's not below, ask in the PR. Adding a label is a doctrine change.

---

## Canonical list — 19 labels on GH, 14 on Linear (Linear has native priority field)

### Type / kind (4)

| Label | Means |
|---|---|
| **Bug** | Something is broken |
| **Feature** | New functionality |
| **Improvement** | Refactor, polish, quality work |
| **Docs** | Documentation-only changes |

Linear ships the first three by default; we add `Docs`.

### Surface / area (8)

| Label | Surface |
|---|---|
| **Install** | Marketplace install, cold-start path, channel isolation |
| **Workflow** | Bro / SWE / pr-reviewer doctrine + planning skills |
| **MCP** | Trajectory server (schema, tools, role enforcement) |
| **Hooks** | Hook scripts (git-guards, push-guard, require-task-spec) |
| **Roundtable** | Multi-agent roundtable feature |
| **Multi-platform** | Codex / Cursor / OpenCode / Gemini adapters |
| **Performance** | Latency / token cost |
| **Tests** | Test infrastructure (L0–L5) |

New area labels are added when a genuinely new surface emerges. Adding one is a doctrine change.

### Priority — GH labels OR Linear native field

| Label (GH) | Linear |
|---|---|
| **Priority: Urgent** | `priority: Urgent` (native field) |
| **Priority: High** | `priority: High` (native field) |
| **Priority: Medium** | `priority: Medium` (native field) |
| **Priority: Low** | `priority: Low` (native field) |

GH has no priority field, so we keep them as labels. Linear has a native priority field — no labels needed there.

### TMB-specific (3)

| Label | Means |
|---|---|
| **Doctrine** | Design rule / contract change (CLAUDE.md, planning skills, agent prompts) |
| **Discussion** | Open design question, no decided action yet |
| **token-burn** | Issue or PR that caused or risks abnormally high token spend |

Adding any other TMB-specific label requires an entry in this table with a "why" justification.

---

## Lifecycle / stale — no label

GH: use `gh issue list --state open --search 'updated:<2026-01-01'` (or similar) to surface stale items.

Linear: native auto-stale based on inactivity.

We dropped `lifecycle/stale` (#101) — labels for time-based state are double bookkeeping when both platforms have built-in inactivity detection.

---

## How agents use labels

When bro creates an issue:

1. Always run `gh label list --json name --jq '.[].name'` (or query the local DB once #38 lands) to see what labels exist in this repo.
2. Apply matching labels from the canonical list above. **Don't invent.**
3. If no existing label fits, surface that to the Human — the answer is "edit LABELS.md, add the label, then apply it" — never "make one up."

When pr-reviewer reviews a PR:

1. Check labels on the linked issue. `Priority: Urgent` issues get deeper review.
2. `Install` and `MCP` PRs trigger L0 install-smoke + L2 unit tests as a hard gate.

---

## Migration history

- **2026-04-25 (v0.4.1, PR #98)**: First migration — invented `area:install`, `p:high`, `stale`, etc. (8 invented labels) → adopted K8s convention (`area/install`, `priority/critical-urgent`).
- **2026-04-25 (v0.4.1, PR for #101)**: Second migration — K8s prefixes proved opaque; pivoted to Linear-native flat style. `area/install` → `Install`, `priority/high` → `Priority: High`. Dropped `lifecycle/stale` and 6 unused GH defaults. Added `Improvement` and `Docs`.

---

## Related

- [`ENUMS.md`](./ENUMS.md) — same governance rule applied to DB column ENUMs
- Issue #38 — `issue_labels` table proposal (uses these names verbatim)
- Issue #103 — Linear migration (mirrors these names into Linear's workspace)
- `tests/l1-lint/labels-stable.sh` — verifies GH label set matches this doc
