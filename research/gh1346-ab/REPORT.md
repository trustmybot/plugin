# GH 1346 token-reduction A/B results

Six methods, each against today's behaviour as the control, on real data: a read-only snapshot of the trajectory DB (2026-10-26) and bro transcripts. Every reader, rewriter and judge is `claude -p` on opus (effort low; M3's agents effort medium). Tests: paired t and Wilcoxon signed-rank for tokens, McNemar for paired correctness, Fisher exact for rates. Per-method tables are in `results/*/summary.md`.

Why this matters: per run, bro reads 54.7M cache tokens, swe 2.84M, code-reviewer 690K, and inter-agent messages are under 0.1% of that. So a method pays off only if it shrinks what sits in context for many turns: tool output first, subagent returns second.

## Verdicts

| Method | Sub-issue | Token effect | Correctness | Verdict |
|---|---|---|---|---|
| M3 code as the action language | GH 1960 | −95.3% input on cross-record questions (median 197 tool calls → 1); ±0 on single lookups and code questions | 100% vs 78% on cross-record (McNemar p = 0.5, n = 9) | **Adopt with changes**: read-only query for bro's cross-record questions only; MCP tools stay for single lookups |
| M2 concise `response_format` | GH 1958 | −69.6% payload (p < 0.001) | Same accuracy on answerable questions (99.2% both); abstains on 30/30 detail-only questions, 0 hallucinated | **Adopt with changes**: concise by default, `detailed` opt-in, totals and ids kept |
| M1 TOON encoding | GH 1957 | −12.0% detailed, −24.3% on top of concise (p < 0.001) | No change (98.6% vs 99.3%, McNemar p = 1.0) | **Adopt with changes**: only for uniform tabular arrays (list tools), after M2 |
| M4 condensed swe / code-reviewer returns | GH 1959 | −89.6% per return (1,234 → 128 tokens); only −0.20% of a bro session's cache read | 0 of 62 escalations dropped, 0 of 1 human decisions dropped; errors are over-flagging | **Adopt with changes, low priority**: build the head deterministically from the DB, not with an LLM |
| M5 Chain of Draft prose | GH 1959 | −5.1% (about 21 tokens per text; p < 0.001) | Retention 99.6% vs 99.8% (p = 0.32); 1 of 514 facts lost | **Drop**: GH 1744 already made these texts compact |
| M6 schema-checked completion report | GH 1961 | n/a | 0 of 55 review fails were catchable by a schema; GH 1744 already enforces SC coverage | **Drop**: fold into GH 1744; optionally require a non-empty `evidence_cmd` |

