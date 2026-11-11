import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ensureLocalSettingsIgnored,
  isSshRemote,
  removeProjectSandbox,
  SANDBOX_NETWORK_PROBE,
  SANDBOX_NETWORK_PROBES,
  sandboxRecommended,
  type SandboxProbe,
  type SandboxRecord,
  writeProjectSandbox,
} from '../tools/onboard-sandbox.js';

// The sandbox writer never writes outside the project: HOME is an empty temp
// dir for the whole file and must still be empty at the end. Git discovery
// stops at the temp root, so a non-git temp dir stays non-git even when the
// temp root sits inside a checkout.
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'sandbox-home-'));
process.env['HOME'] = ISOLATED_HOME;
process.env['GIT_CEILING_DIRECTORIES'] = realpathSync(tmpdir());

const ENTRY = '.claude/settings.local.json';

interface LocalSettings {
  sandbox?: { enabled?: boolean; network?: { allowedDomains?: string[]; allowLocalBinding?: boolean } };
}

describe('settings.local.json is gitignored when TMB creates it', () => {
  let project: string;

  const settingsPath = () => join(project, '.claude', 'settings.local.json');
  const gitignorePath = () => join(project, '.gitignore');
  const entryCount = () => readFileSync(gitignorePath(), 'utf8').split('\n').filter((l) => l === ENTRY).length;
  const write = () =>
    writeProjectSandbox({ projectRoot: project, cacheDir: join(project, 'model-cache'), platform: 'linux', previous: null });
  const gitInit = () => {
    const r = spawnSync('git', ['init', '-q', project], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };

  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-test-')));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it('git work tree: creating the file appends the path once', () => {
    gitInit();
    const res = write();
    assert.equal(res.written, true);
    assert.equal(res.gitignore_appended, true);
    assert.equal(entryCount(), 1);
    const ignored = spawnSync('git', ['-C', project, 'check-ignore', '-q', ENTRY]);
    assert.equal(ignored.status, 0, 'git now ignores the settings file');
  });

  it('a second write appends nothing', () => {
    gitInit();
    write();
    const res = write();
    assert.equal(res.written, true);
    assert.equal(res.gitignore_appended, false);
    assert.equal(entryCount(), 1);
  });

  it('a .gitignore without a trailing newline gets the path on its own line', () => {
    gitInit();
    writeFileSync(gitignorePath(), 'node_modules/');
    assert.equal(write().gitignore_appended, true);
    assert.equal(readFileSync(gitignorePath(), 'utf8'), `node_modules/\n${ENTRY}\n`);
  });

  it('a path git already ignores is left alone', () => {
    gitInit();
    writeFileSync(gitignorePath(), '.claude/\n');
    assert.equal(write().gitignore_appended, false);
    assert.equal(readFileSync(gitignorePath(), 'utf8'), '.claude/\n');
  });

  it('outside a git work tree nothing is appended', () => {
    const res = write();
    assert.equal(res.written, true);
    assert.equal(res.gitignore_appended, false);
    assert.ok(!existsSync(gitignorePath()));
    assert.deepEqual(ensureLocalSettingsIgnored(project), { appended: false });
  });

  it('a settings file that already existed leaves .gitignore untouched', () => {
    gitInit();
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), '{}\n');
    const res = write();
    assert.equal(res.written, true);
    assert.equal(res.gitignore_appended, false);
    assert.ok(!existsSync(gitignorePath()));
  });

  it('never writes under HOME', () => {
    assert.deepEqual(readdirSync(ISOLATED_HOME), []);
  });
});

