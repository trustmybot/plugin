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
  const swe = Bun.TOML.parse(CODEX_AGENT_CATALOG[0].expectedBytes.toString());
  assert.match(swe.description, /without TMB workflow or Git delivery operations/);
  assert.match(swe.developer_instructions, /name is a role label, not authenticated TMB workflow identity/);
  assert.match(swe.developer_instructions, /create or switch a branch or worktree/);
  assert.match(swe.developer_instructions, /no commit, push, or TMB workflow write occurred/);
  assert.equal(Bun.TOML.parse(CODEX_AGENT_CATALOG[1].expectedBytes.toString()).sandbox_mode, "read-only");
  const reviewer = Bun.TOML.parse(CODEX_AGENT_CATALOG[1].expectedBytes.toString());
  assert.match(reviewer.description, /advisory reviewer without editing code or creating trusted TMB validation/);
  assert.match(reviewer.developer_instructions, /name is a role label, not authenticated TMB workflow identity/);
  for (const persona of [swe, reviewer]) {
    assert.match(
      persona.developer_instructions,
      /TMB workflow records, Git delivery, pull requests, and remote issues are outside this role/,
    );
  }
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

require_doc_contract() {
  local file="$1"
  local expected="$2"
  local contract="$3"
  if ! grep -Fq -- "$expected" "$file"; then
    echo "missing Scope-4 documentation contract: $contract ($file)" >&2
    exit 1
  fi
}

require_doc_contract docs/adapters/codex/PARITY.md 'reviewer never returns `PASS`' 'Reviewer cannot return PASS'
require_doc_contract docs/adapters/codex/PARITY.md 'Reviewer read-only and independence | Tier 3' 'Reviewer remains Tier 3'
require_doc_contract docs/adapters/codex/PARITY.md 'Static same-name MCP shadow' 'same-name MCP shadow disclosure'
if grep -q '`codex --version`' adapters/codex/skills/tmb-agent-setup/SKILL.md; then
  echo "setup must not carry a host-version gate" >&2
  exit 1
fi
if grep -q 'runtime_initialize' adapters/codex/skills/tmb-agent-setup/SKILL.md; then
  echo "setup inspection and removal must not depend on the planning database" >&2
  exit 1
