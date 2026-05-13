#!/usr/bin/env bash
# Vendor the Word-Count (Exercism / Aider) problem into the scratch project.
set -uo pipefail

PROJECT="${1:?project dir required}"
# shellcheck disable=SC2034
TASK_DIR="${2:-}"

mkdir -p "$PROJECT/tests"

cat > "$PROJECT/word_count.py" <<'PY'
def count_words(sentence: str) -> dict:
    """Return a dict mapping each lowercased word in `sentence` to its
    occurrence count.

    Tokenization rules:
      - Words are sequences of [a-z0-9'] after lowercasing.
      - Apostrophes count only when bracketed by letters (e.g. it's).
      - Numbers count as words.
      - Other characters (whitespace, punctuation) separate words.
    """
    # TODO: implement.
    raise NotImplementedError
PY

cat > "$PROJECT/tests/test_word_count.py" <<'PY'
from word_count import count_words


def test_one_word():
    assert count_words("word") == {"word": 1}


def test_multiple_words():
    assert count_words("one of each") == {"one": 1, "of": 1, "each": 1}


def test_count_repeats():
    assert count_words("one fish two fish red fish blue fish") == {
        "one": 1, "fish": 4, "two": 1, "red": 1, "blue": 1,
    }


def test_ignore_punctuation():
    assert count_words("car: carpet as java: javascript!!&@$%^&") == {
        "car": 1, "carpet": 1, "as": 1, "java": 1, "javascript": 1,
    }


def test_normalize_case():
    assert count_words("go Go GO Stop stop") == {"go": 3, "stop": 2}


def test_with_apostrophe():
    assert count_words("First: don't laugh. Then: don't cry.") == {
        "first": 1, "don't": 2, "laugh": 1, "then": 1, "cry": 1,
    }


def test_with_numbers():
    assert count_words("Testing, 1, 2 testing") == {
        "testing": 2, "1": 1, "2": 1,
    }


def test_multiple_spaces():
    assert count_words("multiple   whitespaces") == {
        "multiple": 1, "whitespaces": 1,
    }


def test_newlines_and_tabs():
    assert count_words("hello\tworld\nthe sun shines") == {
        "hello": 1, "world": 1, "the": 1, "sun": 1, "shines": 1,
    }


def test_quotation_not_part_of_word():
    # 'twas should become twas; quotation marks don't extend the word.
    assert count_words("Joe can't tell between 'large' and large.") == {
        "joe": 1, "can't": 1, "tell": 1, "between": 1, "large": 2, "and": 1,
    }


def test_unicode_letters_basic_ascii_only():
    # The contract is ascii letters/digits — non-ascii letters are separators.
    assert count_words("hello,world,foo") == {
        "hello": 1, "world": 1, "foo": 1,
    }


def test_empty_string():
    assert count_words("") == {}
PY

cat > "$PROJECT/pyproject.toml" <<'TOML'
[project]
name = "word-count-bench"
version = "0.1.0"
requires-python = ">=3.10"
TOML

(
  cd "$PROJECT" || exit 1
  git add word_count.py tests/test_word_count.py pyproject.toml
  git commit -qm "test: seed word-count exercise (Aider bench)"
) >/dev/null
