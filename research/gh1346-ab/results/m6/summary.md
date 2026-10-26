### M6 — typed completion report vs free text (natural experiment: the typed report shipped in GH 1744 on 2026-10-25; 244 review attempts on 175 tasks)

| Era | Tasks reviewed | First-pass pass | Rate | Review attempts | Fails |
|---|---|---|---|---|---|
| free text | 113 | 85 | 75.2% | 165 | 42 |
| typed report | 62 | 52 | 83.9% | 79 | 13 |

Fisher exact on first-pass pass rate: p = 0.250. The eras differ in time and in other prompt changes, so this is observational, not causal.

| Fail reason | Free-text era | Typed era |
|---|---|---|
| report_gap | 0 | 0 |
| gate_failed | 5 | 0 |
| code_defect | 30 | 11 |
| spec_violation | 5 | 1 |
| other | 2 | 1 |
| **schema-catchable** | 0/42 | 0/13 |

Fisher exact on the schema-catchable share of fails: p = 1.000.

Stored typed reports (65 tasks, 300 criteria): 0 spec SC ids missing, 2 criteria not "met", 14 without an evidence command; 8 reports would fail a stricter GH 1961 check.

Free-text era swe returns that report completion: 32, of which 2 are for specs with numbered SC ids (older specs list criteria as unnumbered bullets, so coverage cannot be checked mechanically). Those cite 8 of 10 SC ids by name, and 0 cover every SC id. The typed report enforces 100% coverage at close.
