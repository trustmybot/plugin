# Layer 0 — upgrade smoke (GH 1465)
#
# A v1.0.x user's trajectory DB must survive the upgrade to the current server.
# GH 1464 slipped through because no test upgraded a real-shape v1.0.x DB: a
# custom audit_append event type, legal in v1.0.x, failed the current
# event_type_documented contract. This image writes that DB through the shipped
# v1.0.2 server and hook, boots the current tree's server on the same project so
# the migration runs, and requires trajectory-doctor to exit 0.
#
# Build (the wrapper supplies the v1.0.2 tree as the `v102` build context):
#   bash tests/l0-install/run-upgrade-smoke.sh
#
# Each RUN is a fail-fast assertion. Build success = the upgrade is clean.

FROM node:22-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends git jq sqlite3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=v102 . /v102
COPY . /plugin

ENV PROJECT=/project
ENV DB=/project/.claude/tmb/trajectory.db
RUN mkdir -p "$PROJECT" && git -C "$PROJECT" init -q

# U1: the shipped v1.0.2 server writes an issue, discussions, a task with its
# gate waivers, and a custom (undocumented) audit_append event type.
RUN cd "$PROJECT" \
 && node /plugin/tests/l0-install/upgrade-smoke-driver.mjs seed /v102/mcp/trajectory-server/dist/index.js

# U2: the shipped v1.0.2 swe-verification-gate hook records a verification
# waiver the way it did in a v1.0.x session (direct sqlite insert).
RUN cd "$PROJECT" \
 && echo '{"tool_name":"mcp__plugin_tmb_trajectory-server__task_update_status","tool_input":{"agent":"swe","task_id":"1","status":"completed","waive_verification_gate_reason":"L0 upgrade smoke waives its verification"}}' \
  | TRAJECTORY_DB_PATH="$DB" bash /v102/scripts/hooks/swe-verification-gate.sh

RUN OLD_V=$(grep -oE 'TARGET_SCHEMA_VERSION = [0-9]+' /v102/mcp/trajectory-server/src/db.ts | grep -oE '[0-9]+$'); \
    test "$(sqlite3 "$DB" 'SELECT schema_version FROM plugin_meta')" = "$OLD_V" \
     || { echo "❌ FAIL: seeded DB is not at the v1.0.2 schema v$OLD_V"; exit 1; }; \
    test "$(sqlite3 "$DB" "SELECT count(*) FROM audit WHERE event_type = 'upgrade_smoke_custom_event'")" = 1 \
     || { echo "❌ FAIL: v1.0.2 DB has no custom audit event type"; exit 1; }; \
    test "$(sqlite3 "$DB" "SELECT count(*) FROM audit WHERE event_type = 'verification_gate_waived'")" = 1 \
     || { echo "❌ FAIL: v1.0.2 hook wrote no verification waiver"; exit 1; }; \
    test "$(sqlite3 "$DB" 'SELECT count(*) FROM tasks')" = 1 \
     && test "$(sqlite3 "$DB" 'SELECT count(*) FROM discussions')" = 2 \
     || { echo "❌ FAIL: v1.0.2 DB is missing its task or discussions"; exit 1; }; \
    echo "v1.0.2 DB at schema v$OLD_V; audit event types:"; \
    sqlite3 "$DB" 'SELECT event_type, count(*) FROM audit GROUP BY event_type ORDER BY event_type'
RUN echo "✓ U1-U2: v1.0.2 server and hook wrote a real-shape DB with a custom audit event type"

# U3: the current tree's server boots on the same project and migrates the DB.
RUN OLD_V=$(sqlite3 "$DB" 'SELECT schema_version FROM plugin_meta'); \
    NEW_V=$(grep -oE 'TARGET_SCHEMA_VERSION = [0-9]+' /plugin/mcp/trajectory-server/src/db.ts | grep -oE '[0-9]+$'); \
    cd "$PROJECT" \
 && node /plugin/tests/l0-install/upgrade-smoke-driver.mjs boot /plugin/mcp/trajectory-server/dist/index.js \
 && ACTUAL_V=$(sqlite3 "$DB" 'SELECT schema_version FROM plugin_meta') \
 && { test "$ACTUAL_V" = "$NEW_V" || { echo "❌ FAIL: schema v$ACTUAL_V after boot, expected v$NEW_V"; exit 1; }; } \
 && { ls "$DB".pre-v"$NEW_V".*.bak >/dev/null 2>&1 || { echo "❌ FAIL: no pre-v$NEW_V backup written"; exit 1; }; } \
 && { test "$(sqlite3 "$DB" "SELECT count(*) FROM audit WHERE event_type = 'upgrade_smoke_custom_event' OR content_json LIKE '%upgrade_smoke_custom_event%'")" = 1 \
      || { echo "❌ FAIL: the custom audit event was lost in the migration"; exit 1; }; } \
 && echo "current server migrated the v1.0.2 DB: schema v$OLD_V -> v$ACTUAL_V; audit event types:" \
 && sqlite3 "$DB" 'SELECT event_type, count(*) FROM audit GROUP BY event_type ORDER BY event_type'
RUN echo "✓ U3: current server migrated the v1.0.2 DB"

# U4: the upgraded DB passes every data contract.
RUN bash /plugin/scripts/maintenance/trajectory-doctor.sh --db "$DB" \
 || { echo "❌ FAIL: trajectory-doctor did not exit 0 on the upgraded v1.0.2 DB"; exit 1; }
RUN echo "✓ Layer 0 upgrade-smoke: v1.0.2 DB upgraded by the current server passes trajectory-doctor"
