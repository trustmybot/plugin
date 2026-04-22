# Hook diagnostic tools

Opt-in scripts for debugging plugin hooks. **Not wired by default.**

## `probe-bash.sh` — verify PreToolUse:Bash hook delivery

Used to investigate [issue #14](https://github.com/trustmybot/plugin/issues/14): whether subagent Bash calls trigger host-level PreToolUse hooks.

### Enable

Add to `hooks/hooks.json` as the FIRST Bash matcher entry so it fires before any gating hook:

```json
{
  "matcher": "Bash",
  "hooks": [
    { "type": "command", "command": "scripts/hooks/diagnostic/probe-bash.sh", "timeout": 5 },
    { "type": "command", "command": "scripts/hooks/git-guards.sh", "timeout": 10 }
  ]
}
```

Restart Claude Code (plugin hook config is loaded at startup, not hot-reloaded).

### Run the test

```bash
rm -f /tmp/tmb-hook-probe.log
# ... inside a fresh Claude Code session ...
# 1. Run a Bash tool call in your parent transcript (e.g., `pwd`)
# 2. Spawn any subagent that runs a Bash tool call
# 3. Check the log:
cat /tmp/tmb-hook-probe.log
```

### Interpret

Each line is `<epoch> PID=<shell_pid> CMD=<first 80 chars>`.

- **If BOTH parent and subagent Bash calls log**: PreToolUse hooks fire for subagents. No bypass. Close #14.
- **If ONLY parent calls log**: subagent Bash bypasses host hooks. Confirmed platform limitation; document in README and consider moving critical enforcement to `.git/hooks/pre-commit`.

### Disable

Remove the probe-bash.sh entry from `hooks/hooks.json` and restart Claude Code. Optionally `rm /tmp/tmb-hook-probe.log`.
