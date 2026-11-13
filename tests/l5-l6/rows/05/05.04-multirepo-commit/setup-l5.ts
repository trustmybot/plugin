// 05.04-multirepo-commit L5 isolation: builds the multi-repo workspace fixture.
// Creates api/ and app/ sibling git repos and registers both via the `repos`
// table (path-keyed resolution — see docs/architecture/GIT.md, Multi-repo workspaces).
// README per inner repo lets scan_run populate the world model with
// README-derived summaries when bro runs /scan.
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitCommit, setupArgs, withDb, writeFile } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);

function seedRepo(dir: string, files: Record<string, string>, message: string): void {
  const repo = join(project, dir);
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'l5@l5.test']);
  git(repo, ['config', 'user.name', 'L5 Test']);
  for (const [path, content] of Object.entries(files)) writeFile(repo, path, content);
  gitCommit(repo, Object.keys(files), message);
}

seedRepo(
  'api',
  {
    'README.md': '# api\n\nHTTP API handlers + utilities for the auth service.\n',
    'handler.py': 'def handle(request):\n    return {"status": "ok"}\n',
    'utils.py': "def slugify(s):\n    return s.lower().replace(' ', '-')\n",
  },
  'seed: api initial',
);
seedRepo(
  'app',
  {
    'README.md': '# app\n\nTypeScript app entrypoint.\n',
    'src/index.ts': "export const hello = () => 'world';\n",
  },
  'seed: app initial',
);

// Register both inner repos by path (path-keyed resolution).
// api carries a per-repo protected_branches value to exercise the per-repo
// authoritative model; app omits it (falls back to the global config).
withDb(project, (db) => {
  db.prepare(`INSERT OR REPLACE INTO repos (name, path, protected_branches) VALUES ('api', ?, '["main"]')`).run(realpathSync(join(project, 'api')));
  db.prepare(`INSERT OR REPLACE INTO repos (name, path) VALUES ('app', ?)`).run(realpathSync(join(project, 'app')));
});
