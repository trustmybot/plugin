import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolvePluginName } from './db.js';

const logDir = join(homedir(), '.claude', resolvePluginName(process.env), 'logs');
let logDirReady = false;

try {
  mkdirSync(logDir, { recursive: true });
  logDirReady = true;
} catch {
  // Log dir creation failed; both log functions become no-ops.
}

const serverLogPath = join(logDir, 'mcp-server.log');
const sqlLogPath = join(logDir, 'sql.log');

const sqlEnabled = process.env['TMB_DEBUG_SQL'] === '1';

export function serverLog(entry: Record<string, unknown>): void {
  if (!logDirReady) return;
  try {
    const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
    appendFileSync(serverLogPath, line);
  } catch {
    // Swallow all errors — logging must never break the server.
  }
}

export function serverLogSync(entry: Record<string, unknown>): void {
  if (!logDirReady) return;
  try {
    const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
    writeFileSync(serverLogPath, line, { flag: 'a' });
  } catch {
    // Swallow all errors — logging must never break the server.
  }
}

export const sqlLog: (entry: Record<string, unknown>) => void = sqlEnabled
  ? (entry) => {
      if (!logDirReady) return;
      try {
        const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
        appendFileSync(sqlLogPath, line);
      } catch {
        // Swallow all errors.
      }
    }
  : () => {};
