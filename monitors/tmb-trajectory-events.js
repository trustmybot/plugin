#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const dataDir = process.env.CLAUDE_PLUGIN_DATA;
if (!dataDir) process.exit(0);

const dbPath = path.join(dataDir, 'trajectory.db');
if (!fs.existsSync(dbPath)) process.exit(0);

const cursorPath = path.join(dataDir, 'monitor-cursor.json');

let Database;
try {
  Database = require('better-sqlite3');
} catch (_) {
  process.exit(0);
}

let db;
try {
  db = new Database(dbPath, { readonly: true });
} catch (_) {
  process.exit(0);
}

try {
  let cursor = 0;
  try {
    const raw = fs.readFileSync(cursorPath, 'utf8');
    const parsed = JSON.parse(raw);
    cursor = typeof parsed.lastId === 'number' ? parsed.lastId : 0;
  } catch (_) {
    cursor = 0;
  }

  let rows;
  try {
    rows = db.prepare(
      "SELECT id, branch_id, event_type, summary FROM ledger " +
      "WHERE id > ? AND event_type IN ('task_failed','escalation','retry_exhausted') " +
      "ORDER BY id ASC"
    ).all(cursor);
  } catch (_) {
    process.exit(0);
  }

  let lastId = cursor;
  for (const row of rows) {
    process.stdout.write(`[TMB] ${row.event_type} · task ${row.branch_id} · ${row.summary}\n`);
    if (row.id > lastId) lastId = row.id;
  }

  if (lastId !== cursor) {
    fs.writeFileSync(cursorPath, JSON.stringify({ lastId }), 'utf8');
  }
} catch (_) {
  // never crash
} finally {
  try { db.close(); } catch (_) {}
}

process.exit(0);
