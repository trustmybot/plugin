#!/usr/bin/env bash
# Resource-discovery L5 isolation: seed a deterministic candidate fixture and
# point resource_search at it via TMB_RESOURCE_SEARCH_FIXTURE so no live web is
# ever touched. The fixture lives in the project dir; the env export covers
# runners that source this setup. Even without the env var the row still passes
# (resource_search records its audit row with an empty candidate set), so the
# fixture only enriches the ranked output — it never gates the assertion.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

FIXTURE="$PROJECT/.tmb-resource-fixture.json"
cat > "$FIXTURE" <<'JSON'
[
  { "name": "pdf-table-extractor", "kind": "skill", "source_url": "https://example.test/pdf-table-extractor",
    "description": "extract structured tables from pdf reports and documents", "stars": 4200, "downloads": 9000 },
  { "name": "doc-pdf-reader", "kind": "skill", "source_url": "https://example.test/doc-pdf-reader",
    "description": "read text out of pdf files", "stars": 80, "downloads": 120 },
  { "name": "spreadsheet-mcp", "kind": "mcp", "source_url": "https://example.test/spreadsheet-mcp",
    "description": "operate on spreadsheets and csv data", "stars": 15, "downloads": 30 }
]
JSON

export TMB_RESOURCE_SEARCH_FIXTURE="$FIXTURE"
