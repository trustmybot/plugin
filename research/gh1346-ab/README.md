# GH 1346 token-reduction A/B harness

Research only: nothing here ships. Each method runs against today's behaviour as the control; results and verdicts are in [REPORT.md](REPORT.md).

| Dir | Method | Sub-issue |
|---|---|---|
| `m1m2/` | M1 TOON vs JSON, M2 concise vs detailed `response_format`, on real MCP tool outputs | GH 1957, GH 1958 |
| `m3/` | M3 code as the action language vs one tool call per step | GH 1960 |
| `m4/` | M4 condensed vs full swe / code-reviewer returns, plus the bro context simulation | GH 1959 |
| `m56/m5.ts` | M5 terse (Chain of Draft) vs normal completion reports and spawn notes | GH 1959 |
| `m56/m6.ts` | M6 typed completion report vs free text | GH 1961 |

## Data

- The live trajectory DB is opened only with `sqlite3 -readonly` to take one snapshot (`lib/snapshot.ts`); every experiment reads that frozen copy, and the MCP handlers run against a throwaway copy of it.
- M4 reads bro transcripts under `~/.claude/projects/-Users-Zax-Git-GitHub-TMB/` (read-only).
- M3 needs the built trajectory server (`mcp/trajectory-server/dist`) of this checkout.

## Run

Needs Node 22+ (`node:sqlite`, type stripping), `sqlite3`, the `claude` CLI and `CLAUDE_CODE_OAUTH_TOKEN` (from `plugin/.env`).

```bash
npm install
```

```bash
set -a && source ../../.env && set +a && export ENABLE_CLAUDEAI_MCP_SERVERS=false
```

```bash
node --experimental-sqlite m1m2/dump.ts && node --experimental-sqlite m1m2/run.ts
```

```bash
node --experimental-sqlite m3/run.ts
```

```bash
node --experimental-sqlite m4/extract.ts && node m4/run.ts
```

```bash
node --experimental-sqlite m56/m5.ts && node --experimental-sqlite m56/m6.ts
```

`m6.ts` reads `results/m4/cells.json` when it exists, so run it after M4.

Every `claude -p` call is cached under `results/cache/` by tag and input hash, so a rerun only pays for new or changed calls. Settings come from env: `GH1346_READER_MODEL` / `GH1346_READER_EFFORT` (default opus / low), `GH1346_AGENT_MODEL` / `GH1346_AGENT_EFFORT` for M3 (opus / medium), `GH1346_CONCURRENCY`, `GH1346_LIMIT` (sample N items for a smoke run), `GH1346_ONLY` (M3 question ids).

Payload tokens are measured by baseline subtraction: a reader run's total input minus the total input of the same run on empty text. Only each method's `summary.md` is committed; raw cells, tool outputs and transcript extracts stay local.
