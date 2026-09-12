import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { endianness } from "node:os";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

export const BRANCH_POLICY_TIMEOUT_MS = 500;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_PROTECTED_BRANCHES = 1024;
const SIDECARS = ["-wal", "-shm", "-journal"];
const READ_ONLY_PROFILE = "(version 1) (allow default) (deny file-write*) (deny network*)";
// Do not introspect virtual tables: their connect callbacks may perform I/O.
// CASE short-circuiting checks the stored schema before table_info runs.
const ORDINARY_CORE_TABLES = `(SELECT count(*) FROM sqlite_schema
  WHERE name IN ('repos', 'tasks') AND type='table' AND upper(sql) LIKE 'CREATE TABLE %') = 2`;
const SCHEMA_QUERY = `SELECT json_object(
  'objects', (SELECT json_group_array(json_object('name', name, 'type', type, 'sql', sql))
    FROM sqlite_schema WHERE name IN ('repos', 'tasks')),
  'repos', CASE WHEN ${ORDINARY_CORE_TABLES} THEN (SELECT json_group_array(name) FROM pragma_table_info('repos')) ELSE NULL END,
  'tasks', CASE WHEN ${ORDINARY_CORE_TABLES} THEN (SELECT json_group_array(name) FROM pragma_table_info('tasks')) ELSE NULL END
) AS result;`;

function fail(reason) {
  throw new Error(reason);
}

function optionalStat(path) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("Codex branch policy state cannot be inspected");
  }
}

function fingerprint(stats) {
  return [stats.dev, stats.ino, stats.mode, stats.nlink, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
}

function directory(path) {
  const stats = optionalStat(path);
  if (stats && (!stats.isDirectory() || stats.isSymbolicLink() || realpathSync(path) !== path)) {
    fail("Codex branch policy directories must be real directories without aliases");
  }
  return stats ? `${stats.dev}:${stats.ino}` : null;
}

function fileSnapshot(path, remainingBytes) {
  const stats = optionalStat(path);
  if (!stats) return null;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) {
    fail("Codex branch policy files must be ordinary files without links");
  }
  if (stats.size > BigInt(remainingBytes)) fail("Codex branch policy state exceeds the 64 MiB read limit");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (fingerprint(fstatSync(fd, { bigint: true })) !== fingerprint(stats)) {
      fail("Codex branch policy state changed while opening it");
    }
    const hash = createHash("sha256");
    const content = Buffer.allocUnsafe(Number(stats.size));
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < Number(stats.size)) {
      const bytes = readSync(fd, chunk, 0, Math.min(chunk.length, Number(stats.size) - position), position);
      if (bytes === 0) fail("Codex branch policy state changed while reading it");
      hash.update(chunk.subarray(0, bytes));
      chunk.copy(content, position, 0, bytes);
      position += bytes;
    }
    if (readSync(fd, chunk, 0, 1, position) !== 0) fail("Codex branch policy state grew while reading it");
    const digest = hash.digest("hex");
    if (fingerprint(fstatSync(fd, { bigint: true })) !== fingerprint(stats)) {
      fail("Codex branch policy state changed while reading it");
    }
    return { fingerprint: fingerprint(stats), digest, bytes: Number(stats.size), content };
  } finally {
    closeSync(fd);
  }
}

function checksum(bytes, bigEndian, initial = [0, 0]) {
  const read = bigEndian ? Buffer.prototype.readUInt32BE : Buffer.prototype.readUInt32LE;
  let [first, second] = initial;
  for (let offset = 0; offset < bytes.length; offset += 8) {
    first = (first + read.call(bytes, offset) + second) >>> 0;
    second = (second + read.call(bytes, offset + 4) + first) >>> 0;
  }
  return [first, second];
}

