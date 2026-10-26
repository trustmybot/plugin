### M1/M2 — encoding and response shape (24 real tool outputs, 148 questions, reader opus effort low)

| Arm | Payload tokens, mean ± sd | Chars/token | Accuracy (all questions) | Unparsed |
|---|---|---|---|---|
| detailed-json | 9,879 ± 13,185 | 2.15 | 99.3% | 0 |
| detailed-toon | 8,696 ± 11,546 | 2.15 | 98.6% | 0 |
| concise-json | 2,999 ± 3,985 | 2.13 | 79.1% | 0 |
| concise-toon | 2,269 ± 2,797 | 2.06 | 79.7% | 0 |

| Token comparison | Δ mean (95% CI) | Change | paired t p | Wilcoxon p |
|---|---|---|---|---|
| detailed-toon vs detailed-json | -1,183 (-1,926 … -439.8) | -12.0% | 0.003 | <0.001 |
| concise-json vs detailed-json | -6,880 (-10,965 … -2,795) | -69.6% | 0.002 | <0.001 |
| concise-toon vs concise-json | -729.5 (-1,248 … -210.7) | -24.3% | 0.008 | <0.001 |
| concise-toon vs detailed-json | -7,610 (-12,158 … -3,061) | -77.0% | 0.002 | <0.001 |

| Accuracy comparison | Scope | n | Control | Treatment | Only control right | Only treatment right | McNemar p |
|---|---|---|---|---|---|---|---|
| detailed-toon vs detailed-json | all | 148 | 99.3% | 98.6% | 2 | 1 | 1.000 |
| concise-json vs detailed-json | concise-answerable | 118 | 99.2% | 99.2% | 1 | 1 | 1.000 |
| concise-toon vs concise-json | concise-answerable | 118 | 99.2% | 100.0% | 0 | 1 | 1.000 |
| concise-toon vs detailed-json | concise-answerable | 118 | 99.2% | 100.0% | 0 | 1 | 1.000 |

| Concise arm on detail-only questions | n | Abstained (NEEDS_DETAIL) | Correct anyway | Wrong (hallucinated) |
|---|---|---|---|---|
| concise-json | 30 | 30 | 0 | 0 |
| concise-toon | 30 | 30 | 0 | 0 |

| Tool | detailed-json | detailed-toon | concise-json | concise-toon |
|---|---|---|---|---|
| audit_list | 31,214 | 27,094 | 9,286 | 6,492 |
| discussion_list | 6,706 | 5,904 | 1,843 | 1,442 |
| validation_history | 4,385 | 3,704 | 264 | 212 |
| task_get | 2,462 | 2,459 | 172 | 166 |
| issue_list | 6,474 | 5,223 | 5,009 | 4,005 |
| world_model_get | 8,032 | 7,792 | 1,418 | 1,298 |

| Question kind | n | Concise-answerable | detailed-json | detailed-toon | concise-json | concise-toon |
|---|---|---|---|---|---|---|
| total | 20 | 20 | 100% | 100% | 100% | 100% |
| count | 20 | 13 | 100% | 100% | 65% | 65% |
| filter | 16 | 13 | 100% | 100% | 81% | 81% |
| lookup | 52 | 44 | 100% | 96% | 85% | 85% |
| extreme | 20 | 20 | 95% | 100% | 95% | 100% |
| text | 20 | 8 | 100% | 100% | 40% | 40% |
