#!/usr/bin/env bash
# Check a trajectory DB against its data contracts. Prints the JSON report.
# The check opens the DB file on a query-only connection — never as the
# server does — so it applies no schema and runs no migration: an older DB is
# reported as it is. --record adds one trajectory_doctor_run audit row through
# the trajectory server's trajectory_doctor tool, called as bro, and only on a
# DB already at the server's schema version.
#
# Usage (from the project directory, or with --db / TRAJECTORY_DB_PATH):
#   trajectory-doctor.sh [--db <path>] [--ids <id,id,...>] [--record]
#
# Exits 0 when healthy, 1 when an error-severity contract fails or cannot run,
# 2 when the DB schema is older than the contracts need (start the trajectory
# server to migrate), on a usage error, a missing DB, or a tool error.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIST="$(cd "$HERE/../../mcp/trajectory-server/dist" && pwd)"

RECORD=false
IDS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --record) RECORD=true; shift ;;
    --ids) IDS="${2:?--ids needs a comma-separated id list}"; shift 2 ;;
    --db) export TRAJECTORY_DB_PATH="${2:?--db needs a path}"; shift 2 ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "trajectory-doctor: unknown argument: $1" >&2; exit 2 ;;
  esac
done

TMB_DOCTOR_DIST="$SERVER_DIST" TMB_DOCTOR_RECORD="$RECORD" TMB_DOCTOR_IDS="$IDS" \
  node --experimental-sqlite --no-warnings --input-type=module -e '
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
const env = process.env;
const dist = (p) => pathToFileURL(`${env.TMB_DOCTOR_DIST}/${p}`).href;
const { resolveDbPath } = await import(dist("db.js"));
const dbPath = resolveDbPath();
if (dbPath === ":memory:" || !existsSync(dbPath)) {
  console.error(`trajectory-doctor: no trajectory DB at ${dbPath}; run from the project or pass --db`);
  process.exit(2);
}
const { checkTrajectoryDbFile, selectContracts, trajectoryDoctorTools } = await import(dist("tools/trajectory-doctor.js"));
const ids = env.TMB_DOCTOR_IDS ? env.TMB_DOCTOR_IDS.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
const selected = selectContracts(ids);
if ("error" in selected) {
  console.log(JSON.stringify(selected, null, 2));
  process.exit(2);
}
let report = checkTrajectoryDbFile(dbPath, selected.contracts);
if (!report.schema.current) {
  console.log(JSON.stringify(report, null, 2));
  console.error(`trajectory-doctor: unchecked (schema v${report.schema.stored} < v${report.schema.required} — start the trajectory server to migrate)`);
  process.exit(2);
}
if (env.TMB_DOCTOR_RECORD === "true") {
  const { TrajectoryDB, TARGET_SCHEMA_VERSION } = await import(dist("db.js"));
  if (report.schema.stored !== TARGET_SCHEMA_VERSION) {
    console.log(JSON.stringify(report, null, 2));
    console.error(`trajectory-doctor: --record needs the server schema v${TARGET_SCHEMA_VERSION} (DB is v${report.schema.stored}) — start the trajectory server to migrate; nothing recorded`);
    process.exit(2);
  }
  const db = new TrajectoryDB(dbPath);
  const args = { agent: "bro", record: true };
  if (ids) args.ids = ids;
  const res = await trajectoryDoctorTools(db).handlers.trajectory_doctor(args);
  db.close();
  report = JSON.parse(res.content[0].text);
  if (res.isError) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(2);
  }
}
console.log(JSON.stringify(report, null, 2));
process.exit(report.healthy ? 0 : 1);
'
