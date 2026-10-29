// L5/L6 compatibility entry point; all scoring policy stays in l5-scorers.ts.
import { score, scoreAll } from './l5-scorers.js';
const [name, project, flow, scorerDir, runId, ...extra] = process.argv.slice(2);
if (!name || !project || !flow || !scorerDir || !runId || extra.length) {
    process.stderr.write('usage: l5-scorers-cli.js <all|scorer> <project> <flow> <scorer-dir> <run-id>\n');
    process.exitCode = 2;
}
else {
    const context = { project, flow, scorerDir, runId,
        stdout: (text) => { process.stdout.write(text); },
        stderr: (text) => { process.stderr.write(text); } };
    try {
        process.exitCode = name === 'all' ? scoreAll(context) : score(name, context);
    }
    catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
        process.exitCode = 2;
    }
}
//# sourceMappingURL=l5-scorers-cli.js.map