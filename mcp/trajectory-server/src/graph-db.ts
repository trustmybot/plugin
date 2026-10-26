// Path-opened world-model graph, re-exported by the bundled scan entry
// (src/run-scan.ts) that the hook scan invokers import. The world model lives
// in the trajectory DB (src/graph.ts); a path argument opens its own handle on
// that DB, which close() releases. ensureGraph/openError let a bare graph
// stand in where scanTools expects a GraphHolder.
import { TrajectoryDB } from './db.js';
import { WorldModelGraph as SqliteWorldModelGraph } from './graph.js';

export { GraphHolder } from './graph.js';
export type { DirectoryNode, FileNode, FileCoverage, Scored } from './graph.js';

export function resolveGraphDbPath(dbPath: string): string {
  return dbPath;
}

export class WorldModelGraph extends SqliteWorldModelGraph {
  readonly openError: string | null = null;
  private readonly owned: TrajectoryDB | null;

  constructor(db: TrajectoryDB | string) {
    const owned = typeof db === 'string' ? new TrajectoryDB(db) : null;
    super(owned ?? (db as TrajectoryDB));
    this.owned = owned;
  }

  ensureGraph(): WorldModelGraph {
    return this;
  }

  override close(): void {
    if (this.owned?.isOpen) this.owned.close();
  }
}
