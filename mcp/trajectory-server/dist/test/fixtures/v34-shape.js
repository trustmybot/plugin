import assert from 'node:assert/strict';
import { tableDdl } from './v29-shape.js';
import { assertV33Shape } from './v33-shape.js';
/** Every v34 DDL item (plus all of v29–v33), asserted identically on fresh and migrated DBs. */
export function assertV34Shape(db) {
    const meta = db.get('SELECT schema_version FROM plugin_meta LIMIT 1');
    assert.equal(meta.schema_version, 34, 'schema_version must be 34');
    assertV33Shape(db);
    const cols = db.all('PRAGMA table_info(agents)').map((c) => c.name);
    assert.deepEqual(cols, ['id', 'name', 'kind', 'file_path', 'created_at', 'updated_at'], 'agents has no scope column at v34');
    const ddl = tableDdl(db, 'agents').replace(/\s+/g, ' ');
    assert.match(ddl, /file_path TEXT NOT NULL CHECK \(file_path LIKE 'plugin:%' OR file_path LIKE 'project:%'\)/, 'agents.file_path carries the root-marker CHECK');
    const unmarked = db.get("SELECT COUNT(*) AS n FROM agents WHERE file_path NOT LIKE 'plugin:%' AND file_path NOT LIKE 'project:%'");
    assert.equal(unmarked.n, 0, 'every agents.file_path carries a root marker');
}
//# sourceMappingURL=v34-shape.js.map