// SQLite's recovery ignores an invalid WAL suffix. For a protection policy,
// silently using an older checkpoint is unsafe. Accept only complete committed
// WAL generations whose index and backfilled pages agree with the same bytes.
// Format references: SQLite fileformat2 sections 4.1-4.2 and walformat section 2.
function validateWalState(database, wal, shm, deadline) {
  if (database.length < 100 || database.subarray(0, 16).toString("binary") !== "SQLite format 3\0"
    || database[18] !== 2 || database[19] !== 2 || wal.length < 32) {
    fail("Codex branch policy has an unsupported or incomplete WAL database");
  }
  const magic = wal.readUInt32BE(0);
  const bigEndian = magic === 0x377f0683;
  const pageSize = wal.readUInt32BE(8);
  const dbPageSize = database.readUInt16BE(16) === 1 ? 65_536 : database.readUInt16BE(16);
  const frameSize = 24 + pageSize;
  if (![0x377f0682, 0x377f0683].includes(magic) || wal.readUInt32BE(4) !== 3_007_000
    || pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0
    || pageSize !== dbPageSize || database.length % pageSize !== 0
    || (wal.length - 32) % frameSize !== 0 || wal.length === 32) {
    fail("Codex branch policy WAL format is invalid or unsupported");
  }
  let sums = checksum(wal.subarray(0, 24), bigEndian);
  if (sums[0] !== wal.readUInt32BE(24) || sums[1] !== wal.readUInt32BE(28)) {
    fail("Codex branch policy WAL header checksum is invalid");
  }
  const frames = [];
  for (let offset = 32; offset < wal.length; offset += frameSize) {
    remainingTime(deadline);
    const page = wal.readUInt32BE(offset);
    const pages = wal.readUInt32BE(offset + 4);
    if (page === 0 || page === 0xffffffff || pages === 0xffffffff
      || !wal.subarray(offset + 8, offset + 16).equals(wal.subarray(16, 24))) {
      fail("Codex branch policy WAL frame or generation is invalid");
    }
    sums = checksum(wal.subarray(offset, offset + 8), bigEndian, sums);
    sums = checksum(wal.subarray(offset + 24, offset + frameSize), bigEndian, sums);
    if (sums[0] !== wal.readUInt32BE(offset + 16) || sums[1] !== wal.readUInt32BE(offset + 20)) {
      fail("Codex branch policy WAL frame checksum is invalid");
    }
    frames.push({ page, pages, offset });
  }
  const final = frames.at(-1);
  if (final.pages === 0) fail("Codex branch policy WAL has an uncommitted tail");

  const nativeBigEndian = endianness() === "BE";
  const read32 = (offset) => nativeBigEndian ? shm.readUInt32BE(offset) : shm.readUInt32LE(offset);
  const read16 = (offset) => nativeBigEndian ? shm.readUInt16BE(offset) : shm.readUInt16LE(offset);
  if (shm.length < 32_768 || shm.length % 32_768 !== 0
    || !shm.subarray(0, 48).equals(shm.subarray(48, 96))) {
    fail("Codex branch policy WAL index headers are invalid or inconsistent");
  }
  const indexSums = checksum(shm.subarray(0, 40), nativeBigEndian);
  if (read32(0) !== 3_007_000 || read32(4) !== 0 || shm[12] !== 1 || shm[13] !== Number(bigEndian)
    || (read16(14) === 1 ? 65_536 : read16(14)) !== pageSize
    || read32(16) !== frames.length || read32(20) !== final.pages
    || read32(24) !== sums[0] || read32(28) !== sums[1]
    || !shm.subarray(32, 40).equals(wal.subarray(16, 24))
    || read32(40) !== indexSums[0] || read32(44) !== indexSums[1]
    || read32(96) > frames.length || read32(128) > frames.length) {
    fail("Codex branch policy WAL index does not match the committed WAL");
  }

  // Validate the lookup arrays too: valid index headers cannot authenticate
  // a corrupted page mapping or a hash slot that hides a newer WAL page.
  let frame = 0;
  for (let group = 0; frame < frames.length; group += 1) {
    remainingTime(deadline);
    const start = group * 32_768;
    if (shm.length < start + 32_768) fail("Codex branch policy WAL index is truncated");
    const count = Math.min(group === 0 ? 4062 : 4096, frames.length - frame);
    const pageOffset = start + (group === 0 ? 136 : 0);
    const expectedHash = new Uint16Array(8192);
    for (let index = 0; index < count; index += 1) {
      const page = frames[frame++].page;
      if (read32(pageOffset + index * 4) !== page) fail("Codex branch policy WAL page index is inconsistent");
      let slot = (page * 383) % 8192;
      while (expectedHash[slot] !== 0) slot = (slot + 1) % 8192;
      expectedHash[slot] = index + 1;
    }
    for (let slot = 0; slot < 8192; slot += 1) {
      if (read16(start + 16_384 + slot * 2) !== expectedHash[slot]) {
        fail("Codex branch policy WAL hash index is inconsistent");
      }
    }
  }

  // nBackfill can cause SQLite to bypass WAL pages. Verify every claimed
  // backfilled page so stale or forged SHM cannot select an old checkpoint.
  const backfill = read32(96);
  if (backfill > 0) {
    const pages = frames[backfill - 1].pages;
    if (pages === 0) fail("Codex branch policy WAL checkpoint boundary is invalid");
    const latest = new Map();
    for (const frame of frames.slice(0, backfill)) latest.set(frame.page, frame.offset);
    for (const [page, offset] of latest) {
      remainingTime(deadline);
      if (page <= pages && !database.subarray((page - 1) * pageSize, page * pageSize)
        .equals(wal.subarray(offset + 24, offset + frameSize))) {
        fail("Codex branch policy WAL checkpoint disagrees with the database");
      }
    }
  }
}

