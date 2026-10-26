### M4 — condensed vs full subagent returns (130 real swe / code-reviewer returns from bro transcripts; condenser and reader opus effort low)

| Agent | n | Full tokens mean ± sd (median) | Condensed tokens mean ± sd (median) | Change | paired t p | Wilcoxon p | Condensed ≤150 tok |
|---|---|---|---|---|---|---|---|
| all | 130 | 1,234 ± 533 (1,207) | 128 ± 66 (129) | -89.6% | <0.001 | <0.001 | 76/130 |
| swe | 79 | 1,318 ± 626 (1,319) | 142 ± 65 (151) | -89.3% | <0.001 | <0.001 | 39/79 |
| code-reviewer | 51 | 1,103 ± 305 (1,114) | 107 ± 65 (83) | -90.3% | <0.001 | <0.001 | 37/51 |

Decision-fact agreement with a reader on the full text (reference). The noise floor is a second independent read of the full text; McNemar compares condensed against that floor on the same items.

| Field | Full re-read agrees | Condensed agrees | McNemar p |
|---|---|---|---|
| task_id | 100.0% | 100.0% | 1.000 |
| outcome | 100.0% | 98.5% | 0.500 |
| commit_sha8 | 96.9% | 91.5% | 0.016 |
| blocking_count | 98.5% | 96.2% | 0.375 |
| needs_bro_action | 99.2% | 90.8% | 0.003 |
| needs_human_decision | 100.0% | 94.6% | 0.016 |
| all six | 94.6% | 74.6% | <0.001 |

Missed escalations: reference says bro must act on 62; condensed drops 0 (full re-read drops 1). Human decisions: 1, condensed drops 0. Fail/blocked outcomes: 50, condensed turns 1 into a non-failure.

Bro context simulation: each return is re-read on every later bro API call until the next compaction (mean 14.2, median 14 re-reads). Cache-read tokens saved per return: mean 14,733 (sd 13,231, median 10,399). Across 12 sessions that is 1.92M of 1,085M bro cache-read tokens: 0.20% per session on average (median 0.12%, max 0.61%).
