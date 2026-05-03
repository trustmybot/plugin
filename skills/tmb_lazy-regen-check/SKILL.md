---
name: tmb_lazy-regen-check
description: Decide whether to run an incremental architecture regen at session start. First-ever session on a non-empty project → silent initial bootstrap; under 25 commits since last regen → silent incremental; over 25 → one-line nudge.
agent: bro
allowed-tools: Bash, mcp__plugin_tmb_trajectory-server__regen_state_get, mcp__plugin_tmb_trajectory-server__audit_log
---

# lazy-regen-check

## Purpose

Keep the architecture docs incrementally fresh without surprising the user with an expensive full-regen on every session. The 25-commit threshold separates cheap incremental regens (automated, silent) from potentially slow ones (user-opted-in).

## When invoked

Bro invokes this skill once per session — immediately before the pre-scan on the **first code-touching ask** of the session, and also when the Human issues an explicit `/tmb status` request. The skill does NOT run on read-only or conversational asks, and it does NOT run while Onboarding Mode is active.

## Procedure

1. Call `regen_state_get(target='file_registry')` and `regen_state_get(target='changelog')`.
2. If **both** return `null` (first-ever session — no regen has ever run): probe the project's source-file count and whether hand-curated arch docs already exist.
   ```bash
   # Count source files (excluding obvious non-source dirs)
   N=$(git ls-files | grep -vE '^(\.claude/|node_modules/|dist/|build/|\.git/|docs/)' | wc -l | tr -d ' ')
   # Detect hand-curated arch docs (any .md under docs/trustmybot/architecture at depth 1)
   HAS_HANDCURATED=$(find docs/trustmybot/architecture -maxdepth 1 -type f -name '*.md' 2>/dev/null | head -1)
   ```
   - If `N == 0` (empty repo) → do nothing, log skip to audit_log.
   - If `N <= 200` AND `HAS_HANDCURATED` is empty → invoke `tmb_refresh-architecture` with `scope:'full'` silently. The bootstrap is cheap on small projects and ensures `docs/trustmybot/architecture/auto/` exists for the first contributor / cold session. Tiny projects rarely cross the 25-commit threshold, so without this fallback they would never get docs.
   - If `N <= 200` AND `HAS_HANDCURATED` is non-empty → SKIP. The project maintains arch docs by hand; auto-regen is user opt-in only.
   - If `N > 200` AND `HAS_HANDCURATED` is empty → emit the one-line nudge: *"This project has N source files but no architecture docs yet. Run `/tmb refresh-architecture` to bootstrap them."* Don't auto-regen — full bootstrap on a 1000-file project can be slow.
   - If `N > 200` AND `HAS_HANDCURATED` is non-empty → SKIP. Hand-curated arch docs signal the project has chosen not to use auto-regen; emitting the nudge is a false positive. The user opts in via `/tmb refresh-architecture` if they want.

3. Otherwise (regen has run before), take the SHA from whichever `regen_state` row has the more recent `last_regen_at` timestamp and run:
   ```bash
   git log --oneline <last_seen_sha>..HEAD | wc -l
   ```
4. If the delta is **≤ 25 commits**, invoke the `tmb_refresh-architecture` skill with `scope:'incremental'` silently. Produce no user-facing output unless the tool errors. On error, write to audit_log and skip — do not surface the error to the user unless it persists across sessions.
5. If the delta is **> 25 commits**, emit exactly this one line (substituting the real number):

   > "Architecture docs are N commits behind. Run `/tmb refresh-architecture` when convenient."

   Do NOT auto-regen — an incremental regen over many commits can be slow; let the Human opt in.
6. If the commit count cannot be computed (git error, detached HEAD, etc.), skip silently and write the failure to audit_log. Do not surface the error to the user.

## Constraints

- **Onboarding in progress:** skip entirely — do not call `regen_state_get` until onboarding exits.
- **Read-only sessions:** if the entire session consists of read-only asks and no code-touching ask ever arrives, this check never runs.
- **Once per session:** after the check fires once (regardless of outcome), do not repeat it for the remainder of the session.
- **Silent on success:** a successful incremental regen produces no output. Only the nudge message (> 25 commits) or an error is ever user-visible.

## Session-start execution chain (first code-touching ask)

```
lazy-regen-check → project-prescan → inventory block → triage → branch-id-proposal → routing
```
