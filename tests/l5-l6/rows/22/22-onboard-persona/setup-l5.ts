// L5 isolation setup for 22-onboard-persona. Seeds a Human-owned CLAUDE.md
// and snapshots it to .claude/tmb/_l5_claude_md_seed.md so outcome.sql can
// prove /tmb:onboard left the file byte-for-byte untouched (GH 1496: the
// persona loads from the plugin's hooks, never from the project CLAUDE.md).
import { git, gitCommit, setupArgs, writeFile } from '../../../lib/setup-helpers.ts';

const CLAUDE_MD = `# todo-cli

Project notes for Claude Code, written by the Human.

- Python 3.11, stdlib only; the CLI lives in src/cli.py.
- Run tests with \`python -m pytest tests/\`.
`;

const { project } = setupArgs(import.meta.dirname);
writeFile(project, 'CLAUDE.md', CLAUDE_MD);
writeFile(project, '.claude/tmb/_l5_claude_md_seed.md', CLAUDE_MD);

if (git(project, ['rev-parse', '--git-dir'], { quiet: true })) {
  gitCommit(project, ['CLAUDE.md'], 'docs: project CLAUDE.md (row 22 substrate)');
}
