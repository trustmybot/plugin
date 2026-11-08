// Cheatcode-discovery L5 isolation: seed a deterministic candidate fixture at
// the project-root file cheatcode_search reads by default, so no live web is
// ever touched. Without it the row still passes (cheatcode_search records its
// audit row with an empty candidate set), so the fixture only enriches the
// ranked output; it never gates the assertion.
import { setupArgs, writeFile } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);
writeFile(
  project,
  '.tmb-cheatcode-fixture.json',
  `[
  { "name": "pdf-table-extractor", "kind": "skill", "source_url": "https://example.test/pdf-table-extractor",
    "description": "extract structured tables from pdf reports and documents", "registry": "mcp-official", "tier": 1 },
  { "name": "doc-pdf-reader", "kind": "skill", "source_url": "https://example.test/doc-pdf-reader",
    "description": "read text out of pdf files", "registry": "pulsemcp", "tier": 2 },
  { "name": "spreadsheet-mcp", "kind": "mcp", "source_url": "https://example.test/spreadsheet-mcp",
    "description": "operate on spreadsheets and csv data", "registry": "pulsemcp", "tier": 2 }
]
`,
);
