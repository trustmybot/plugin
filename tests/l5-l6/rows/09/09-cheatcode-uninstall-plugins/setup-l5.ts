// Cheatcode-uninstall-plugins L5 isolation: pre-seed the INSTALLED state for two
// plugins (feature-dev → swe, code-review → code-reviewer) directly into the
// trajectory DB so the uninstall has something concrete to reverse, then write a
// deterministic teardown fixture at the project-root file cheatcode_uninstall
// reads by default, so no live web / real marketplace call is ever made.
//
// The seed mirrors exactly what a prior cheatcode_install would have written: a
// cheatcodes row (kind='plugin', scope='project-local', status='installed') + its
// per-agent attachment row, plus the cheatcode_install / cheatcode_installed
// audit rows that carry each cheatcode_id (so bro can discover the ids to tear
// down). cheatcode_uninstall then deletes the cheatcodes + cheatcode_attachments
// rows in one transaction and emits a cheatcode_uninstalled audit row.
import { query, setupArgs, withDb, writeFile } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);
const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

interface Plugin {
  id: number;
  name: string;
  target: string;
}

const PLUGINS: Plugin[] = [
  { id: 101, name: 'feature-dev', target: 'swe' },
  { id: 102, name: 'code-review', target: 'code-reviewer' },
];

// In the L6 chain, row 44 already installed feature-dev/code-review. Re-seeding
// here would fail the cheatcodes UNIQUE(name) insert while the separate
// attachments insert succeeds (FK off), leaving orphan attachment rows. Only
// seed the installed state when it is not already present.
const existing = query(project, "SELECT COUNT(*) AS n FROM cheatcodes WHERE name IN ('feature-dev','code-review')")[0].n;

if (existing === 0) {
  const sourceUrl = (p: Plugin) => `https://example.test/${p.name}`;
  const artifact = (p: Plugin) => `marketplace-plugin:${p.name}`;
  const tuples = (n: number, tuple: string) => Array.from({ length: n }, () => tuple).join(',\n  ');
  withDb(project, (db) => {
    db.prepare(
      `INSERT INTO cheatcodes (id, name, kind, source_url, version, trust_tier, scope, status, installed_at)
VALUES
  ${tuples(PLUGINS.length, "(?, ?, 'plugin', ?, '1.0.0', 'trusted', 'project-local', 'installed', ?)")}`,
    ).run(...PLUGINS.flatMap((p) => [p.id, p.name, sourceUrl(p), now]));

    db.prepare(
      `INSERT INTO cheatcode_attachments (cheatcode_id, target, artifact, created_at)
VALUES
  ${tuples(PLUGINS.length, '(?, ?, ?, ?)')}`,
    ).run(...PLUGINS.flatMap((p) => [p.id, p.target, artifact(p), now]));

    db.prepare(
      `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
VALUES
  ${tuples(PLUGINS.length * 2, "(-1, NULL, 'bro', ?, ?, ?, ?)")}`,
    ).run(
      ...PLUGINS.flatMap((p) => [
        'cheatcode_install',
        `Cheatcode install: '${p.name}' (kind=plugin, method=marketplace)`,
        JSON.stringify({ name: p.name, kind: 'plugin', source_url: sourceUrl(p), method: 'marketplace' }),
        now,
        'cheatcode_installed',
        `Cheatcode installed: '${p.name}' → cheatcode_id=${p.id}`,
        JSON.stringify({
          cheatcode_id: p.id,
          name: p.name,
          kind: 'plugin',
          source_url: sourceUrl(p),
          installed: true,
          attachments: [{ target: p.target, artifact: artifact(p) }],
        }),
        now,
      ]),
    );
  });
}

writeFile(project, '.tmb-cheatcode-uninstall-fixture.json', '{ "removed": true, "error": null }\n');
