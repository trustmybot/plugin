// 12.02-consultant-ad-hoc L5 isolation: copies architect.md from plugin templates
// so bro can spawn it directly via Agent.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT, setupArgs, writeFile } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);
writeFile(project, '.claude/agents/architect.md', readFileSync(join(PLUGIN_ROOT, 'templates', 'agents', 'architect.md')));
