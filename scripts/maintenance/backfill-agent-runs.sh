#!/usr/bin/env bash
# Recover agent_runs rows from the Claude Code transcripts still on disk — a
# terminal wrapper over the trajectory server's agent_runs_backfill tool,
# called as bro. Transcripts are read, never written; the only write is to the
# project's trajectory DB, and only with --apply.
#
# Usage (from the project directory, or with TRAJECTORY_DB_PATH set):
#   backfill-agent-runs.sh [--apply] [--since <ISO>] [--transcripts-dir <dir>]
#
# Without --apply it is a dry run: prints the report, writes nothing.
# --transcripts-dir overrides ~/.claude/projects/<project-slug>.
# Exits 1 when the DB cannot be found or the tool reports an error.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIST="$(cd "$HERE/../../mcp/trajectory-server/dist" && pwd)"

DRY_RUN=true
SINCE=""
TRANSCRIPTS_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) DRY_RUN=false; shift ;;
    --since) SINCE="${2:?--since needs an ISO timestamp}"; shift 2 ;;
    --transcripts-dir) TRANSCRIPTS_DIR="${2:?--transcripts-dir needs a path}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "backfill-agent-runs: unknown argument: $1" >&2; exit 2 ;;
  esac
done

TMB_BACKFILL_DIST="$SERVER_DIST" TMB_BACKFILL_DRY_RUN="$DRY_RUN" TMB_BACKFILL_SINCE="$SINCE" \
TMB_BACKFILL_DIR="$TRANSCRIPTS_DIR" \
  node --experimental-sqlite --no-warnings --input-type=module -e '
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
const env = process.env;
const dist = (p) => pathToFileURL(`${env.TMB_BACKFILL_DIST}/${p}`).href;
const { TrajectoryDB, resolveDbPath } = await import(dist("db.js"));
const { agentRunsBackfillTools } = await import(dist("tools/agent-runs-backfill.js"));
const dbPath = resolveDbPath();
if (dbPath === ":memory:" || !existsSync(dbPath)) {
  console.error(`backfill-agent-runs: no trajectory DB at ${dbPath}; run from the project or set TRAJECTORY_DB_PATH`);
  process.exit(1);
}
const db = new TrajectoryDB(dbPath);
const args = { agent: "bro", dry_run: env.TMB_BACKFILL_DRY_RUN !== "false" };
if (env.TMB_BACKFILL_SINCE) args.since = env.TMB_BACKFILL_SINCE;
if (env.TMB_BACKFILL_DIR) args.transcripts_dir = env.TMB_BACKFILL_DIR;
const res = await agentRunsBackfillTools(db, dbPath).handlers.agent_runs_backfill(args);
db.close();
const body = JSON.parse(res.content[0].text);
console.log(JSON.stringify(body, null, 2));
process.exit(res.isError ? 1 : 0);
'
