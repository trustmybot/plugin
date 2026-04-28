# ADR 0001: GitLab as primary git host

- **Status:** Accepted
- **Date:** 2026-04-28
- **Decider:** Zax Shen

## Context

The GitHub account `trustmybot` was suspended on 2026-04-27. Continuing to develop on GitHub was not viable. Linear (TRU-* prefix) was already in place as canonical product backlog; the git host needed a new home.

## Decision

Move primary git hosting to GitLab (`gitlab.com/trustmybot/plugin`). Keep GitHub remote configured as a backup mirror (`https://github.com/trustmybot/plugin.git`, currently 404 due to suspension).

Future state: when the GitHub account is restored, we may switch primary back to GitHub with GitLab as the mirror. The directional script `scripts/mirror-to-gitlab.sh` was previously deleted (reflects this state); a future `scripts/mirror-to-github.sh` may be added when needed.

## Consequences

### Positive
- Unblocked development immediately after GH suspension
- GitLab CI is available as a fallback if/when GH Actions become unavailable
- Distinct host means clearer separation between primary work and mirrors

### Negative
- Most contributors are more familiar with GitHub workflow; GitLab MR ergonomics differ slightly
- `gh` CLI is more polished than `glab`; some workflows need adjustment
- Marketplace install URL changed (downstream impact: future plugin installs use GitLab)

### Neutral
- Plugin marketplace `source` field changed from `github` to `url` (per Claude Code marketplace docs, both are first-class)
- GitHub mirror retained for eventual restoration

## References

- MCP issue #1 (GH → GitLab migration tracking)
- Memory `feedback_run_bro_from_workspace.md` (workspace structure)
- Memory `reference_linear_backlog.md` (Linear is canonical for backlog)
- CC plugin marketplace docs: https://code.claude.com/docs/en/plugin-marketplaces.md
