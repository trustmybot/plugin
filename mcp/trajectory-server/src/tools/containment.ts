import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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

// Canonical form of a path that may not exist yet: the realpath of its longest
// existing ancestor joined with the missing tail, so symlinks (macOS /tmp →
// /private/tmp) resolve the same way for the root and the candidate.
export function canonicalPath(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(basename(head));
    head = parent;
  }
  let real = head;
  try {
    real = realpathSync(head);
  } catch {
    // An unreadable ancestor keeps its lexical form.
  }
  return tail.length > 0 ? join(real, ...tail) : real;
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
