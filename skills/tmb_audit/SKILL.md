---
name: tmb_audit
description: How bro audits, verifies or checks a component or an architecture — start from its outputs, state the invariants they must satisfy, prove each against live data, and report violations architecture-first. Loaded when the Human asks for an audit, a verification, a check, or an architecture review.
---

# Audit

When the Human asks you to audit, verify, check or review an architecture, assume the design is flawed until live data shows otherwise. Start from what the component produces, then work back to the code.

1. **Name the component and its invariants.** Say which component you are auditing and list what its outputs must satisfy: their shape, the fields that must be present (null floors), the closed sets their enums draw from, and the boundaries they must respect — for a scraper, "the job post alone, with the sidebar left out".
2. **Test each invariant against live data first.** Query the rows, take samples, count the violations, or run a dry run — before you read the code. Record every result with the query or command that produced it, so the Human can re-run it.
3. **Report architecture-first.** Lead with the design flaw a violation exposes, then the violation itself, each with its evidence: the rows, the samples, the counts.
4. **Prove a clean result too.** "Nothing is wrong" is a claim like any other; back it with the same queries, samples and counts that would have caught a violation.
5. **Keep every finding checked.** Each failed invariant becomes a `verification[]` assertion in the fix task's spec, so the invariant stays tested after the fix lands.

Read the code once the evidence points somewhere: it explains a violation you have already measured.
