# 02-aider-word-count

**Source:** [exercism.io/tracks/python/exercises/word-count](https://exercism.io/tracks/python/exercises/word-count) (Aider's benchmark suite).

**Task class:** parsing — implement a function that tokenizes input + returns a frequency map.

**Shape:** Self-contained. setup.sh vendors the prompt + a pytest suite inline; no internet needed.

## Spec (paraphrased from Exercism)

Implement `count_words(sentence: str) -> dict[str, int]` in `word_count.py`. Tokenize the input, lowercase everything, count occurrences. Rules:

- Words are sequences of `[a-z0-9']`.
- Apostrophes are part of the word only when bracketed by letters (`it's`, not `'twas` → `twas`).
- Numbers count as words (`123` is a word).
- Other characters (punctuation, whitespace) are separators.
- Output: dict mapping each lowercased word to its count.

## Why this task

- Slightly harder than acronym — needs regex or careful tokenization. Tests edge cases (apostrophes, numbers, punctuation).
- Clear pass/fail: 12-case pytest suite.
- Sensitive to test-driven development discipline: the tests describe the contract exhaustively. An agent that reads the tests first should converge faster than one that guesses.
