# 0002 — Deterministic Stack Detection

**Status**: Accepted
**Date**: 2026-05-05
**Issue**: #179
**Design doc**: `../../PROJECT_METADATA.md`

## Context

Bro's planning skills (`tmb_planning-difficult`, `tmb_planning-simple`) currently re-probe the project's language and tool stack via prompt-engineered bash blocks. Every fresh-session bro re-runs the same probes; output is non-deterministic; adding a new ecosystem requires editing every planning skill. This violates the project's prompt-engineering philosophy ("use as many deterministic layers as possible").

GitHub solved this class of problem with **Linguist** — a deterministic Ruby tool that byte-counts files, applies heuristics, persists language metadata to repo data, and is read by the UI. Zero LLM. Mirror the pattern locally.

## Decision

Adopt a 4-layer architecture for project stack metadata:

1. **Detection script** at `plugin/scripts/detect-stack.sh` (Anthropic skill-bundled anatomy). Pure shell. Standalone-hookable. Hybrid: prefer `enry` or `tokei` for languages when installed; fall back to file-presence heuristics otherwise. `command -v` for installed tools.

2. **MCP tools** `project_metadata_detect` (`requireRoles: ['bro']`) and `project_metadata_get` (`requireRoles: ['bro', 'swe', 'pr-reviewer']`) wrapping the script and providing typed contracts.

3. **Storage** in the existing `config` table under sentinel key `_meta_detected_stack`. No schema migration. The `_meta_` prefix is the convention separating auto-detected metadata from user-set policy keys.

4. **Skill consumption**: `tmb_project-prescan` invokes detect on every prescan (idempotent). `lazy-regen-check` calls detect and acts on `changed=true` (drift trigger). `tmb_planning-difficult` and `tmb_planning-simple` replace probe paragraphs with one-line `project_metadata_get` reads.

## Alternatives considered

| Alternative | Rejected because |
|---|---|
| Inline Linguist Ruby gem dep | Heavy runtime, Ruby on every dev machine |
| Mandate `enry` or `tokei` as hard dep | None installed locally; raises floor for low value v1 |
| Hand-roll language detection only | Doesn't cover installed-tool detection (the actually-needed primitive for planning) |
| New `project_metadata` table | Schema migration overhead vs. config-row contract |
| Skills call `config_set` directly without MCP wrap | No typed contract; agent-scope can't restrict reads vs writes cleanly |
| Detect once at install time only | Misses drift (user installs `uv` mid-session); no idempotent re-run |

## Consequences

**Positive**:
- Planning skills shrink (probe paragraphs disappear).
- Fresh-session bro reads metadata instead of re-probing.
- Drift detection enables proactive re-planning when stack changes.
- New ecosystems are added in the script (one place), not every skill.
- Standalone-hookable script means future hooks can warm or check the cache without going through MCP.

**Negative / cost**:
- New MCP tool surface area (~150 LOC TS + tests).
- Convention-only `_meta_` prefix; not enforced by schema. Future hardening may add a write-block.
- `execFileSync` from Node introduces a process-spawn cost (~10-50ms) on every detect call. Acceptable since detect runs at most twice per session (prescan + drift check).

**Follow-on**:
- Once L0–L4 are green and L5 baseline holds: consider promoting `_meta_*` write-block to a hard rule in `config_set`.
- If multi-root workspaces become real (#174), revisit the per-repo cache key (`_meta_detected_stack:<repo_path>`).
