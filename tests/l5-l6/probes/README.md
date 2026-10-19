# tests/l5-l6/probes/

Live, rerunnable measurements of Claude Code behaviour that TMB's defaults depend on. A probe drives real `claude -p` sessions, so it costs tokens and needs network and auth; no gate runs it. Rerun it after a Claude Code upgrade and copy its table into the doc it backs.

| File | Measures | Backs |
|---|---|---|
| [`sandbox-network-probe.sh`](./sandbox-network-probe.sh) | Whether `gh api`, `git ls-remote`, `git push --dry-run`, `npm view` and `bun add` work under the Bash sandbox, with the filesystem-only block (A) and with TMB's `allowedDomains` allow-list added (B) | The `sandbox_enforcement` default (`SANDBOX_NETWORK_PROBE` in `mcp/trajectory-server/src/tools/onboard-sandbox.ts`) and the probe table in [`docs/architecture/CONTAINMENT.md`](../../../docs/architecture/CONTAINMENT.md) |

```bash
bash tests/l5-l6/probes/sandbox-network-probe.sh          # prints the table; exits 1 when B fails a command
bash tests/l5-l6/probes/sandbox-network-probe.sh --keep   # also keeps the temp projects and session transcripts
```

Each setup runs in a fresh `git init`'d temp project whose `origin` is `https://github.com/trustmybot/plugin.git`. The push is `--dry-run` and updates no ref. Sessions load only the project's local settings (`--setting-sources local`) and no MCP servers, so user hooks and plugins do not skew the result. Exit codes come from the session's Bash tool results; a call that set `dangerouslyDisableSandbox` counts as `unsandboxed`, not a pass. Auth is `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` from the environment, else the plugin checkout's `.env`.

When B passes every command, empty `SANDBOX_NETWORK_PROBE.failed` and fresh onboards default to **Yes (Recommended)** unless a remote is SSH.
