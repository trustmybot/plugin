import assert from 'node:assert/strict';
import { tableDdl } from './v29-shape.js';
import { assertV31Shape } from './v31-shape.js';
/** Every v32 DDL item (plus all of v29–v31), asserted identically on fresh and migrated DBs. */
export function assertV32Shape(db) {
    const meta = db.get('SELECT schema_version FROM plugin_meta LIMIT 1');
    assert.equal(meta.schema_version, 32, 'schema_version must be 32');
    assertV31Shape(db);
    const ddl = tableDdl(db, 'cheatcodes').replace(/\s+/g, ' ');
    assert.match(ddl, /UNIQUE \(name, kind\)/, 'cheatcodes must be keyed by UNIQUE (name, kind)');
    assert.doesNotMatch(ddl, /name TEXT NOT NULL UNIQUE/, 'cheatcodes.name must not be UNIQUE on its own');
    const uniqueKeys = db
        .all('PRAGMA index_list(cheatcodes)')
        .filter((i) => i.unique === 1)
        .map((i) => db.all(`PRAGMA index_info(${i.name})`).map((c) => c.name).join(','));
    assert.deepEqual(uniqueKeys, ['name,kind'], 'the only unique key on cheatcodes is (name, kind)');
}
//# sourceMappingURL=v32-shape.js.map