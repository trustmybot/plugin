# 01-aider-acronym

**Source:** [exercism.io/tracks/python/exercises/acronym](https://exercism.io/tracks/python/exercises/acronym) (also included in Aider's benchmark suite).

**Task class:** small feature — implement a single function from spec.

**Shape:** Self-contained. setup.sh vendors the prompt + a pytest test file inline; no internet needed. verify.sh runs `python -m pytest`.

## Spec (paraphrased from Exercism)

Implement `abbreviate(words: str) -> str` in `acronym.py`. Given a phrase, return the acronym formed by the first letter of each significant word, uppercased. Hyphens count as word separators; underscores do not. Punctuation is stripped.

Examples:

| Input | Expected |
|---|---|
| `"Portable Network Graphics"` | `"PNG"` |
| `"Ruby on Rails"` | `"ROR"` |
| `"HyperText Markup Language"` | `"HTML"` |
| `"first in, first out"` | `"FIFO"` |
| `"GNU Image Manipulation Program"` | `"GIMP"` |
| `"Complementary metal-oxide semiconductor"` | `"CMOS"` |
| `"Rolling On The Floor Laughing So Hard That My Dogs Came Over And Licked Me"` | `"ROTFLSHTMDCOALM"` |

## Why this task

- Small enough that solution + test fit in this repo without cloning anything.
- Clear pass/fail: 7-case pytest suite.
- Tests basic problem-solving + tooling discipline (lint? commit msg?), not architecture.
- Comparable across tmb-on and raw arms — neither benefits from TMB-specific affordances on a task this small, which is the **null hypothesis**: if tmb-on wastes tokens here, that's a real cost; if it doesn't, raw shouldn't either.
