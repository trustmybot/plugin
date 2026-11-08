// Cheatcode-install-plugins L5 isolation: seed deterministic fixtures for the
// whole search → vet → approve → install SOP so no live web / real marketplace
// call is ever made. All three fixtures live in the project dir at the default
// file-convention paths (cheatcode-search.sh / cheatcode-vet.sh probe these when
// their env var is unset), so the chain reaches them regardless of subshell env
// propagation.
//
// Both candidates are plugin-kind: feature-dev (attaches to swe) and code-review
// (attaches to code-reviewer). The search fixture supplies both candidates so the
// discovery step is deterministic; the vet fixture supplies the {repo, contents}
// signal set for either candidate (its `hooks` entry is a code-execution surface →
// 'caution' tier, gating the human approval); the install fixture supplies the
// {installed, version, attachments} marketplace result that passes through
// verbatim. No network on any step.
import { setupArgs, writeFile } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);

writeFile(
  project,
  '.tmb-cheatcode-fixture.json',
  `[
  { "name": "feature-dev", "kind": "plugin", "source_url": "https://github.com/example-org/feature-dev",
    "description": "feature development plugin for swe agents implementing specs", "registry": "anthropic-official", "tier": 1 },
  { "name": "code-review", "kind": "plugin", "source_url": "https://github.com/example-org/code-review",
    "description": "optional code-review linting conveniences for code-reviewer agents", "registry": "anthropic-official", "tier": 1 }
]
`,
);

writeFile(
  project,
  '.tmb-cheatcode-vet-fixture.json',
  `{
  "repo": {
    "stargazers_count": 1200,
    "forks_count": 80,
    "pushed_at": "2026-05-01T00:00:00Z",
    "archived": false,
    "license": { "spdx_id": "MIT" },
    "owner": { "login": "example-org", "type": "Organization" }
  },
  "contents": ["README.md", "LICENSE", ".claude-plugin", "hooks"]
}
`,
);

writeFile(
  project,
  '.tmb-cheatcode-install-fixture.json',
  `{
  "installed": true,
  "version": "1.0.0",
  "error": null,
  "attachments": [
    { "target": "swe", "artifact": "marketplace-plugin:feature-dev" },
    { "target": "code-reviewer", "artifact": "marketplace-plugin:code-review" }
  ]
}
`,
);
