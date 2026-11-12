# Installing TMB

## Recommended scope: project or local

TMB keeps its state inside the project, so install it per project: **project** scope for a team install (`.claude/settings.json`), **local** scope for a personal one (`.claude/settings.local.json`, and for the dev and rc channels). User scope loads TMB's hooks into every project, and SessionStart recommends `--scope project` once per session.

`claude plugin install` defaults to user scope, so always pass `--scope`. From the project root, with `<s>` set to `project` or `local`:

```bash
claude plugin marketplace add trustmybot/marketplace --scope <s>
claude plugin install tmb@trustmybot --scope <s>
claude plugin update tmb@trustmybot --scope <s>
claude plugin marketplace update trustmybot   # no scope flag
```

Other channels: `trustmybot/marketplace-rc` with `tmb@trustmybot-rc`, or `trustmybot/marketplace-dev` with `tmb@trustmybot-dev`.

Any plugin change applies only after a full quit and relaunch of Claude Code. Installing at both scopes is safe; the project install wins. TMB needs Node.js 22+ on PATH, or SessionStart prints `TMB DEGRADED: missing node …`. What TMB writes, and where, is in [`../architecture/CONTAINMENT.md`](../architecture/CONTAINMENT.md).

## Where bro's persona comes from

Claude Code never loads a plugin's `CLAUDE.md`, so two hooks deliver bro's persona as session context: `session-start-persona` on startup, resume, `/clear` and compaction (after a compaction it adds bro's state from the DB), and `user-prompt-persona` on the first prompt of a session that started before the hooks loaded. Neither runs in the TMB source checkout, where Claude Code loads that `CLAUDE.md` itself. TMB never writes to `<project>/CLAUDE.md`; a `<!-- tmb:persona start … -->` block an older `/onboard` copied there can be deleted.

## Leftovers from older versions

Older `/onboard` runs wrote TMB gates into `~/.claude/settings.json`, where they fire in every project. [UPGRADE.md](./UPGRADE.md#upgrading-into-v110--remove-leftover-user-wide-hooks) covers removing them.

## Operating systems

| OS | Claude Code workflow | Bash sandbox | `/onboard` sandbox default |
|---|---|---|---|
| macOS | Supported | Supported; the recorded network probe ran here | **Yes (Recommended)**, unless a repo remote uses SSH |
| Linux | Supported (CI runs the suite on Linux) | Not yet validated on a Linux host; the network probe is macOS-only | **No**; answering Yes still writes the block |
| Windows | WSL 2 only, which is the Linux case; native Windows is untested | None on native Windows | As Linux |
