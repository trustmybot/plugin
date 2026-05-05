---
name: tmb_refresh-architecture
description: Wraps the architecture_regen MCP tool to regenerate auto/ architecture docs. Invoked by bro after difficult-path structural changes, at session start for incremental refresh, and via Human phrase trigger for a full regen.
---

# refresh-architecture

## Purpose

Triggers regeneration of the `docs/trustmybot/architecture/auto/` directory
by calling the `architecture_regen` MCP tool. It does not touch
`docs/trustmybot/architecture/manual/` under any circumstances.

## Invocation

One caller, two scopes:

- **Bro** calls `scope:'full'` after a difficult-path task completes a
  structural change (new module boundary, schema change, new dependency,
  public API surface change). Bro is the planner; difficult-path triage
  signals when a full regen is warranted.
- **Bro** calls `scope:'incremental'` lazily at session start, before
  routing the first code-touching ask, to sync any drift from commits made
  outside a full regen cycle. See `lazy-regen-check`.
- **Human** triggers a full regen by asking bro one of these phrases:
  "refresh architecture docs", "refresh architecture", "regenerate
  architecture", or "regen architecture". Bro recognises any of these
  phrases and invokes this skill with `scope:'full'` directly — this is a
  direct op, not a code change.

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

## regen_state contract

The `architecture_regen` MCP tool auto-writes `regen_state` rows on every
successful regen — this skill does NOT need to call `regen_state_set`
explicitly. Each regen target (`file_registry`, `codebase_tree`, `erd`,
`module_graph`, `changelog`) gets its own row keyed by the target name; the
tool updates `last_regen_at` and `last_seen_sha` for each target it processes.
`lazy-regen-check` reads these rows to determine staleness at session start.

## Post-regen

After the MCP call returns, compare the reported changed files against the
previous content. If any file changed, emit exactly one line to the Human (or
the calling agent's output):

> "Regenerated N files: file-a.md, file-b.md, file-c.md."

If no files changed, emit nothing — silence is the correct output for a no-op
incremental sync.

## Failure modes

If `architecture_regen` returns an error:

1. Surface the MCP error message verbatim to the Human.
2. State: "Architecture auto/ docs were not updated. Manual review may be
   needed."
3. Do NOT retry automatically. The Human decides next steps.

Common causes: the MCP server is not running, the SQLite `file_registry` table
is missing, or the git working tree is dirty with uncommitted files that the
tool cannot parse. Resolve the underlying condition, then re-invoke.

## Out of scope

- Reading `docs/trustmybot/architecture/manual/` — agents read that directly.
- Editing any file in `docs/trustmybot/architecture/auto/` by hand — the MCP
  tool owns those files exclusively.
- Deciding whether a change is structural enough to warrant a full regen —
  that judgment belongs to bro (difficult-path triage).
