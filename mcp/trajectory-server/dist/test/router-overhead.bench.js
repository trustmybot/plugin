/**
 * The router's own cost per Bash call (GH 1692 R1, SC5): routerMain over every
 * Bash payload of the 11 gates' corpora with instant gates, so what is timed is
 * the install check, the per-call dedupe lock, the decision and the hook_call
 * audit row against a real project DB, and the same for each SessionStart,
 * UserPromptSubmit and WorktreeCreate registration. Exits 1 when a p95 reaches
 * 40 ms; at a 1-minute load of 30 or more it prints `skipped: load <n>` and
 * exits 0.
 *
 *   node --experimental-sqlite dist/test/router-overhead.bench.js [--rounds 5]
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { ALLOW } from '../hooks/gate.js';
import { routerMain } from '../hooks/router/main.js';
import { percentile } from './hook-transcripts.js';
import { PLUGIN_ROOT, ROUTER_BASH_GATES } from './router-sandboxes.js';
const P95_LIMIT_MS = 40;
const LOAD_LIMIT = 30;
const NO_TOOL_CALLS_PER_ROUND = 40;
const NO_TOOL_REGISTRATIONS = [['SessionStart'], ['SessionStart', 'persona'], ['SessionStart', 'prescan'], ['UserPromptSubmit'], ['UserPromptSubmit', 'persona'], ['UserPromptSubmit', 'roundtable'], ['WorktreeCreate']];
function verdict(label, ms, load) {
    const [p50, p95, p99] = [0.5, 0.95, 0.99].map((q) => percentile(ms, q).toFixed(2));
    console.log(`router-overhead: ${ms.length} calls over ${label}, 1-min load ${load.toFixed(2)}: p50 ${p50} ms, p95 ${p95} ms, p99 ${p99} ms (limit p95 < ${P95_LIMIT_MS} ms)`);
    if (Number(p95) < P95_LIMIT_MS)
        return true;
    console.error(`router-overhead: ${label}: p95 ${p95} ms >= ${P95_LIMIT_MS} ms`);
    return false;
}
function bashPayloads() {
    const out = [];
    for (const gate of ROUTER_BASH_GATES) {
        const dir = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus', gate);
        for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
            let o;
            try {
                o = JSON.parse(readFileSync(join(dir, f), 'utf8'));
            }
            catch {
                continue;
            }
            if (o.tool_name !== 'Bash')
                continue;
            delete o.corpus_expect;
            out.push(JSON.stringify(o));
        }
    }
    return out;
}
async function main() {
    const { values } = parseArgs({ options: { rounds: { type: 'string', default: '5' } } });
    const load = loadavg()[0];
    if (load >= LOAD_LIMIT) {
        console.log(`skipped: load ${load.toFixed(2)}`);
        return 0;
    }
    const payloads = bashPayloads();
    if (payloads.length === 0)
        throw new Error('no Bash payload in the router corpora');
    const base = mkdtempSync(join(tmpdir(), 'tmb-router-overhead-'));
    const project = join(base, 'project');
    const db = join(project, '.claude/tmb/trajectory.db');
    mkdirSync(join(project, '.claude/tmb'), { recursive: true });
    const d = new DatabaseSync(db);
    d.exec(readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8'));
    d.close();
    const env = { ...process.env, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, PWD: project, TMB_TEST_RUN_ID: 'router-overhead' };
    delete env.TRAJECTORY_DB_PATH;
    const ms = [];
    const io = { readStdin: () => '', writeStdout: async () => { }, writeStderr: () => { } };
    let n = 0;
    let within = true;
    try {
        for (let round = 0; round < Math.max(1, Number(values.rounds)); round++) {
            for (const p of payloads) {
                const payload = JSON.stringify({ ...JSON.parse(p), session_id: 'overhead', tool_use_id: `overhead-${n++}` });
                const start = performance.now();
                await routerMain('PreToolUse', env, { readStdin: () => payload, writeStdout: async () => { }, writeStderr: () => { } }, { findGate: () => () => ALLOW, selfRoot: PLUGIN_ROOT });
                ms.push(performance.now() - start);
            }
        }
        within = verdict(`${payloads.length} Bash payloads`, ms, load);
        for (const [event, part] of NO_TOOL_REGISTRATIONS) {
            const taken = [];
            for (let call = 0; call < Math.max(1, Number(values.rounds)) * NO_TOOL_CALLS_PER_ROUND; call++) {
                const payload = JSON.stringify({ hook_event_name: event, session_id: `overhead-${n++}`, prompt: 'p', name: 'n', cwd: project });
                const start = performance.now();
                await routerMain(event, env, { ...io, readStdin: () => payload }, { part, findGate: () => () => ALLOW, selfRoot: PLUGIN_ROOT });
                taken.push(performance.now() - start);
            }
            within = verdict(`${event}${part === undefined ? '' : ` ${part}`}`, taken, load) && within;
        }
    }
    finally {
        rmSync(base, { recursive: true, force: true });
    }
    return within ? 0 : 1;
}
process.exitCode = await main();
//# sourceMappingURL=router-overhead.bench.js.map