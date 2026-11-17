/**
 * The base SessionStart group (GH 3232): its gates run concurrently, and the
 * ps-reading gates of one router call share a single `ps -A` snapshot.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { performance } from 'node:perf_hooks';
import { ALLOW, type Gate } from '../hooks/gate.js';
import { deferredToolsDriftWarn, GATE_NAME as DRIFT_WARN } from '../hooks/deferred-tools-drift-warn.js';
import { GATE_NAME as MCP_HEALTH, mcpHealthCheck } from '../hooks/mcp-health-check.js';
import { GATE_NAME as ORPHAN_SCAN, orphanScan } from '../hooks/orphan-scan.js';
import { routerGroup, routerGates } from '../hooks/registry.js';
import { decide } from '../hooks/router/decide.js';

const PAYLOAD = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', source: 'startup' });

let dir = '';

function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** The base group's gates, each the given real gate or else an instant allow. */
function onlyReal(real: Record<string, Gate>): (name: string) => Gate {
  return (name) => real[name] ?? (() => ALLOW);
}

describe('base SessionStart group (GH 3232)', () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'tmb-sessionstart-concurrent-'));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is concurrent', () => {
    assert.equal(routerGroup('SessionStart', '')?.concurrent, true);
  });

  it('orphan-scan and drift-warn take one ps snapshot between them', async () => {
    const bin = join(dir, 'bin-ps-log');
    mkdirSync(bin);
    const log = join(dir, 'ps.log');
    writeFileSync(log, '');
    script(join(bin, 'ps'), `printf '%s\\n' "$*" >> '${log}'\nprintf '%s\\n' '    1     0 01:00 launchd'`);
    script(join(bin, 'pgrep'), 'exit 1');
    script(join(bin, 'lsof'), 'exit 1');
    const project = join(dir, 'project-ps');
    mkdirSync(project);
    const env: NodeJS.ProcessEnv = {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: join(dir, 'home'),
      CLAUDE_PROJECT_DIR: project,
      TMB_ORPHAN_SCAN_HOME: join(dir, 'home'),
    };
    const d = await decide('SessionStart', PAYLOAD, env, {
      findGate: onlyReal({ [ORPHAN_SCAN]: orphanScan, [DRIFT_WARN]: deferredToolsDriftWarn }),
    });
    const ran = d.gates.filter((g) => g.gate === ORPHAN_SCAN || g.gate === DRIFT_WARN);
    assert.deepEqual(ran.map((g) => g.outcome), ['allow', 'allow'], d.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').split('\n').filter(Boolean), ['-A -o pid=,ppid=,etime=,command=']);
  });

  it('runs its gates side by side: wall time stays under the sum of the gates', async () => {
    const bin = join(dir, 'bin-no-server');
    mkdirSync(bin);
    script(join(bin, 'pgrep'), 'exit 1');
    const env: NodeJS.ProcessEnv = {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      CLAUDE_PROJECT_DIR: join(dir, 'no-project'),
      TMB_INSTALLED_JSON: join(dir, 'none.json'),
      TMB_MCP_HEALTH_SAMPLES: '3',
      TMB_MCP_HEALTH_INTERVAL_S: '0.3',
    };
    // Two of the group's slots run the real health check, which awaits its samples with no server up.
    const [first, second] = routerGates('SessionStart', '').map((g) => g.name).filter((name) => name !== MCP_HEALTH);
    const start = performance.now();
    const d = await decide('SessionStart', PAYLOAD, env, {
      findGate: onlyReal({ [MCP_HEALTH]: mcpHealthCheck, [first]: mcpHealthCheck, [second]: mcpHealthCheck }),
    });
    const wall = performance.now() - start;
    const slow = d.gates.filter((g) => [MCP_HEALTH, first, second].includes(g.gate));
    assert.equal(slow.length, 3);
    for (const g of slow) assert.ok(g.ms >= 500, `${g.gate} took ${g.ms} ms`);
    const sum = slow.reduce((total, g) => total + g.ms, 0);
    assert.ok(wall < sum * 0.6, `wall ${wall} ms against a ${sum} ms sum`);
  });
});
