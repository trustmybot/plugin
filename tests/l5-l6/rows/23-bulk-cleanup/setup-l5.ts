// Scatter .DS_Store files at three depths + seed keep-list files.
import { gitCommit, setupArgs, writeFile } from '../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);
for (const path of ['.DS_Store', 'src/.DS_Store', 'src/components/.DS_Store']) writeFile(project, path, '');
writeFile(project, 'src/index.js', "console.log('hello');\n");
writeFile(project, 'src/components/App.js', 'export default {};\n');
gitCommit(project, ['.'], 'seed: add .DS_Store + keep-list', { tolerateFailure: true });
