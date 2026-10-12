import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'scripts', 'maintenance');
const erd = await import(pathToFileURL(join(scripts, 'gen-erd-doc.mjs')).href);
const configKeys = await import(pathToFileURL(join(scripts, 'gen-config-keys-doc.mjs')).href);
const SCHEMA_SQL = `PRAGMA foreign_keys = ON;
-- owners hold notes; this comment carries a ; and a 'quote
CREATE TABLE IF NOT EXISTS owners (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT    NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS notes (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id  INTEGER NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
    kind      TEXT    NOT NULL DEFAULT 'memo' CHECK (kind IN ('memo','todo')),
    body      TEXT    NOT NULL,
    parent_id INTEGER REFERENCES notes(id),
    CHECK (length(body) > 0)
);
CREATE INDEX IF NOT EXISTS idx_notes_owner ON notes(owner_id) WHERE parent_id IS NULL;
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  body,
  content='notes',
  content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, body) VALUES (new.id, new.body);
END;
`;
const EVAL_SQL = `CREATE TABLE IF NOT EXISTS runs (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_label ON runs(label);
`;
const EXPECTED = [
    "_Generated from `mcp/trajectory-server/src/schema.sql` by `scripts/maintenance/gen-erd-doc.mjs` at `schema_version = 7`; edit the schema, then rerun the script._",
    "",
    "## Diagram",
    "",
    "```mermaid",
    "erDiagram",
    "    owners ||--o{ notes : \"owner_id (RESTRICT)\"",
    "    notes |o--o{ notes : \"parent_id (NO ACTION)\"",
    "",
    "    owners {",
    "        INTEGER id PK \"NOT NULL\"",
    "        TEXT name UK \"NOT NULL\"",
    "    }",
    "",
    "    notes {",
    "        INTEGER id PK \"NOT NULL\"",
    "        INTEGER owner_id FK \"NOT NULL; → owners.id RESTRICT\"",
    "        TEXT kind \"NOT NULL; CHECK memo|todo\"",
    "        TEXT body \"NOT NULL\"",
    "        INTEGER parent_id FK \"→ notes.id NO ACTION\"",
    "    }",
    "```",
    "",
    "## Tables",
    "",
    "### `owners`",
    "",
    "| Column | Type | Null | Default | Constraints |",
    "|---|---|---|---|---|",
    "| `id` | INTEGER | NOT NULL |  | PK AUTOINCREMENT |",
    "| `name` | TEXT | NOT NULL |  | UNIQUE |",
    "",
    "### `notes`",
    "",
    "| Column | Type | Null | Default | Constraints |",
    "|---|---|---|---|---|",
    "| `id` | INTEGER | NOT NULL |  | PK AUTOINCREMENT |",
    "| `owner_id` | INTEGER | NOT NULL |  | FK → `owners.id` ON DELETE RESTRICT |",
    "| `kind` | TEXT | NOT NULL | `'memo'` | CHECK `kind IN ('memo','todo')` |",
    "| `body` | TEXT | NOT NULL |  |  |",
    "| `parent_id` | INTEGER | nullable |  | FK → `notes.id` ON DELETE NO ACTION |",
    "",
    "Table constraints:",
    "",
    "- CHECK `length(body) > 0`",
    "",
    "## Foreign keys",
    "",
    "SQLite enforces every one (`PRAGMA foreign_keys = ON`); `NO ACTION` is SQLite's default when the schema names no action, and like `RESTRICT` it refuses to delete a parent that still has children.",
    "",
    "| From | Column(s) | → To | ON DELETE |",
    "|---|---|---|---|",
    "| `notes` | `owner_id` | `owners(id)` | RESTRICT |",
    "| `notes` | `parent_id` | `notes(id)` | NO ACTION |",
    "",
    "## Search indexes",
    "",
    "FTS5 virtual tables over a content table. SQLite creates and maintains each one's shadow tables; the triggers keep the index in step with its content table.",
    "",
    "| FTS table | Content table | Indexed columns | Tokenizer | Shadow tables | Sync triggers |",
    "|---|---|---|---|---|---|",
    "| `notes_fts` | `notes.id` | `body` | `porter unicode61` | `notes_fts_config`, `notes_fts_data`, `notes_fts_docsize`, `notes_fts_idx` | `notes_ai` (AFTER INSERT) |",
    "",
    "## Indexes",
    "",
    "| Index | Table | Columns | Unique | Where |",
    "|---|---|---|---|---|",
    "| `idx_notes_owner` | `notes` | `owner_id` |  | `parent_id IS NULL` |",
    "| _UNIQUE constraint_ | `owners` | `name` | yes | |",
    "",
    "## Eval mode",
    "",
    "Applied from `mcp/trajectory-server/src/schema-eval.sql` only when `TMB_EVAL_MODE=1`; production DBs do not carry these tables.",
    "",
    "#### `runs`",
    "",
    "| Column | Type | Null | Default | Constraints |",
    "|---|---|---|---|---|",
    "| `id` | INTEGER | NOT NULL |  | PK AUTOINCREMENT |",
    "| `label` | TEXT | nullable |  |  |",
    "",
    "#### Eval-mode indexes",
    "",
    "| Index | Table | Columns | Unique | Where |",
    "|---|---|---|---|---|",
    "| `idx_runs_label` | `runs` | `label` |  |  |",
].join('\n');
describe('gen-erd-doc', () => {
    it('renders a fixture schema: columns, FK, CHECK, index, FTS shadows as search indexes, eval tables', () => {
        assert.equal(erd.renderGenerated({ schemaSql: SCHEMA_SQL, evalSql: EVAL_SQL, version: 7 }), EXPECTED);
    });
    it('classifies an FTS5 table as a search index, never a table', () => {
        const schema = erd.parseSchema(SCHEMA_SQL);
        assert.deepEqual(schema.tables.map((t) => t.name), ['owners', 'notes']);
        assert.deepEqual(schema.fts.map((f) => f.name), ['notes_fts']);
    });
    it('renderDoc rewrites between the markers and keeps the version token above them current', () => {
        const doc = `# ERD\n\nSchema at \`schema_version = 1\`.\n\n${erd.BEGIN}\nstale\n${erd.END}\n\n## Notes\n`;
        const out = erd.renderDoc(doc, { schemaSql: SCHEMA_SQL, evalSql: EVAL_SQL, version: 7 });
        assert.ok(out.startsWith('# ERD\n\nSchema at `schema_version = 7`.\n\n'));
        assert.ok(out.includes(`${erd.BEGIN}\n${EXPECTED}\n${erd.END}\n\n## Notes\n`));
        assert.throws(() => erd.renderDoc('# no markers\n', { schemaSql: SCHEMA_SQL, evalSql: EVAL_SQL, version: 7 }), /markers missing/);
    });
    it('reads TARGET_SCHEMA_VERSION from db.ts source', () => {
        assert.equal(erd.readTargetSchemaVersion('export const TARGET_SCHEMA_VERSION = 41;'), 41);
    });
});
describe('gen-config-keys-doc', () => {
    it('reads seeded defaults from the plugin_config seed', () => {
        const seeds = configKeys.seededDefaults(`INSERT OR IGNORE INTO plugin_config (key, value_json) VALUES
    ('a_key', '"off"'),
    -- a comment
    ('b_key', '{}');`);
        assert.deepEqual([...seeds], [['a_key', '"off"'], ['b_key', '{}']]);
    });
    it('flags a key used in code without an entry, and an entry no code uses', () => {
        const found = new Map([['used_key', ['src/x.ts']]]);
        const errors = configKeys.keySetErrors(found, [{ name: 'listed_key' }]);
        assert.equal(errors.length, 2);
        assert.match(errors[0], /'used_key' is used in src\/x\.ts but has no KEYS entry/);
        assert.match(errors[1], /'listed_key' has a KEYS entry but no code reads or writes it/);
    });
    it('every plugin_config key the code uses has a KEYS entry', () => {
        const repo = join(scripts, '..', '..');
        assert.deepEqual(configKeys.keySetErrors(configKeys.discoverKeys(repo)), []);
    });
});
//# sourceMappingURL=gen-erd-doc.test.js.map