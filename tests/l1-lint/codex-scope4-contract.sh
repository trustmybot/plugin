#!/usr/bin/env bash
# Lint: freeze the Scope-4 Codex Agent catalog and public adapter surfaces.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if git ls-files | grep -qE '(^|/)\.codex/agents/'; then
  echo "tracked .codex/agents files would bypass explicit materialization" >&2
  exit 1
fi

bun -e '
  import assert from "node:assert/strict";
  import {
    CODEX_AGENT_CATALOG,
    CODEX_AGENT_TEMPLATE_SET_VERSION,
    sha256,
  } from "./mcp/trajectory-server/src/codex-agent-catalog.ts";

  assert.equal(CODEX_AGENT_TEMPLATE_SET_VERSION, 1);
  assert.deepEqual(
    CODEX_AGENT_CATALOG.map((entry) => entry.agentId),
    ["tmb_swe", "tmb_pr_reviewer"],
  );
  assert.deepEqual(
    CODEX_AGENT_CATALOG.map((entry) => entry.targetPath),
    [
      ".codex/agents/tmb_swe.toml",
      ".codex/agents/tmb_pr_reviewer.toml",
    ],
  );
  for (const entry of CODEX_AGENT_CATALOG) {
    const text = entry.expectedBytes.toString("utf8");
    const parsed = Bun.TOML.parse(text);
    assert.equal(entry.templateVersion, 1);
    assert.equal(entry.bodySha256, sha256(entry.body));
    assert.equal(entry.expectedContentSha256, sha256(entry.expectedBytes));
    assert.match(text, /^# Managed by TrustMyBot Codex Scope 4\./);
    assert.match(text, new RegExp(`^# tmb-template-id: ${entry.agentId}$`, "m"));
    assert.match(text, new RegExp(`^# tmb-body-sha256: ${entry.bodySha256}$`, "m"));
    assert.equal(parsed.name, entry.agentId);
    assert.equal(typeof parsed.description, "string");
    assert.equal(typeof parsed.developer_instructions, "string");
    assert.equal(parsed.model, undefined);
    assert.equal(parsed.model_reasoning_effort, undefined);
    assert.equal(parsed.plugins, undefined);
    assert.deepEqual(parsed.mcp_servers["trajectory-server"], {
      command: "node",
      args: ["--version"],
      enabled: false,
    });
    assert.match(parsed.developer_instructions, /Before reading the repository or running a command/);
    assert.match(parsed.developer_instructions, /mcp__trajectory_server__/);
    assert.match(parsed.developer_instructions, /BLOCKED_TMB_MCP_ISOLATION/);
  }

  assert.equal(Bun.TOML.parse(CODEX_AGENT_CATALOG[0].expectedBytes.toString()).sandbox_mode, "workspace-write");
  assert.match(
    Bun.TOML.parse(CODEX_AGENT_CATALOG[0].expectedBytes.toString()).developer_instructions,
    /If any required test fails or cannot run, use status BLOCKED and never COMPLETED/,
  );
  assert.equal(Bun.TOML.parse(CODEX_AGENT_CATALOG[1].expectedBytes.toString()).sandbox_mode, "read-only");
'

node --experimental-sqlite --input-type=module -e '
  import assert from "node:assert/strict";
  import {
    CODEX_SCOPE_3_TOOL_NAMES,
    CODEX_SCOPE_4_TOOL_NAMES,
  } from "./mcp/trajectory-server/dist/codex-tools.js";

  assert.equal(CODEX_SCOPE_3_TOOL_NAMES.length, 13);
  assert.equal(CODEX_SCOPE_4_TOOL_NAMES.length, 15);
  assert.deepEqual(CODEX_SCOPE_4_TOOL_NAMES.slice(0, 13), CODEX_SCOPE_3_TOOL_NAMES);
  assert.deepEqual(CODEX_SCOPE_4_TOOL_NAMES.slice(13), [
    "agent_materialization_get",
    "agent_materialization_set",
  ]);
'

grep -q 'reviewer never returns `PASS`' docs/adapters/codex/PARITY.md
grep -q 'Reviewer read-only and independence | Tier 3' docs/adapters/codex/PARITY.md
grep -q 'Static same-name MCP shadow' docs/adapters/codex/PARITY.md
if grep -q '`codex --version`' adapters/codex/skills/tmb-agent-setup/SKILL.md; then
  echo "setup must not carry a host-version gate" >&2
  exit 1
fi
grep -q 'BLOCKED_TMB_MCP_ISOLATION' docs/adapters/codex/PARITY.md

echo "Codex Scope-4 contract: PASS"