describe('sandbox.network.allowLocalBinding is owned like enableWeakerNetworkIsolation', () => {
  let project: string;

  const settingsPath = () => join(project, '.claude', 'settings.local.json');
  const seed = (settings: unknown) => {
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(settings));
  };
  const read = () => JSON.parse(readFileSync(settingsPath(), 'utf8')) as LocalSettings;
  const write = (previous: SandboxRecord | null = null) =>
    writeProjectSandbox({ projectRoot: project, cacheDir: join(project, 'model-cache'), platform: 'linux', previous });

  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-binding-')));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it('a fresh write sets it, keeps the existing allowedDomains and records allow_local_binding_set', () => {
    seed({ sandbox: { network: { allowedDomains: ['example.com'] } } });
    const res = write();
    assert.equal(res.written, true);
    assert.equal(res.allow_local_binding, true);
    assert.equal(res.record?.allow_local_binding_set, true);
    const network = read().sandbox?.network;
    assert.equal(network?.allowLocalBinding, true);
    assert.equal(network?.allowedDomains?.[0], 'example.com', 'the existing domain is kept first');
    assert.equal(network?.allowedDomains?.filter((d) => d === 'github.com').length, 1);
  });

  it('with no settings file at all, it creates the network object with allowLocalBinding', () => {
    const res = write();
    assert.equal(res.record?.allow_local_binding_set, true);
    assert.equal(read().sandbox?.network?.allowLocalBinding, true);
  });

  for (const human of [true, false]) {
    it(`a Human-set ${human} is kept, recorded as not TMB's, and survives removal`, () => {
      seed({ sandbox: { network: { allowLocalBinding: human } } });
      const res = write();
      assert.equal(res.allow_local_binding, human);
      assert.equal(res.record?.allow_local_binding_set, false);
      assert.equal(read().sandbox?.network?.allowLocalBinding, human);

      const again = write(res.record);
      assert.equal(again.record?.allow_local_binding_set, false, 'a re-apply still leaves it the Human\'s');
      assert.equal(read().sandbox?.network?.allowLocalBinding, human);

      assert.equal(removeProjectSandbox({ projectRoot: project, record: again.record ?? null }).removed, true);
      assert.deepEqual(read(), { sandbox: { network: { allowLocalBinding: human } } });
    });
  }

  it('a re-apply over a TMB-set value keeps owning it, and removal deletes it', () => {
    const first = write();
    const second = write(first.record);
    assert.equal(second.record?.allow_local_binding_set, true);
    assert.equal(removeProjectSandbox({ projectRoot: project, record: second.record ?? null }).removed, true);
    assert.deepEqual(read(), {}, 'nothing TMB wrote is left');
  });

  it('a record written before the flag existed counts as not TMB-set', () => {
    seed({ sandbox: { enabled: true, network: { allowLocalBinding: true } } });
    const legacy: SandboxRecord = { enabled_set: true, allow_write: [], allowed_domains: [] };
    const res = write(legacy);
    assert.equal(res.record?.allow_local_binding_set, false, 'a value present before the write stays the Human\'s');
    assert.equal(read().sandbox?.network?.allowLocalBinding, true);

    seed({ sandbox: { enabled: true, network: { allowLocalBinding: true } } });
    assert.equal(removeProjectSandbox({ projectRoot: project, record: legacy }).removed, true);
    assert.deepEqual(read(), { sandbox: { network: { allowLocalBinding: true } } }, 'removal keeps it');
  });
});

