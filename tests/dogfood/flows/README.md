# L5 Dogfood Flows

> Legacy L5 flow bundles. The current per-row L5 layout lives under [`../l5-rows/`](../l5-rows/). These remain for historical reference; new scenarios should be authored under `l5-rows/`.

Each subdirectory is an L5 flow. A flow runs a real `claude` invocation against a scratch project and grades the result with multiple scorers.

## Flow structure

| File | Purpose |
|---|---|
| `run.sh` | Entry point — sets up scratch project, runs claude, calls `l5_score_flow` |
| `prompt.txt` | The prompt sent to claude |
| `outcome.sql` | SQL assertions on the trajectory DB post-run (primary scorer) |
| `tools-required.json` | JSON array of tool names that must appear in the trajectory |
| `tools-forbidden.json` | JSON array of tool names that must NOT appear |
| `cost-budget.json` | Token + latency soft/hard caps |
| `outcome-files.json` | Filesystem assertions (opt-in — see below) |

## outcome-files.json convention

Flows can assert that specific files exist (or do not exist) on the scratch project after the flow runs. Create `outcome-files.json` in the flow directory with the schema:

```json
{
  "files": [
    {
      "path": "relative/path/from/project-root",
      "must_exist": true,
      "min_bytes": 100
    },
    {
      "path": "file/that/should/not/appear",
      "must_not_exist": true
    }
  ]
}
```

### Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `path` | string | required | Path relative to the scratch project root |
| `must_exist` | boolean | `false` | Assert the file exists |
| `must_not_exist` | boolean | `false` | Assert the file does not exist |
| `min_bytes` | number | `0` | When `must_exist` is true, also assert file size >= this value |

Flows without `outcome-files.json` are unaffected — the scorer skips silently.

### Example

`04-agent-creator/outcome-files.json` asserts that `tmb_agent-creator` wrote the architect agent file to the scratch project:

```json
{
  "files": [
    {
      "path": ".claude/agents/architect.md",
      "must_exist": true,
      "min_bytes": 100
    }
  ]
}
```
