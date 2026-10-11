import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, relative, sep } from 'node:path';

// Derive the PROJECT ROOT (the dir that owns .claude/) from the trajectory DB
// path. The DB lives at <root>/.claude/<plugin>/trajectory.db, so the root is
// the parent of the `.claude` adjacent to the DB — the INNERMOST `.claude`
// (lastIndexOf). Using the first `.claude` mis-resolves the root to an ancestor
// when the project itself is nested under a `.claude` ancestor (the L6 chain
// layout: ~/.claude/<plugin>/l6-chain-runs/<run>/project/.claude/<plugin>/trajectory.db),
// which leaks materialize/dematerialize writes outside the project. Returns null
// for an in-memory DB or a path with no `.claude` segment (e.g. a bespoke
// TRAJECTORY_DB_PATH).
export function projectRootFromDbPath(dbPath: string): string | null {
  if (!dbPath || dbPath === ':memory:') return null;
  const segments = dbPath.split(sep);
  const idx = segments.lastIndexOf('.claude');
  if (idx <= 0) return null;
  return segments.slice(0, idx).join(sep) || sep;
}

// The path the kernel would reach, for a path that may not exist yet
// (realpath -m semantics): components are walked left to right, every existing
// symlink is followed before a later `..` applies (so <root>/link/../x lands
// where link points), and `..` collapses lexically only inside the missing tail.
// macOS /tmp and /private/tmp compare equal.
export function canonicalPath(path: string): string {
  const absolute = isAbsolute(path) ? path : join(process.cwd(), path);
  const root = parse(absolute).root;
  const pending = absolute.slice(root.length).split(sep);
  const real: string[] = [];
  const tail: string[] = [];
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.shift() as string;
    if (part === '' || part === '.') continue;
    if (tail.length > 0) {
      if (part === '..') tail.pop();
      else tail.push(part);
      continue;
    }
    if (part === '..') {
      real.pop();
      continue;
    }
    const candidate = join(root, ...real, part);
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch {
      tail.push(part);
      continue;
    }
    if (stat.isSymbolicLink() && hops < 40) {
      hops += 1;
      const target = readlinkSync(candidate);
      if (isAbsolute(target)) real.length = 0;
      pending.unshift(...target.slice(isAbsolute(target) ? parse(target).root.length : 0).split(sep));
      continue;
    }
    real.push(part);
  }
  let head = join(root, ...real);
  try {
    head = realpathSync(head);
  } catch {
    // An unreadable ancestor keeps its walked form.
  }
  return tail.length > 0 ? join(head, ...tail) : head;
}

export function isWithinRoot(root: string, path: string): boolean {
  if (!isAbsolute(path)) return false;
  const rel = relative(canonicalPath(root), canonicalPath(path));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export interface OutsideProjectError {
  readonly error: 'outside_project';
  readonly message: string;
  readonly path: string;
  readonly project_root: string;
}

// Null when `path` lies under `projectRoot` (or no project root is known);
// otherwise the typed outside_project refusal a server tool returns.
export function outsideProject(
  tool: string,
  projectRoot: string | null,
  path: string,
): OutsideProjectError | null {
  if (projectRoot === null || isWithinRoot(projectRoot, path)) return null;
  return {
    error: 'outside_project',
    message: `${tool}: ${path} is outside the project ${projectRoot}; TMB writes only under the project.`,
    path,
    project_root: projectRoot,
  };
}
