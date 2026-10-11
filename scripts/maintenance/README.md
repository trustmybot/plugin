# scripts/maintenance

Operational and one-off scripts that keep a TMB install healthy: version bumps, cache remediation, stale-worktree cleanup, and the standalone scan invokers fired by hooks. These are not part of the per-turn hot path — they run on demand (a person, a release flow) or as the body a hook shells out to.

## Files

| File | Purpose |
|---|---|
| `bump-version.sh` | Atomic plugin-version bump — updates the five files that must stay in sync (the Claude and Codex manifests, two package manifests, and the `bun.lock` workspace version), or fails leaving every file unchanged. Idempotent. |
| `heal-mcp-cache.sh` | Interactive remediation for the Claude Code plugin MCP-config cache bug — clears stale `disabledMcpServers` entries and other recovery steps. |
| `cleanup-stale-worktrees.sh` | One-time cleanup of repo-rooted SWE worktrees left over before worktrees moved to workspace-rooted paths. Idempotent. |
| `backfill-agent-runs.sh` | Recovers `agent_runs` rows from the Claude Code transcripts still on disk by calling the server's `agent_runs_backfill` tool as bro. Dry run by default (`--apply` writes; `--since`, `--transcripts-dir`); reads transcripts only and writes nothing but the project's trajectory DB. Idempotent. |
| `run-scan.mjs` | Standalone scan invoker used by the `post-task-close-rescan.sh` hook to re-run the scan against the current commit after an atomic close. Reuses the same `scan_run` logic as the MCP tool; silent on failure. |
| `gen-enums-doc.mjs` | Generates what derives from `mcp/trajectory-server/src/audit-events.ts` (read through its compiled `dist/`): `--txt` writes `scripts/hooks/lib/audit-events.txt` (run by `npm run build`), `--doc` rewrites the `audit.event_type` table in `docs/contributing/ENUMS.md` between its generated markers, `--check` only reports which is stale (`tests/l1-lint/enums-doc-fresh.sh`). |
| `run-scan-initial.mjs` | Mirror of `run-scan.mjs` for the cold-world-model SessionStart prescan, tagged with a distinct audit source. Silent on failure. |
| `trajectory-doctor.sh` | Checks a trajectory DB against its data contracts (`--db <path>`, `--ids a,b`, `--record`) on a query-only connection from `dist/` — no schema applied, no migration; prints the JSON report. Exits 1 when an error-severity contract fails or cannot run, 2 when the DB schema is older than the contracts need (start the trajectory server to migrate) or on a usage/DB error. `--record` writes the `trajectory_doctor_run` row through the `trajectory_doctor` tool handler, only on a DB at the server's schema version. The L5/L6 runners call it on the run's DB. |
| `emit-data-contracts.mjs` | Regenerates `scripts/hooks/lib/data-contracts.json` (the SessionStart banner's copy of the contracts) from the built server; `--check` exits 1 when the committed file is stale. Run after `npm run build`. |

## How it fits

`bump-version.sh` backs the release/version-sync flow; `heal-mcp-cache.sh` and `cleanup-stale-worktrees.sh` are recovery tooling, as is `backfill-agent-runs.sh` for metering lost before v1.0.3; the two `run-scan*.mjs` invokers let hooks refresh the world model without duplicating the MCP tool's scan logic; `trajectory-doctor.sh` and `emit-data-contracts.mjs` carry the trajectory DB data contracts to the terminal, the test runners and the SessionStart hook. Scripts that call into the server (`backfill-agent-runs.sh`, `trajectory-doctor.sh`, `run-scan.mjs`) import `db.js`, resolve and check the DB path, and only then import a tool module, so a missing DB exits 2 and creates nothing.
