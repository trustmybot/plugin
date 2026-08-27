# Codex Scope 5 live checks

These checks exercise the real Codex host. They are intentionally outside
`tests/run-all.sh`: they require an authenticated local Codex profile, consume
model tokens, and may display Hook trust UI.

Run the CLI check from the candidate repository:

```bash
TMB_CODEX_LIVE=1 bash tests/live/codex-hooks/cli-smoke.sh
```

On macOS, also run the same matrix against the CLI bundled with the current
ChatGPT/Codex Desktop build:

```bash
TMB_CODEX_LIVE=1 \
CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex \
bash tests/live/codex-hooks/cli-smoke.sh
```

Record the Desktop app version and bundled CLI version with this result. A pass
here detects host-runtime drift, but it still does not prove the UI trust or
managed-only states.

Set `TMB_CODEX_REQUIRE_CLEAN=1` for release evidence. The script then refuses a
dirty candidate and records the exact local commit. It uses an isolated
`CODEX_HOME`, symlinks the current user's `auth.json` without copying its
contents, installs the local plugin through the normal Marketplace command,
creates disposable primary and linked worktrees, and moves the fixture to Trash
when done. It does not call GitHub or a forge CLI.

The CLI check proves:

- the installed-cache Hook is active under `--dangerously-bypass-hook-trust`;
- primary `apply_patch` and redirected shell writes deny before a side effect;
- primary interpreter, shell-wrapper, package-script, Git-write, and fake-forge
  probes deny without changing source, index, refs, or the local forge log;
- a branch-backed linked-worktree patch succeeds;
- parent, absolute, mixed-case protected, symlink, rename, and detached patch
  probes deny without writing outside the linked root;
- a bare shell never starts;
- `codex mcp list --json` sees the installed provider, and the observed TMB MCP
  call completes with `ok=true` only for the matching canonical project root;
- installed-cache digest drift denies;
- `permission_mode=bypassPermissions` does not weaken the policy.
- disabling Hooks and uninstalling the plugin remove Scope 5 enforcement, as
  disclosed; both checks run only in the disposable fixture and restore it.

The CLI runner does not replace interactive trust, managed-only, or Desktop UI
acceptance. Those checks still require the clean-candidate matrix below.

Desktop remains a separate gate. Use the same clean candidate commit and the
steps in
[`CODEX_PORT.md`](../../../docs/contributing/CODEX_PORT.md#scope-5-host-version-compatibility-gate).
Record the installed-cache path and bytes, trust state, primary and linked
sentinels, disabled-Hook behavior, uninstall or rollback result, and project
state after cleanup. Do not reuse CLI evidence as a Desktop pass.
