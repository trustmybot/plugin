# 03-swebench-flask-4045

**Source:** SWE-bench Lite entry `pallets__flask-4045` ([commit](https://github.com/pallets/flask/commit/d8c37f43724cd9fb0cdda61c7ca6d92e8b1a3e98)). Real-world PR-based bug fix from Flask's history.

**Task class:** real-world bug fix — a maintainer-grade ticket from a major OSS project.

**Shape:** `setup.sh` clones Flask at the broken base commit + applies SWE-bench's test patch (the failing tests added in the fixing PR). The agent must edit `src/flask/blueprints.py` to make the new tests pass without breaking the existing suite.

**Internet required:** yes — `setup.sh` does a `git clone --depth=1 https://github.com/pallets/flask`. Run with network access; offline mode is out of scope for the MVP.

## The bug

Flask 1.x silently accepted blueprint names containing dots (`.`). Blueprint nesting introduced dotted names as a load-bearing convention (parent.child), so user-named blueprints with dots collided with the internal scheme — leading to confusing routing bugs. The fix: validate the name at `Blueprint.__init__` and raise `ValueError` if it contains a dot.

## Why this task

- **Real-world signal:** maintainer-grade ticket; SWE-bench Lite is the canonical agentic-SWE benchmark.
- **Bounded:** the diff is small (~5 lines in `blueprints.py`); the fix is conceptually simple but requires reading existing tests to understand the contract.
- **Test signal is clean:** SWE-bench provides `FAIL_TO_PASS` (the new tests added in the fix PR) and `PASS_TO_PASS` (regression check). Both lists are encoded in `verify.sh`.
- **Differentiates the arms:** raw Claude on this task will likely cold-read the whole Flask codebase to find the right file. TMB-on with file_registry summaries can short-circuit. **This is exactly where the token-saving axis should pay off.**

## What if internet isn't available?

`setup.sh` fails fast with a clear error. The harness records `problem_solving=0` for both arms and moves on. The Aider tasks (01, 02) run regardless.
