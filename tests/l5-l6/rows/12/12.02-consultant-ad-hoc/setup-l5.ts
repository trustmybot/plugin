// 12.02-consultant-ad-hoc L5 isolation: installs the row's architect.md as a
// project-local consultant so bro can spawn it directly via Agent.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupArgs, writeFile } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);
writeFile(project, '.claude/agents/architect.md', readFileSync(join(import.meta.dirname, 'architect.md')));
