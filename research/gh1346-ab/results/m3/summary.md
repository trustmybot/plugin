### M3 — code as the action language (22 lookup questions, agent opus effort medium; A = tool-per-step, B = code-as-action)

| Metric (all questions) | A mean ± sd | B mean ± sd | Δ B−A (95% CI) | Change | paired t p | Wilcoxon p |
|---|---|---|---|---|---|---|
| Input tokens (total) | 812,765 ± 1,566,895 | 98,947 ± 21,876 | -713,817 (-1,411,135 … -16,500) | -87.8% | 0.045 | 0.006 |
| Cache read tokens | 766,710 ± 1,482,283 | 92,082 ± 25,325 | -674,628 (-1,333,283 … -15,973) | -88.0% | 0.045 | 0.002 |
| Output tokens | 7,199 ± 10,784 | 389.6 ± 182.5 | -6,809 (-11,615 … -2,003) | -94.6% | 0.008 | 0.039 |
| Tool calls | 64.1 ± 93.4 | 1.2 ± 0.4 | -62.9 (-104.4 … -21.4) | -98.1% | 0.005 | 0.005 |
| Tool result chars | 70,646 ± 153,586 | 3,591 ± 8,768 | -67,055 (-135,946 … 1,837) | -94.9% | 0.056 | 0.005 |
| Wall time (s) | 67.2 ± 94.7 | 10.9 ± 3.5 | -56.2 (-98.5 … -13.9) | -83.7% | 0.012 | 0.046 |
| Cost (USD) | 0.666 ± 1.156 | 0.081 ± 0.097 | -0.585 (-1.111 … -0.059) | -87.8% | 0.031 | 0.036 |

| Scope | n | Median input tokens A / B | Input change (mean) | Wilcoxon p | Median tool calls A / B | Accuracy A | Accuracy B | McNemar p |
|---|---|---|---|---|---|---|---|---|
| all | 22 | 132,496 / 86,866 | -87.8% | 0.006 | 2 / 1 | 91% | 100% | 0.500 |
| single | 8 | 88,020 / 86,790 | 10.6% | 0.674 | 1 / 1 | 100% | 100% | 1.000 |
| cross | 9 | 973,770 / 86,758 | -95.3% | 0.008 | 197 / 1 | 78% | 100% | 0.500 |
| code | 5 | 131,834 / 131,305 | -1.8% | 0.893 | 2 / 2 | 100% | 100% | 1.000 |

| Question | Kind | Truth | A calls | A in | A ok | B calls | B in | B ok |
|---|---|---|---|---|---|---|---|---|
| task176-sha-status | single | `escalated,6c819e6e` | 1 | 87,781 | ✓ | 1 | 86,663 | ✓ |
| task31-fails-last | single | `5,pass` | 1 | 87,368 | ✓ | 1 | 86,865 | ✓ |
| issue53-task-counts | single | `9,2` | 1 | 88,598 | ✓ | 1 | 86,675 | ✓ |
| task182-swe-cache | single | `1601819` | 1 | 88,258 | ✓ | 1 | 86,714 | ✓ |
| issue55-bro-decisions | single | `25` | 1 | 87,672 | ✓ | 1 | 86,655 | ✓ |
| issue136-verif-pass | single | `4,fix/1834-wm-markup-banners` | 1 | 89,556 | ✓ | 1 | 86,867 | ✓ |
| issue187-gh | single | `1959,none` | 1 | 87,177 | ✓ | 2 | 130,413 | ✓ |
| task180-pass-run | single | `0,d3220f5d` | 1 | 93,141 | ✓ | 2 | 134,032 | ✓ |
| review-fail-3x | cross | `31:14,33:33,76:55,158:136` | 198 | 973,770 | ✓ | 1 | 86,905 | ✓ |
| open-issues-no-tasks | cross | `53` | 89 | 376,724 | ✗ 52 | 1 | 86,702 | ✓ |
| max-cache-task | cross | `76` | 199 | 2,539,833 | ✓ | 1 | 86,851 | ✓ |
| most-reviewed | cross | `31,33` | 197 | 4,021,693 | ✓ | 1 | 86,758 | ✓ |
| hook-denied-issue | cross | `124,145` | 180 | 1,092,059 | ✓ | 1 | 86,739 | ✓ |
| latest-fail | cross | `182,126` | 12 | 252,009 | ✓ | 1 | 87,040 | ✓ |
| high-prio-open | cross | `12` | 48 | 317,636 | ✓ | 1 | 88,017 | ✓ |
| failed-tasks | cross | `65,67,125,127,171,180` | 197 | 613,006 | ✓ | 1 | 86,694 | ✓ |
| swe-effort-medium | cross | `108` | 273 | 6,363,813 | ✗ 107 | 1 | 86,666 | ✓ |
| db-path-env | code | `mcp/trajectory-server/src/platform.ts,TR…` | 2 | 133,158 | ✓ | 2 | 132,215 | ✓ |
| write-path-guard | code | `mcp/trajectory-server/src/hooks/cmd-anal…` | 1 | 90,586 | ✓ | 1 | 99,910 | ✓ |
| worktree-b-hook | code | `scripts/hooks/no-worktree-branch-create.…` | 3 | 177,311 | ✓ | 2 | 131,305 | ✓ |
| require-roles | code | `mcp/trajectory-server/src/middleware/age…` | 2 | 87,839 | ✓ | 2 | 157,093 | ✓ |
| v51-migration | code | `mcp/trajectory-server/src/db.ts,1641` | 2 | 131,834 | ✓ | 1 | 89,060 | ✓ |

Mean input tokens/question: A 812,765 (sd 1,566,895), B 98,947 (sd 21,876).
