// Seed src/foo.ts with a typo so bro has a real source file to route through SWE.
import { gitCommit, setupArgs, writeFile } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);
writeFile(project, 'src/foo.ts', 'export const note = "recieve";\n');
gitCommit(project, ['.'], 'seed src/foo.ts with typo', { tolerateFailure: true });
