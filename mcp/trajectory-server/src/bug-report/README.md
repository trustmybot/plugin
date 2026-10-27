# src/bug-report

The TMB bug-report form, its redaction, and its rendering. `../tools/bug-report.ts` (`bug_report_draft`) gathers the environment and the redaction context from the trajectory DB and the process, then calls these modules. They are pure: no DB, no filesystem, no network, no `child_process`. The same input always gives the same output, so `../test/bug-report.test.ts` checks them on fixtures alone.

| File | What it does |
|---|---|
| `form.ts` | The form as data: field ids, labels, types, dropdown options (`FREQUENCY_OPTIONS`, `AREA_OPTIONS`, `IMPACT_OPTIONS`), the checks, `IMPACT_PRIORITY`, and the `<!-- tmb-report v1 sig=… -->` marker pattern |
| `redact.ts` | `redact(text, ctx)` strips tokens and key blocks (PEM and PGP), emails, git remotes, the project root (`<project>`), the home directory (`~`), other absolute paths (`<path>/<basename>`), and the task branch, repo and issue/task title names in `ctx`. It runs until nothing changes, and it counts each rule |
| `render.ts` | `redactFields(input, env, ctx)` redacts every free-text field and environment line and sums the per-rule counts. `render()` builds the title, the body in the GitHub form's layout, the signature (a hash of tool, error class and the redacted error with digit runs and whitespace normalized), the marker, and the prefilled new-issue link. When the link is longer than 8000 chars, `render()` first drops `repro-script`, `doctor` and `workaround`. If it is still too long, it shortens the longest remaining values, each ending in `…`. Either step sets `prefill_truncated` |

Redaction is a denylist. It removes the patterns and names it knows about, and anything else passes through. A secret in a shape it does not know reaches the draft. The final check is the reporter reading the full draft before anything is filed, which is the form's second checkbox.