function snapshot(root, pluginName, deadline) {
  const directories = [root, join(root, ".tmb"), join(root, ".tmb", pluginName)];
  const identities = directories.map(directory);
  if (!identities[0]) fail("Codex branch policy root does not exist");
  const dbPath = join(directories[2], "trajectory.db");
  const files = [];
  let remaining = MAX_SNAPSHOT_BYTES;
  for (const suffix of ["", ...SIDECARS]) {
    const file = fileSnapshot(`${dbPath}${suffix}`, remaining);
    remaining -= file?.bytes ?? 0;
    files.push(file);
    remainingTime(deadline);
  }
  if (files[0] && files[1] && files[2]) {
    validateWalState(files[0].content, files[1].content, files[2].content, deadline);
  }
  return { identities, files: files.map((file) => file && {
    fingerprint: file.fingerprint, digest: file.digest, bytes: file.bytes,
  }), dbPath };
}

function remainingTime(deadline) {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) fail("Codex branch policy read exceeded its 500 ms deadline");
  return remaining;
}

function query(database, sql, deadline) {
  let output;
  try {
    output = execFileSync("/usr/bin/sandbox-exec", [
      "-p", READ_ONLY_PROFILE, "/usr/bin/sqlite3", "-batch", "-readonly", "-json",
      "-init", "/dev/null", "-cmd", ".timeout 0",
      "-cmd", "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;",
      database, sql,
    ], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: remainingTime(deadline),
      maxBuffer: 256 * 1024,
    });
  } catch {
    fail("Codex branch policy cannot be read through the macOS read-only sandbox");
  }
  remainingTime(deadline);
  const rows = JSON.parse(output);
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0]?.result !== "string") {
    fail("Codex branch policy query returned an invalid result");
  }
  return JSON.parse(rows[0].result);
}

