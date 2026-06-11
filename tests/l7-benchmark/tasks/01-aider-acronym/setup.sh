#!/usr/bin/env bash
# Vendor the Acronym (Exercism / Aider) problem into the scratch project.
# Writes:
#   acronym.py             — empty stub with the function signature
#   tests/test_acronym.py  — 7-case pytest suite
#   pyproject.toml         — minimal project marker (lets ruff/pytest find roots)
#
# No internet required.
set -uo pipefail

PROJECT="${1:?project dir required}"
# shellcheck disable=SC2034
TASK_DIR="${2:-}"

mkdir -p "$PROJECT/tests"

cat > "$PROJECT/acronym.py" <<'PY'
def abbreviate(words: str) -> str:
    """Return the acronym formed by the first letter of each significant
    word in `words`, uppercased.

    Hyphens count as word separators; punctuation is stripped.
    """
    # TODO: implement.
    raise NotImplementedError
PY

cat > "$PROJECT/tests/test_acronym.py" <<'PY'
from acronym import abbreviate


def test_basic():
    assert abbreviate("Portable Network Graphics") == "PNG"


def test_lowercase_words():
    assert abbreviate("Ruby on Rails") == "ROR"


def test_camelcase():
    assert abbreviate("HyperText Markup Language") == "HTML"


def test_punctuation():
    assert abbreviate("first in, first out") == "FIFO"


def test_all_caps_word():
    assert abbreviate("GNU Image Manipulation Program") == "GIMP"


def test_hyphenated():
    assert abbreviate("Complementary metal-oxide semiconductor") == "CMOS"


def test_long():
    assert abbreviate(
        "Rolling On The Floor Laughing So Hard That My Dogs Came Over And Licked Me"
    ) == "ROTFLSHTMDCOALM"
PY

cat > "$PROJECT/pyproject.toml" <<'TOML'
[project]
name = "acronym-bench"
version = "0.1.0"
requires-python = ">=3.10"

# pytest needs the project root on sys.path so `from acronym import abbreviate`
# resolves. pythonpath = ["."] makes it import-friendly without conftest.py.
[tool.pytest.ini_options]
pythonpath = ["."]
testpaths = ["tests"]
TOML

(
  cd "$PROJECT" || exit 1
  git add acronym.py tests/test_acronym.py pyproject.toml
  git commit -qm "test: seed acronym exercise (Aider bench)"
) >/dev/null
