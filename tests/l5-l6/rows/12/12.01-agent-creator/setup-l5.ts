// Copy fixture app.py into the scratch project and commit it so the architect
// prompt has real SQLite + threading code to evaluate.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitCommit, setupArgs, writeFile } from '../../../lib/setup-helpers.ts';

const { project, rowDir } = setupArgs(import.meta.dirname);
writeFile(project, 'app.py', readFileSync(join(rowDir, 'fixture', 'app.py')));
gitCommit(project, ['app.py'], 'seed app.py for architect review');
