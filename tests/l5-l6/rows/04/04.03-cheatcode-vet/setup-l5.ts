// Cheatcode-vet L5 isolation: seed a deterministic signal fixture at the
// project-root file cheatcode_vet reads by default, so no live web is ever
// touched. The fixture is the {repo, contents} object that stands in for the
// best-effort GitHub responses. Without it the row still passes (cheatcode_vet
// records its audit row with an empty signal set, trust_tier 'unknown'), so the
// fixture only enriches the signals; it never gates the assertion.
import { setupArgs, writeFile } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);
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
  "contents": ["README.md", "LICENSE", "SKILL.md"]
}
`,
);
