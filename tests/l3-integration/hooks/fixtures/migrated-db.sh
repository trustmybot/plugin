#!/usr/bin/env bash
# migrated_db <db> — creates <db> through the trajectory-server's own migration
# path (TrajectoryDB from dist/db.js) and closes it, leaving a current-schema WAL
# DB with no -wal or -shm. Tests seed rows into it instead of hand-writing a
# schema copy, so a column the fallback reads that the schema drops fails CI.
MIGRATED_DB_DIST="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)/mcp/trajectory-server/dist"

migrated_db() {
  mkdir -p "$(dirname "$1")"
  # shellcheck disable=SC2016
  TRAJECTORY_DB_PATH="$1" DIST="$MIGRATED_DB_DIST" node --experimental-sqlite --no-warnings --input-type=module -e '
const dist = process.env.DIST;
const { TrajectoryDB } = await import(`${dist}/db.js`);
const { resetEmbeddingModelForTests } = await import(`${dist}/embeddings/model.js`);
resetEmbeddingModelForTests(() => new Promise(() => {}));
new TrajectoryDB(process.env.TRAJECTORY_DB_PATH).close();
process.exit(0);
'
}
