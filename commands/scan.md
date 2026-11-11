---
description: Populate the world model — walk the project root for git repos and write the project's directories, files and symbols to the world-model tables of the trajectory DB, with each directory's summary from its README.md or, without one, from its file names.
argument-hint: (none)
allowed-tools: mcp__plugin_tmb_trajectory-server__scan_run
---

# /scan

Use `/scan` for a manual refresh of the world model.

```
scan_run(agent='bro', source='user_manual')
```

When the result carries `verification_defaults_hint`, a listed repo has no `.config/tmb/verification-defaults.json` on its PR target while its env profile names lint, typecheck or test commands: show the repo and those commands, and offer `/onboard` to set them.
