---
name: refresh-architecture
description: Wraps the architecture_regen MCP tool to regenerate auto/ architecture docs. Invoked by architect after difficult-path structural changes, by gatekeeper at session start for incremental refresh, and by the Human via phrase trigger for a full regen.
when-to-use: When architecture auto/ docs need regenerating — either because a structural change was just committed (full regen) or at session start to lazily sync any accumulated drift (incremental).
when-not-to-use: When you only need to read architecture docs. Do not invoke this as a substitute for reading manual/ files or for editing auto/ files by hand.
---

# refresh-architecture

## Purpose

Triggers regeneration of the `docs/trustmybot/architecture/auto/` directory
by calling the `architecture_regen` MCP tool. It does not touch
`docs/trustmybot/architecture/manual/` under any circumstances.

## Invocation

Three callers, two scopes:

- **Architect** calls `scope:'full'` after any difficult-path task that
  completes a structural change (new module boundary, schema change, new
  dependency, public API surface change).
- **Gatekeeper** calls `scope:'incremental'` lazily at session start, before
  routing the first code-touching ask, to sync any drift from commits made
  outside a full regen cycle.
- **Human** triggers a full regen by asking gatekeeper one of these phrases:
  "refresh architecture docs", "refresh architecture", "regenerate
  architecture", or "regen architecture". Gatekeeper recognises any of these
  phrases and invokes this skill with `scope:'full'` directly (no architect
  spawn, no triage — this is a direct op, not a code change).

No slash-command directory (`plugin/commands/`) is present in this plugin.
Until such a mechanism exists, the phrase-routing described above is the
Human-facing invocation path.

## Protocol

### Full regen (manual refresh or post-difficult-task)

```
architecture_regen(scope: 'full')
```

Call this after committing a structural change. The MCP tool regenerates all
files in `docs/trustmybot/architecture/auto/` from the current git state.

### Incremental regen (lazy session-start)

```
architecture_regen(scope: 'incremental')
```

Call this at session start before the first code-touching route. The MCP tool
computes a git-log diff since the last regen and only rewrites stale files.

## Post-regen

After the MCP call returns, compare the reported changed files against the
previous content. If any file changed, emit exactly one line to the Human (or
the calling agent's output):

> "Regenerated N files: file-a.md, file-b.md, file-c.md."

If no files changed, emit nothing — silence is the correct output for a no-op
incremental sync.

## Failure modes

If `architecture_regen` returns an error:

1. Surface the MCP error message verbatim to the Human (or to architect, if
   this was called from architect context).
2. State: "Architecture auto/ docs were not updated. Manual review may be
   needed."
3. Do NOT retry automatically. The Human or architect decides next steps.

Common causes: the MCP server is not running, the SQLite `file_registry` table
is missing, or the git working tree is dirty with uncommitted files that the
tool cannot parse. Resolve the underlying condition, then re-invoke.

## Out of scope

- Reading `docs/trustmybot/architecture/manual/` — agents read that directly.
- Editing any file in `docs/trustmybot/architecture/auto/` by hand — the MCP
  tool owns those files exclusively.
- Deciding whether a change is structural enough to warrant a full regen —
  that judgment belongs to architect (difficult-path triage).