fi
require_doc_contract docs/adapters/codex/PARITY.md 'BLOCKED_TMB_MCP_ISOLATION' 'child isolation failure verdict'
require_doc_contract docs/adapters/codex/PARITY.md 'does not reproduce the custom-Agent same-name shadow' '#35289 is not the same reproduction'
require_doc_contract docs/adapters/codex/PARITY.md 'remains an empirically tested compatibility behavior rather than a documented Codex guarantee' 'MCP shadow remains empirical'
require_doc_contract docs/adapters/codex/SCOPE_4_PRD.md '但不是同一个复现' 'PRD distinguishes #35289 from the Agent shadow'
require_doc_contract docs/contributing/CODEX_PORT.md 'Scope 4 host-version compatibility gate' 'host-version gate exists'
require_doc_contract docs/contributing/CODEX_PORT.md 'fail the gate if any TMB `trajectory-server` tool is visible' 'both child tool surfaces must hide TMB MCP'
require_doc_contract docs/contributing/CODEX_PORT.md 'start another fresh task, and confirm that both' 'removal requires a fresh task'
require_doc_contract docs/contributing/CODEX_PORT.md 'third-party Agent remains unchanged' 'removal preserves third-party Agents'
require_doc_contract docs/contributing/CODEX_PORT.md 'exact plugin was already installed' 'Desktop captures pre-test plugin state'
require_doc_contract docs/contributing/CODEX_PORT.md 'including its source and content hash' 'Desktop captures the installed plugin identity'
require_doc_contract docs/contributing/CODEX_PORT.md 'before/after sentinels and preserve every plugin and profile entry that' 'Desktop cleanup preserves pre-existing profile state'
require_doc_contract docs/contributing/CODEX_PORT.md 'install the plugin from the exact candidate commit' 'compatibility check uses the candidate build'
require_doc_contract docs/contributing/CODEX_PORT.md 'reuse it without replacing it' 'matching Desktop candidate is preserved'
require_doc_contract docs/contributing/CODEX_PORT.md 'stop without changing' 'different Desktop plugin builds fail closed'
require_doc_contract docs/contributing/CODEX_PORT.md 'fresh parent task or CLI session' 'parent positive control cannot use a stale plugin instance'
require_doc_contract docs/contributing/CODEX_PORT.md 'record the response as the positive' 'parent TMB MCP call is a positive control'
require_doc_contract docs/contributing/CODEX_PORT.md 'template hashes match the candidate commit' 'parent positive control verifies the candidate template set'
require_doc_contract docs/contributing/CODEX_PORT.md 'Materialize both Agents and' 'compatibility check materializes both Agents'
require_doc_contract docs/contributing/CODEX_PORT.md 'fresh child-discovery task' 'initial Agent discovery uses a fresh task'
require_doc_contract docs/contributing/CODEX_PORT.md 'Ask each child to attempt the read-only `agent_materialization_get` operation' 'child isolation includes a negative MCP call'
require_doc_contract docs/contributing/CODEX_PORT.md 'zero successful TMB MCP' 'child isolation records no successful TMB MCP events'
require_doc_contract docs/contributing/CODEX_PORT.md 'unchanged `.tmb` before/after sentinels' 'child isolation preserves TMB state'
require_doc_contract docs/contributing/CODEX_PORT.md 'If this check installed the plugin into an existing Desktop profile' 'Desktop cleanup is conditional on test installation'
require_doc_contract docs/contributing/CODEX_PORT.md 'that exact plugin through the normal plugin-removal flow' 'Desktop cleanup removes only the test-installed plugin'
require_doc_contract docs/contributing/CODEX_PORT.md 'A pass proves only the tested child MCP isolation' 'MCP check is not full host acceptance'
require_doc_contract docs/contributing/CODEX_PORT.md 'Record the candidate SHA, Codex client and build version' 'compatibility evidence records the tested build'
require_doc_contract docs/adapters/ADAPTER_CONTRACT.md 'Host-local standalone personas may exist only' 'standalone persona exception is narrow'
require_doc_contract docs/adapters/ADAPTER_CONTRACT.md 'Protected personas include workflow principals and shared consultant templates' 'protected persona definition includes consultants'
require_doc_contract docs/adapters/ADAPTER_CONTRACT.md 'no TMB task, validation, audit, or delivery-write tool' 'standalone status requires an authority-free tool surface'
require_doc_contract docs/adapters/ADAPTER_CONTRACT.md 'no server or hook consumes its output as workflow or delivery-gate evidence' 'standalone output cannot satisfy a gate'
require_doc_contract docs/adapters/ADAPTER_CONTRACT.md 'MUST NOT create or switch branches or worktrees, commit, push, open or merge pull requests' 'standalone personas cannot perform Git or remote delivery'
require_doc_contract docs/adapters/ADAPTER_CONTRACT.md 'strongest restriction the host can enforce' 'standalone delivery limits prefer host enforcement'
require_doc_contract docs/adapters/ADAPTER_CONTRACT.md 'A prompt prohibition is not a hard boundary' 'prompt-only delivery limits remain a declared degradation'
require_doc_contract docs/adapters/ADAPTER_CONTRACT.md 'where users discover and select it' 'role-name ambiguity is disclosed before Agent selection'
require_doc_contract docs/adapters/ADAPTER_CONTRACT.md 'naming at least one corresponding TMB workflow, validation, or delivery authority that the persona lacks' 'visible disclaimer names a missing protected authority'
require_doc_contract docs/adapters/ADAPTER_CONTRACT.md 'do not satisfy it by themselves' 'advisory or standalone labels alone are insufficient'
require_doc_contract docs/adapters/ADAPTER_CONTRACT.md 'Developer instructions alone do not satisfy this requirement' 'internal instructions do not satisfy the visible disclaimer'
require_doc_contract docs/adapters/ADAPTER_CONTRACT.md 'MUST NOT copy a shared persona body or claim workflow authority' 'standalone personas cannot copy or claim workflow authority'
require_doc_contract docs/adapters/ADAPTER_CONTRACT.md 'MUST replace the standalone body with a shared host-neutral source or a mechanical edge translation' 'workflow authority requires a shared source'
require_doc_contract docs/adapters/codex/PARITY.md 'A later scope must move Codex to a shared' 'Codex future workflow authority requires convergence'
require_doc_contract docs/reference/MULTI_PLATFORM.md 'Host-local standalone surfaces are narrow, declared exceptions' 'multi-platform strategy matches the adapter exception'

echo "Codex Scope-4 contract: PASS"
