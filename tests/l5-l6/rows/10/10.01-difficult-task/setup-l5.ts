// Seed todo.py so bro has existing code to analyse before designing the sync API.
// Mirrors the narrative that a prior simple-task run shipped the CLI.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitCommit, setupArgs, writeFile } from '../../../lib/setup-helpers.ts';

const { project, rowDir } = setupArgs(import.meta.dirname);
writeFile(project, 'todo.py', readFileSync(join(rowDir, 'fixture', 'todo.py')));
gitCommit(project, ['todo.py'], 'feat: initial todo CLI');
