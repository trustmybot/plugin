// Compatibility entry point for the maintenance scripts that still import
// dist/graph-db.js (run-scan.mjs, run-scan-initial.mjs). The world model lives
// in the trajectory DB (src/graph.ts); a path argument opens its own handle on
// that DB, which close() releases. ensureGraph/openError let a bare graph
// stand in where scanTools expects a GraphHolder.
import { TrajectoryDB } from './db.js';
import { WorldModelGraph as SqliteWorldModelGraph } from './graph.js';
export { GraphHolder } from './graph.js';
export function resolveGraphDbPath(dbPath) {
    return dbPath;
}
export class WorldModelGraph extends SqliteWorldModelGraph {
    openError = null;
    owned;
    constructor(db) {
        const owned = typeof db === 'string' ? new TrajectoryDB(db) : null;
        super(owned ?? db);
        this.owned = owned;
    }
    ensureGraph() {
        return this;
    }
    close() {
        if (this.owned?.isOpen)
            this.owned.close();
    }
}
//# sourceMappingURL=graph-db.js.map