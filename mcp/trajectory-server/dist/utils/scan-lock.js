// Scan locks beside the trajectory DB (#339, GH 2584): scan.lock for a
// workspace scan, scan.<repo>.lock for one repo's reindex. A lock is a JSON
// {pid, started_at} file created with `wx`; a lock whose pid is gone is
// stale and is taken over.
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nowISO } from '../db.js';
export function scanLockPath(dbPath, repo) {
    if (!dbPath || dbPath === ':memory:')
        return '';
    return join(dirname(dbPath), repo === undefined ? 'scan.lock' : `scan.${encodeURIComponent(repo)}.lock`);
}
export function readLock(lockPath) {
    try {
        return JSON.parse(readFileSync(lockPath, 'utf8'));
    }
    catch {
        return null;
    }
}
export function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
export function liveLock(lockPath) {
    if (!lockPath)
        return null;
    const lock = readLock(lockPath);
    return lock && pidAlive(lock.pid) ? lock : null;
}
export function acquireLock(lockPath) {
    const existing = readLock(lockPath);
    if (existing) {
        if (pidAlive(existing.pid))
            return false;
        unlinkSync(lockPath);
    }
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: nowISO() }), { flag: 'wx' });
    return true;
}
// acquireLock that never throws: false when another live process holds it or
// the write raced one; true when this process holds it now, or when no lock
// can be written at all (no DB dir), as there is then no other holder to guard
// against.
export function tryLock(lockPath) {
    if (!lockPath)
        return true;
    try {
        return acquireLock(lockPath);
    }
    catch {
        return liveLock(lockPath) === null && readLock(lockPath) === null;
    }
}
export function releaseLock(lockPath) {
    if (!lockPath)
        return;
    try {
        unlinkSync(lockPath);
    }
    catch {
        // already removed — not an error
    }
}
//# sourceMappingURL=scan-lock.js.map