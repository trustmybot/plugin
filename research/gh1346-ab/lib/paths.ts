import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HARNESS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(HARNESS_DIR, '..', '..');
export const RESULTS_DIR = process.env['GH1346_RESULTS'] ?? join(HARNESS_DIR, 'results');
export const WORK_DIR = process.env['GH1346_WORK'] ?? join(process.env['TMPDIR'] ?? '/tmp', 'gh1346-ab');
export const LIVE_DB = process.env['GH1346_LIVE_DB'] ?? '/Users/Zax/Git/GitHub/TMB/.claude/tmb/trajectory.db';
export const SERVER_DIST = process.env['TMB_SERVER_DIST'] ?? join(REPO_ROOT, 'mcp', 'trajectory-server', 'dist');
export const TRANSCRIPTS_DIR =
  process.env['GH1346_TRANSCRIPTS'] ?? join(process.env['HOME'] ?? '', '.claude', 'projects', '-Users-Zax-Git-GitHub-TMB');