describe('removal deletes a TMB-owned network key only while it is still true', () => {
  let project: string;

  const settingsPath = () => join(project, '.claude', 'settings.local.json');
  type WrittenSettings = { sandbox: Record<string, unknown> & { network: Record<string, unknown> } };
  const read = () => JSON.parse(readFileSync(settingsPath(), 'utf8')) as WrittenSettings;
  const edit = (change: (settings: WrittenSettings) => void) => {
    const settings = read();
    change(settings);
    writeFileSync(settingsPath(), JSON.stringify(settings));
  };
  const writeDarwin = () => {
    const res = writeProjectSandbox({ projectRoot: project, cacheDir: join(project, 'model-cache'), platform: 'darwin', previous: null });
    assert.equal(res.record?.allow_local_binding_set, true);
    assert.equal(res.record?.weaker_network_isolation_set, true);
    return res.record ?? null;
  };
  const remove = (record: SandboxRecord | null) =>
    assert.equal(removeProjectSandbox({ projectRoot: project, record }).removed, true);

  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-remove-')));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it('both keys still true are removed, and the empty network and sandbox objects are pruned', () => {
    const record = writeDarwin();
    assert.equal(read().sandbox.network.allowLocalBinding, true);
    assert.equal(read().sandbox.enableWeakerNetworkIsolation, true);
    remove(record);
    assert.deepEqual(read(), {});
  });

  it('allowLocalBinding the Human changed to false is kept, and so is its network object', () => {
    const record = writeDarwin();
    edit((s) => { s.sandbox.network['allowLocalBinding'] = false; });
    remove(record);
    assert.deepEqual(read(), { sandbox: { network: { allowLocalBinding: false } } });
  });

  it('enableWeakerNetworkIsolation the Human changed to false is kept, and the empty network is pruned', () => {
    const record = writeDarwin();
    edit((s) => { s.sandbox['enableWeakerNetworkIsolation'] = false; });
    remove(record);
    assert.deepEqual(read(), { sandbox: { enableWeakerNetworkIsolation: false } });
  });

  it('a still-true allowLocalBinding is removed while a Human network key keeps the network object', () => {
    const record = writeDarwin();
    edit((s) => { s.sandbox.network['httpProxyPort'] = 8080; });
    remove(record);
    assert.deepEqual(read(), { sandbox: { network: { httpProxyPort: 8080 } } });
  });

  it('a still-true enableWeakerNetworkIsolation is removed while a Human sandbox key keeps the sandbox object', () => {
    const record = writeDarwin();
    edit((s) => { s.sandbox['autoAllowBashIfSandboxed'] = false; });
    remove(record);
    assert.deepEqual(read(), { sandbox: { autoAllowBashIfSandboxed: false } });
  });

  it('a TMB-set enabled still true is removed', () => {
    const record = writeDarwin();
    assert.equal(record?.enabled_set, true);
    assert.equal(read().sandbox.enabled, true);
    edit((s) => { s.sandbox['autoAllowBashIfSandboxed'] = false; });
    remove(record);
    assert.deepEqual(read(), { sandbox: { autoAllowBashIfSandboxed: false } });
  });

  it('enabled the Human changed to false is kept, and so is its sandbox object', () => {
    const record = writeDarwin();
    edit((s) => { s.sandbox['enabled'] = false; });
    remove(record);
    assert.deepEqual(read(), { sandbox: { enabled: false } });
  });
});

describe('sandboxRecommended reads the probe recorded for the platform', () => {
  const HTTPS = ['https://github.com/a/b.git'];
  const SSH = ['git@github.com:a/b.git'];
  const linuxPassed: Partial<Record<NodeJS.Platform, SandboxProbe>> = {
    linux: { platform: 'linux', failed: [], cc_version: 'x', date: 'y' },
  };

  it('the shipped records hold darwin only, and SANDBOX_NETWORK_PROBE is the darwin record', () => {
    assert.deepEqual(Object.keys(SANDBOX_NETWORK_PROBES), ['darwin']);
    assert.equal(SANDBOX_NETWORK_PROBES.darwin, SANDBOX_NETWORK_PROBE);
  });

  it('darwin with the shipped record: yes for HTTPS-only or no remotes, no with an SSH remote', () => {
    assert.equal(sandboxRecommended(HTTPS, 'darwin'), true);
    assert.equal(sandboxRecommended([], 'darwin'), true);
    assert.equal(sandboxRecommended(SSH, 'darwin'), false);
    assert.equal(sandboxRecommended(['ssh://git@github.com/a/b.git'], 'darwin'), false);
  });

  it('linux with the shipped record: no', () => {
    assert.equal(sandboxRecommended(HTTPS, 'linux'), false);
    assert.equal(sandboxRecommended([], 'linux'), false);
  });

  it('linux with a passing record: yes for HTTPS-only remotes, no with an SSH remote', () => {
    assert.equal(sandboxRecommended(HTTPS, 'linux', linuxPassed), true);
    assert.equal(sandboxRecommended(SSH, 'linux', linuxPassed), false);
  });

  it('a recorded failure keeps the platform at no', () => {
    const darwinFailed = { darwin: { ...SANDBOX_NETWORK_PROBE, failed: ['bun add is-number'] } };
    assert.equal(sandboxRecommended(HTTPS, 'darwin', darwinFailed), false);
  });

  it('win32 has no record: no', () => {
    assert.equal(sandboxRecommended(HTTPS, 'win32'), false);
    assert.equal(sandboxRecommended(HTTPS, 'win32', linuxPassed), false);
  });

  it('the default platform is the host', () => {
    assert.equal(sandboxRecommended(HTTPS), SANDBOX_NETWORK_PROBES[process.platform] !== undefined);
    assert.equal(isSshRemote(HTTPS[0]), false);
  });
});