function quoteSql(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function policyQuery(root, legacyPrTarget) {
  const path = quoteSql(root);
  return `SELECT json_object(
    'repos', (SELECT json_group_array(json_object('name', name,
      'protected_branches', protected_branches, 'target_branch', target_branch,
      'pr_target', ${legacyPrTarget ? "pr_target" : "NULL"}))
      FROM (SELECT * FROM repos WHERE path = ${path} LIMIT 2)),
    'parents', (SELECT json_group_array(parent_branch_id) FROM
      (SELECT DISTINCT parent_branch_id FROM tasks
        WHERE parent_branch_id IS NOT NULL AND parent_branch_id != ''
          AND (repo = (SELECT name FROM repos WHERE path = ${path} LIMIT 1)
            OR repo IS NULL)
        LIMIT ${MAX_PROTECTED_BRANCHES + 1}))
  ) AS result;`;
}

function validateSchema(schema) {
  if (!schema || !Array.isArray(schema.objects) || schema.objects.length !== 2
    || schema.objects.some((entry) => entry.type !== "table" || !/^CREATE\s+TABLE\b/iu.test(entry.sql ?? ""))
    || !Array.isArray(schema.repos) || !Array.isArray(schema.tasks)
    || !["name", "path", "protected_branches", "target_branch"].every((column) => schema.repos.includes(column))
    || !["repo", "parent_branch_id"].every((column) => schema.tasks.includes(column))) {
    fail("Codex branch policy database has an unsupported schema");
  }
}

function protectedBranches(policy) {
  if (!policy || !Array.isArray(policy.repos) || !Array.isArray(policy.parents) || policy.repos.length > 1) {
    fail("Codex branch policy repository registration is ambiguous or invalid");
  }
  // NULL-repo tasks can predate /scan and remain after more repos are added.
  // Their shared parents must not disappear when registration changes.
  const values = [...policy.parents];
  if (policy.repos.length === 1) {
    const row = policy.repos[0];
    if (typeof row.name !== "string" || row.name.length === 0) fail("Codex branch policy repository name is invalid");
    let configured;
    try {
      configured = row.protected_branches === null ? [] : JSON.parse(row.protected_branches);
    } catch {
      fail("Codex protected_branches must be a JSON array of branch names");
    }
    if (!Array.isArray(configured)) fail("Codex protected_branches must be a JSON array of branch names");
    values.push(...configured);
    for (const value of [row.target_branch, row.pr_target]) {
      if (value !== null && value !== "") values.push(value);
    }
  }
  if (values.length > MAX_PROTECTED_BRANCHES || values.some((value) =>
    typeof value !== "string" || value.length === 0 || value.length > 255 || /[\x00-\x20\x7f]/u.test(value))) {
    fail("Codex branch policy contains invalid or excessive protected branch names");
  }
  return [...new Set(values)].sort();
}

/**
 * Read only Codex's worktree-local policy. SQLite's readOnly flag alone can
 * mutate WAL shared memory; the OS sandbox enforces the absence of writes.
 * A closed database with no sidecars is read as immutable only while complete
 * before/after snapshots agree. This detects changes, not an atomic filesystem
 * snapshot: the caller retains the same path/state TOCTOU boundary as the Hook.
 */
export function readProtectedBranchPolicy(root, pluginName) {
  const deadline = performance.now() + BRANCH_POLICY_TIMEOUT_MS;
  try {
    if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root
      || typeof pluginName !== "string" || pluginName.length === 0 || pluginName.trim() !== pluginName
      || [".", ".."].includes(pluginName) || /[/\\\x00]/u.test(pluginName)) {
      fail("Codex branch policy requires a canonical root and a safe plugin name");
    }
    const before = snapshot(root, pluginName, deadline);
    remainingTime(deadline);
    const [db, wal, shm, journal] = before.files;
    if (!db) {
      if (wal || shm || journal) fail("Codex branch policy has sidecars without a database");
      return { ok: true, protectedBranches: [] };
    }
    if (process.platform !== "darwin") fail("Codex branch policy reads require the macOS read-only sandbox");
    if (journal || Boolean(wal) !== Boolean(shm)) fail("Codex branch policy has incomplete or unsupported journal state");
    const immutable = !wal && !shm;
    const database = immutable ? `${pathToFileURL(before.dbPath).href}?mode=ro&immutable=1` : before.dbPath;
    const schema = query(database, SCHEMA_QUERY, deadline);
    validateSchema(schema);
    // Never start an immutable policy query if a writer appeared after schema inspection.
    if (JSON.stringify(snapshot(root, pluginName, deadline)) !== JSON.stringify(before)) {
      fail("Codex branch policy state changed during inspection");
    }
    const result = protectedBranches(query(database, policyQuery(root, schema.repos.includes("pr_target")), deadline));
    if (JSON.stringify(snapshot(root, pluginName, deadline)) !== JSON.stringify(before)) {
      fail("Codex branch policy state changed during inspection");
    }
    remainingTime(deadline);
    return { ok: true, protectedBranches: result };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Codex branch policy is unavailable" };
  }
}