Suggested order: M3 (largest absolute saving: bro's cross-record questions cost 0.25M–6.4M input tokens each today), then M2 (+M1 on list tools), then M4 as a cheap mechanical change. M5 and M6 don't earn a change.

## M1 / M2 — encoding and response shape (GH 1957, GH 1958)

24 real outputs of six read tools (`audit_list`, `discussion_list`, `validation_history`, `task_get`, `issue_list`, `world_model_get`), four arms each, 148 fixed questions with ground truth computed from the DB. `concise` is the GH 1958 shape: ids plus one-line fields, long text cut to its first line (≤120 chars), bulky nested JSON reduced to ids and statuses.

| Arm | Payload tokens, mean ± sd | Accuracy (all questions) |
|---|---|---|
| detailed-json (control) | 9,879 ± 13,185 | 99.3% |
| detailed-toon | 8,696 ± 11,546 | 98.6% |
| concise-json | 2,999 ± 3,985 | 79.1% |
| concise-toon | 2,269 ± 2,797 | 79.7% |

| Token comparison | Change | paired t p | Wilcoxon p |
|---|---|---|---|
| detailed-toon vs detailed-json | −12.0% | 0.003 | <0.001 |
| concise-json vs detailed-json | −69.6% | 0.002 | <0.001 |
| concise-toon vs concise-json | −24.3% | 0.008 | <0.001 |
| concise-toon vs detailed-json | −77.0% | 0.002 | <0.001 |

| Accuracy comparison | Scope | n | Control | Treatment | McNemar p |
|---|---|---|---|---|---|
| detailed-toon vs detailed-json | all | 148 | 99.3% | 98.6% | 1.000 |
| concise-json vs detailed-json | concise-answerable | 118 | 99.2% | 99.2% | 1.000 |
| concise-toon vs detailed-json | concise-answerable | 118 | 99.2% | 100.0% | 1.000 |

The concise arms' lower all-question accuracy is the 30 questions that need full text (20% of the set). On every one the reader answered `NEEDS_DETAIL` rather than guess, so the cost of concise is an extra `detailed` call on those, not wrong answers.

| Tool | detailed-json | detailed-toon | concise-json | concise-toon |
|---|---|---|---|---|
| audit_list | 31,214 | 27,094 | 9,286 | 6,492 |
| discussion_list | 6,706 | 5,904 | 1,843 | 1,442 |
| validation_history | 4,385 | 3,704 | 264 | 212 |
| task_get | 2,462 | 2,459 | 172 | 166 |
| issue_list | 6,474 | 5,223 | 5,009 | 4,005 |
| world_model_get | 8,032 | 7,792 | 1,418 | 1,298 |

Changes for adoption:

- **M2.** Make concise the default with `response_format: "detailed"` as the opt-in. Keep every id and a row total in concise output: the count and filter questions concise could not answer (7 of 20, 3 of 16) count or filter on a field concise drops.
- **M1.** TOON gains nothing on single records or trees (`task_get` −0.1%, `world_model_get` −3%). It pays only on uniform row arrays (`issue_list` −19%, `audit_list` −13%, −30% once concise), so apply it there only, and keep JSON wherever a caller parses the output.

## M3 — code as the action language (GH 1960)

22 questions bro really asks, ground truth from SQL on the snapshot.

- **Arm A (control)**: an agent with today's read-only MCP tools, one call per step.
- **Arm B**: the same agent with only Bash, told to batch each question into one read-only script (`sqlite3 -readonly` on the same snapshot, grep for code), with the columns of 8 core tables in its prompt.

| Metric (all questions) | A mean | B mean | Change | paired t p | Wilcoxon p |
|---|---|---|---|---|---|
| Input tokens | 812,765 | 98,947 | −87.8% | 0.045 | 0.006 |
| Cache read tokens | 766,710 | 92,082 | −88.0% | 0.045 | 0.002 |
| Output tokens | 7,199 | 390 | −94.6% | 0.008 | 0.039 |
| Tool calls | 64.1 | 1.2 | −98.1% | 0.005 | 0.005 |
| Wall time (s) | 67.2 | 10.9 | −83.7% | 0.012 | 0.046 |
| Cost (USD) | 0.666 | 0.081 | −87.8% | 0.031 | 0.036 |

| Scope | n | Median input A / B | Input change | Wilcoxon p | Median calls A / B | Accuracy A / B |
|---|---|---|---|---|---|---|
| single record | 8 | 88,020 / 86,790 | +10.6% | 0.674 | 1 / 1 | 100% / 100% |
| cross-record | 9 | 973,770 / 86,758 | −95.3% | 0.008 | 197 / 1 | 78% / 100% |
| code location | 5 | 131,834 / 131,305 | −1.8% | 0.893 | 2 / 2 | 100% / 100% |

The whole effect is cross-record aggregation: "which tasks failed review 3+ times", "open issues with no tasks", "task with the highest swe cache read". With per-record tools, A pages through every record, up to 273 calls and 6.4M input tokens for one question, and still miscounted twice (52 vs 53, 107 vs 108). Single lookups and code questions show no difference.

Changes for adoption:

- Scope it to bro's cross-record questions.
- Use a read-only connection (`sqlite3 -readonly` or a `query` MCP tool that opens the DB with `readonly: true`) and keep the schema in the tool description.
- Keep the per-record MCP tools for single lookups.
- An alternative with a smaller surface is a handful of aggregate MCP tools (counts and group-bys over tasks, validation and agent_runs). It would cover the measured questions but not the long tail.

## M4 — condensed vs full subagent returns (GH 1959)

130 distinct real returns (79 swe, 51 code-reviewer), extracted from 12 bro sessions (both sync tool results and async hand-backs).

- **Condensed form**: an LLM rewrites each return into the GH 1959 contract: `status=… task=… sha=…` plus at most 4 lines of blockers and verbatim questions, with the full report left in the DB.
- **Scoring**: a reader extracts six decision facts from the full text (reference), from the full text again (noise floor) and from the condensed text.

| Agent | n | Full tokens mean (median) | Condensed mean (median) | Change | Wilcoxon p |
|---|---|---|---|---|---|
| all | 130 | 1,234 (1,207) | 128 (129) | −89.6% | <0.001 |
| swe | 79 | 1,318 (1,319) | 142 (151) | −89.3% | <0.001 |
| code-reviewer | 51 | 1,103 (1,114) | 107 (83) | −90.3% | <0.001 |

| Field | Full re-read agrees | Condensed agrees | McNemar p |
|---|---|---|---|
| task_id | 100.0% | 100.0% | 1.000 |
| outcome | 100.0% | 98.5% | 0.500 |
| commit_sha8 | 96.9% | 91.5% | 0.016 |
| blocking_count | 98.5% | 96.2% | 0.375 |
| needs_bro_action | 99.2% | 90.8% | 0.003 |
| needs_human_decision | 100.0% | 94.6% | 0.016 |
| all six | 94.6% | 74.6% | <0.001 |

What changed between full and condensed text:

- **Escalations.** The reference says bro must act on 62 returns. The condensed text dropped 0 of them; the full-text re-read dropped 1. The one human decision was also kept.
- **Over-flagging.** All 12 `needs_bro_action` and 7 `needs_human_decision` disagreements are false → true: the condensed text over-flags (for example, a `Decision needed:` line for a question bro can answer itself). That is safe, but it would cost bro a fetch of the full report.
- **Fail/blocked outcomes.** Of 50, one lost its failure label: a blocked swe return was condensed to `status=other`, though it still listed the open gaps and was still flagged for bro action.
- **Commit sha.** The 11 sha mismatches are reader misses on a 7-char sha the condensed line does carry, or a sha the full text gives only in prose.

Bro context simulation: each return stays in bro's context and is re-read on every later bro API call until the next compaction (median 14 re-reads). Condensing saves 14,733 cache-read tokens per return (median 10,399). Across the 12 sessions that is 1.92M of 1,085M bro cache-read tokens: **0.20% per session** (median 0.12%, max 0.61%).

Changes for adoption: the saving per return is real but small against bro's total, so this is a cheap-change-only item.

- Build the head line mechanically from the DB row (`tasks.status`, commit sha, `validation_attempts.verdict`, blocking-finding count), not with an LLM rewrite. That removes the sha and outcome slips.
- Keep the agent's own questions verbatim.
- Don't spend prompt complexity on it.

## M5 — Chain of Draft vs normal prose (GH 1959)

128 real texts: 65 typed completion reports and 63 spawn notes.

- **Rewrite**: an LLM rewrites each one in Chain-of-Draft style (minimum words per point, every identifier kept; JSON keeps its shape).
- **Scoring**: a quiz of 3–5 factual questions per text (514 in all) is answered from the normal and from the terse text, and a judge scores each answer against the reference.

| Kind | n | Normal tokens mean (median) | Terse mean (median) | Change | Wilcoxon p | Retention normal | Retention terse | Δ (95% CI) | Wilcoxon p |
|---|---|---|---|---|---|---|---|---|---|
| all | 128 | 415 (297) | 394 (279) | −5.1% | <0.001 | 99.8% | 99.6% | −0.3 pp (−0.8 … 0.3) | 0.317 |
| completion_report | 65 | 728 (622) | 693 (591) | −4.8% | <0.001 | 99.7% | 99.7% | 0.0 pp | 1.000 |
| spawn_note | 63 | 93 (93) | 86 (87) | −8.1% | <0.001 | 100.0% | 99.5% | −0.5 pp (−1.6 … 0.5) | 0.317 |

Retention holds: 1 of 514 questions was lost (a spawn note's "bug-fix lane" owner). But the saving is about 21 tokens per text, because GH 1744 already made both texts compact: typed JSON, and a spawn note capped near 290 chars. The Chain of Draft paper's large cuts are on reasoning traces, which these texts are not.

Verdict: drop. A terse-style instruction in the swe and bro prompts would cost prompt tokens on every run to save about 20 tokens per handoff.

## M6 — typed completion report vs free text (GH 1961)

A natural experiment. GH 1744 shipped the typed completion report (`criteria[]` with one entry per spec SC id, enforced by `task_update_status`) on 2026-10-25, so tasks split into a free-text era and a typed era. 244 review attempts on 175 tasks; an LLM classified all 55 fail feedbacks.

| Era | Tasks reviewed | First-pass pass | Rate | Fails |
|---|---|---|---|---|
| free text | 113 | 85 | 75.2% | 42 |
| typed report | 62 | 52 | 83.9% | 13 |

Fisher exact on first-pass pass rate: p = 0.25. The eras also differ in time and in other prompt changes, so this is observational, not causal.

| Fail reason | Free-text era | Typed era |
|---|---|---|
| report_gap (claim not backed, SC omitted, info withheld) | 0 | 0 |
| gate_failed | 5 | 0 |
| code_defect | 30 | 11 |
| spec_violation | 5 | 1 |
| other | 2 | 1 |
| **schema-catchable** | **0/42** | **0/13** |

Coverage of SC ids:

- **Typed era.** The stored typed reports (65 tasks, 300 criteria) have 0 missing SC ids. 2 criteria are not `met`, and 14 have an empty `evidence_cmd`. A stricter check would flag 8 reports, and none of those 8 later failed review for a reporting reason.
- **Free-text era.** Of 32 completion returns, only 2 were for specs with numbered SC ids, so coverage can't be measured there. Those 2 cite 8 of 10 ids.

Verdict: drop GH 1961 as a separate change. No review fail in either era was a reporting gap a schema could catch: fails are code defects and spec violations, which only review finds. GH 1744 already enforces the part that matters. The one cheap addition is rejecting an empty `evidence_cmd` on a `met` criterion.

## Limits

- **Reader and judge models.** Single model family (opus) as reader and judge. Concise / condensed effects on a weaker reader are untested.
- **Sample sizes.** M3 has 22 questions. Its correctness difference is not significant (p = 0.5); the token difference is (Wilcoxon p = 0.006, cross-record p = 0.008).
- **M4's simulation** counts re-reads of the return in bro's context. It ignores the extra fetches bro would make on over-flagged returns, which would shrink the 0.20% further.
- **M6** is observational: era, not assignment.
