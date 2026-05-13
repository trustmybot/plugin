#!/usr/bin/env bash
# Multi-task chained bench (#6 follow-up) — STUB / DESIGN DOC.
#
# Today's bench (run-bench.sh) resets the scratch project between tasks:
# fresh clone, fresh .claude/tmb/, fresh git. That measures single-shot
# completion but invisibility-erases TMB's actual value prop — cumulative
# state across tasks (file_registry warming, atomic-close history, decision
# audit). Tier 2 confirmed: on small single-shot tasks, the TMB doctrine
# ceremony doesn't even engage because bro correctly judges the task isn't
# big enough.
#
# This script preserves state across a sequence of tasks on the same repo.
# Measures whether TMB's per-task token / duration / hallucination metrics
# improve as the chain progresses (vs the cold-start baseline).
#
# Status: NOT IMPLEMENTED YET. See docs/BENCHMARK.md → "Multi-task chained
# bench" for the design. This file is the agreed entry point.
#
# Intended usage (when implemented):
#
#   bash tests/dogfood/bench/run-chained-bench.sh \
#     django__django-11019 django__django-11283 django__django-11564 \
#     django__django-11630 django__django-11742
#
#   N=3 bash tests/dogfood/bench/run-chained-bench.sh ...  # 3 arms: tmb-chained, tmb-cold, raw-opus-4

set -uo pipefail

cat >&2 <<'EOF'
================================================================
  run-chained-bench.sh is a STUB. Not implemented yet.
================================================================

Design captured in docs/BENCHMARK.md → "Multi-task chained bench
— the real product measurement".

To implement, the harness needs:

1. Multi-task project setup:
   - Clone the target repo ONCE into a scratch project
   - Initialize .claude/tmb/trajectory.db
   - Track which test_patches have been applied

2. Per-task application:
   - Apply task N's test_patch (without resetting state from task N-1)
   - Run bro
   - Score (resolved, tokens, hallucinated, duration)
   - Append the chain-position index to the result record

3. Cross-task analysis:
   - Per-task metrics over chain position
   - Hypothesis: tokens DROP as chain progresses (registry warms)
   - Hypothesis: hallucination rate stays 0 (atomic-close seeded)

4. Three arms for fair comparison:
   - tmb-chained: same project, accumulating state
   - tmb-cold: fresh project per task (today's single-shot pattern)
   - raw-opus-4: no plugin, cold each task

5. Conflict handling:
   - Test patches from different tasks may overlap on the same files
   - Need a strategy: either pick non-conflicting tasks, or document
     the conflict resolution (revert? merge? skip?)

Approximate cost: $15-30 for 5 tasks × 3 arms × N=1.

To kick off implementation: see issue #6 (the parent ticket) or follow
the run-bench.sh pattern with the modifications above.
EOF

exit 2
