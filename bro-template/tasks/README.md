# bro/tasks/

Task XML files live here. Written by the Architect, executed by the SWE.

## Naming

`YYYYMMDD-HHMM_descriptive_name.xml` (timestamp + name)

Example: `20260421-1430_add_password_hashing.xml`

Get the timestamp with:

```bash
date +%Y%m%d-%H%M
```

## Format

See `.claude/skills/swe-spawn-workflow.md` for the full XML template.

## Lifecycle

```
open → in_progress → completed → closed
                  ↘ failed → (reopen as new task or abandon)
```

Only PR Reviewer can set `closed`. Only SWE can set `completed`.
