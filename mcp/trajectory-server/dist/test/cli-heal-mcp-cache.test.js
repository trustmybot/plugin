/**
 * `cli.js heal-mcp-cache` (GH 1692), ported with every assertion of the former
 * L3 shell test, run against the built dist/cli.js bundle. Every case points
 * HOME at its own temp dir, so the real ~/.claude.json and ~/.claude/plugins
 * are never read or written.
 *
 * GH 1533: inside Claude Code (CLAUDE_PROJECT_DIR or CLAUDE_PLUGIN_ROOT set) it
 * refuses and changes nothing; a control run from a "terminal" proves the
 * fixture is one it would otherwise edit.
 * GH 1611: each channel (stable, rc, dev) resolves to its own cache dir,
 * installed_plugins entry and the plugin:tmb:trajectory-server MCP key.
 * GH 1675: --dry-run previews Steps A, B and C without prompting or writing.
 * Step C keeps the active and previous cached versions, never the active one.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionCompare } from '../cli/heal-mcp-cache.js';
import { installRoot } from '../hooks/lib/project-env.js';
const PLUGIN_ROOT = installRoot(dirname(fileURLToPath(import.meta.url)));
const CLI = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/cli.js');
const CC_CONFIG = '{ "projects": { "/work/demo": { "disabledMcpServers": ["plugin:tmb:trajectory-server", "other"] } } }\n';
let workspace;
function heal(home, args, input, extra = {}) {
    const env = { ...process.env, HOME: home, ...extra };
    for (const key of ['CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT'])
        if (!(key in extra))
            delete env[key];
    const r = spawnSync(process.execPath, ['--experimental-sqlite', CLI, 'heal-mcp-cache', ...args], {
        env,
        cwd: workspace,
        encoding: 'utf8',
        input: input ?? undefined,
        stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
function listing(dir, rel = '') {
    const out = [];
    for (const name of readdirSync(join(dir, rel)).sort()) {
        const path = join(rel, name);
        const full = join(dir, path);
        const st = statSync(full);
        if (st.isDirectory())
            out.push(`${path}/ ${st.mtimeMs}`, ...listing(dir, path));
        else
            out.push(`${path} ${st.mtimeMs} ${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
    }
    return out;
}
function disabledServers(home) {
    const doc = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    return JSON.stringify(doc.projects['/work/demo'].disabledMcpServers);
}
/** A HOME with all three channel caches at 1.0.0, the given installed_plugins entries and a disabled MCP flag. */
function channelHome(name, plugins) {
    const h = join(workspace, name);
    mkdirSync(join(h, '.claude/plugins'), { recursive: true });
    for (const owner of ['trustmybot', 'trustmybot-rc', 'trustmybot-dev']) {
        mkdirSync(join(h, '.claude/plugins/cache', owner, 'tmb/1.0.0'), { recursive: true });
    }
    writeFileSync(join(h, '.claude/plugins/installed_plugins.json'), `{ "plugins": ${plugins} }\n`);
    writeFileSync(join(h, '.claude.json'), CC_CONFIG);
    return h;
}
const cachesLeft = (h) => readdirSync(join(h, '.claude/plugins/cache')).sort().join(' ');
const entriesLeft = (h) => Object.keys(JSON.parse(readFileSync(join(h, '.claude/plugins/installed_plugins.json'), 'utf8')).plugins)
    .sort()
    .join(' ');
/** A dev-channel HOME where every step has work: cached 1.0.0, 1.1.0 and the active 1.2.0. */
function versionsHome(name, versions, active) {
    const h = join(workspace, name);
    mkdirSync(join(h, '.claude/plugins'), { recursive: true });
    for (const v of versions) {
        mkdirSync(join(h, '.claude/plugins/cache/trustmybot-dev/tmb', v), { recursive: true });
        writeFileSync(join(h, '.claude/plugins/cache/trustmybot-dev/tmb', v, 'plugin.json'), 'x\n');
    }
    writeFileSync(join(h, '.claude/plugins/installed_plugins.json'), `{ "plugins": { "tmb@trustmybot-dev": [ { "version": "${active}", "scope": "local" } ] } }\n`);
    writeFileSync(join(h, '.claude.json'), CC_CONFIG);
    return h;
}
const cachedVersions = (h) => readdirSync(join(h, '.claude/plugins/cache/trustmybot-dev/tmb')).sort(versionCompare).join(' ');
before(() => {
    workspace = mkdtempSync(join(tmpdir(), 'tmb-heal-mcp-cache-'));
});
after(() => {
    rmSync(workspace, { recursive: true, force: true });
});
describe('cli.js heal-mcp-cache: refuses inside Claude Code (GH 1533)', () => {
    let home;
    let original;
    let listingBefore;
    before(() => {
        home = join(workspace, 'refuse');
        mkdirSync(join(home, '.claude/plugins'), { recursive: true });
        writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), '{ "plugins": { "tmb@trustmybot": [ { "version": "1.0.0" } ] } }\n');
        writeFileSync(join(home, '.claude.json'), CC_CONFIG);
        original = readFileSync(join(home, '.claude.json'), 'utf8');
        listingBefore = listing(home);
    });
    for (const variable of ['CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT']) {
        describe(`${variable} set`, () => {
            let run;
            before(() => {
                run = heal(home, [], 'y\nn\n', { [variable]: join(workspace, 'project') });
            });
            it('exits non-zero', () => {
                assert.notEqual(run.code, 0, run.out);
            });
            it('tells the user to quit and run from a terminal', () => {
                assert.ok(run.out.includes('Refusing to run inside Claude Code'), run.out);
                assert.ok(run.out.includes('Quit Claude Code first, then run it from a regular terminal.'), run.out);
            });
            it('.claude.json is byte-identical', () => {
                assert.equal(readFileSync(join(home, '.claude.json'), 'utf8'), original);
            });
            it('nothing created or removed under HOME', () => {
                assert.deepEqual(listing(home), listingBefore);
            });
        });
    }
    describe('control: run from a terminal', () => {
        let run;
        before(() => {
            run = heal(home, [], 'y\nn\n');
        });
        it('the same fixture is edited (Step A yes, Step B no)', () => {
            assert.equal(run.code, 0, run.out);
            assert.equal(disabledServers(home), '["other"]');
        });
        it('Step B skipped prints scoped uninstall + reinstall (stable → project)', () => {
            assert.ok(run.out.includes('claude plugin uninstall tmb@trustmybot --scope project, then reinstall with: claude plugin install tmb@trustmybot --scope project'), run.out);
            assert.ok(run.out.includes('INSTALL.md#recommended-scope-project-or-local'), run.out);
        });
    });
});
describe('cli.js heal-mcp-cache: channel targeting (GH 1611)', () => {
    it('rc auto-detected: only the rc cache and entry go, Step A clears the MCP key', () => {
        const h = channelHome('rc-only', '{ "tmb@trustmybot-rc": [ { "version": "1.0.0", "scope": "local" } ] }');
        const run = heal(h, [], 'y\ny\n');
        assert.equal(run.code, 0, run.out);
        assert.equal(cachesLeft(h), 'trustmybot trustmybot-dev');
        assert.equal(entriesLeft(h), '');
        assert.ok(run.out.includes('claude plugin install tmb@trustmybot-rc --scope local'), run.out);
        assert.equal(disabledServers(h), '["other"]');
    });
    it('--channel dev: only the dev cache and entry go, Step A clears the MCP key', () => {
        const h = channelHome('dev-flag', '{ "tmb@trustmybot": [ { "version": "1.0.0", "scope": "project" } ], "tmb@trustmybot-dev": [ { "version": "1.0.0", "scope": "local" } ] }');
        const run = heal(h, ['--channel', 'dev'], 'y\ny\n');
        assert.equal(run.code, 0, run.out);
        assert.equal(cachesLeft(h), 'trustmybot trustmybot-rc');
        assert.equal(entriesLeft(h), 'tmb@trustmybot');
        assert.equal(disabledServers(h), '["other"]');
    });
    it('two channels, no flag: exits 2 naming stable|rc|dev and removes nothing', () => {
        const h = channelHome('two-channels', '{ "tmb@trustmybot": [ { "version": "1.0.0" } ], "tmb@trustmybot-dev": [ { "version": "1.0.0" } ] }');
        const run = heal(h, [], 'y\ny\n');
        assert.equal(run.code, 2, run.out);
        assert.ok(run.out.includes('Pass --channel stable|rc|dev to choose.'), run.out);
        assert.equal(cachesLeft(h), 'trustmybot trustmybot-dev trustmybot-rc');
        assert.equal(entriesLeft(h), 'tmb@trustmybot tmb@trustmybot-dev');
    });
    it('stable Step B yes: only the stable cache goes and its entry leaves installed_plugins.json', () => {
        const h = channelHome('stable-b', '{ "tmb@trustmybot": [ { "version": "1.0.0", "scope": "project" } ] }');
        const run = heal(h, [], 'y\ny\n');
        assert.equal(run.code, 0, run.out);
        assert.equal(cachesLeft(h), 'trustmybot-dev trustmybot-rc');
        assert.equal(entriesLeft(h), '');
    });
    it('an unknown channel exits 2', () => {
        const h = channelHome('unknown-channel', '{ "tmb@trustmybot": [ { "version": "1.0.0" } ] }');
        const run = heal(h, ['--channel=beta'], '');
        assert.equal(run.code, 2, run.out);
        assert.ok(run.out.includes('Unknown channel: beta'), run.out);
    });
    it('no install and no flag exits 1', () => {
        const h = join(workspace, 'no-install');
        mkdirSync(h);
        const run = heal(h, ['--dry-run'], '');
        assert.equal(run.code, 1, run.out);
        assert.ok(run.out.includes('No tmb installation found'), run.out);
        assert.deepEqual(readdirSync(h), []);
    });
});
describe('cli.js heal-mcp-cache: prompts and defaults', () => {
    it('empty answers take the defaults: Step A and C yes, Step B no', () => {
        const h = versionsHome('defaults', ['1.0.0', '1.1.0', '1.2.0'], '1.2.0');
        const run = heal(h, [], '\n\n\n');
        assert.equal(run.code, 0, run.out);
        assert.ok(run.out.includes('Proceed with Step A? (Y/n) '), run.out);
        assert.ok(run.out.includes('Proceed with Step C prune? (Y/n) '), run.out);
        assert.ok(run.out.includes('Proceed with Step B (cache nuke)? (y/N) '), run.out);
        assert.equal(disabledServers(h), '["other"]');
        assert.equal(cachedVersions(h), '1.1.0 1.2.0');
        assert.ok(run.out.includes('Skipped Step B.'), run.out);
        assert.equal(entriesLeft(h), 'tmb@trustmybot-dev');
    });
    it('n to Steps A and C changes nothing', () => {
        const h = versionsHome('all-no', ['1.0.0', '1.1.0', '1.2.0'], '1.2.0');
        const run = heal(h, [], 'n\nNO\n\n');
        assert.equal(run.code, 0, run.out);
        assert.ok(run.out.includes('Skipped Step A.'), run.out);
        assert.ok(run.out.includes('Skipped Step C.'), run.out);
        assert.equal(disabledServers(h), '["plugin:tmb:trajectory-server","other"]');
        assert.equal(cachedVersions(h), '1.0.0 1.1.0 1.2.0');
    });
    it('answers padded with spaces and tabs are trimmed like bash read -r: padded n skips Steps A and C', () => {
        const h = versionsHome('padded-no', ['1.0.0', '1.1.0', '1.2.0'], '1.2.0');
        const before = readFileSync(join(h, '.claude.json'), 'utf8');
        const run = heal(h, [], 'n \n\t n\nn\n');
        assert.equal(run.code, 0, run.out);
        assert.ok(run.out.includes('Skipped Step A.'), run.out);
        assert.ok(run.out.includes('Skipped Step C.'), run.out);
        assert.equal(readFileSync(join(h, '.claude.json'), 'utf8'), before);
        assert.equal(cachedVersions(h), '1.0.0 1.1.0 1.2.0');
    });
    it('padded y at Step B runs the cache nuke', () => {
        const h = versionsHome('padded-yes', ['1.0.0', '1.1.0', '1.2.0'], '1.2.0');
        const run = heal(h, [], 'n\nn\n y\t\n');
        assert.equal(run.code, 0, run.out);
        assert.ok(!run.out.includes('Skipped Step B.'), run.out);
        assert.equal(cachesLeft(h), '');
        assert.equal(entriesLeft(h), '');
    });
    it('Step A backs up ~/.claude.json before editing it', () => {
        const h = versionsHome('backup', ['1.2.0'], '1.2.0');
        const run = heal(h, [], 'y\nn\n');
        assert.equal(run.code, 0, run.out);
        const backups = readdirSync(h).filter((n) => /^\.claude\.json\.bak\.\d{8}T\d{6}Z$/.test(n));
        assert.equal(backups.length, 1, readdirSync(h).join(' '));
        assert.equal(readFileSync(join(h, backups[0]), 'utf8'), CC_CONFIG);
    });
    it('end of input at a prompt exits 1 with nothing written', () => {
        const h = versionsHome('eof', ['1.0.0', '1.1.0', '1.2.0'], '1.2.0');
        const snapshot = listing(h);
        const run = heal(h, [], '');
        assert.equal(run.code, 1, run.out);
        assert.deepEqual(listing(h), snapshot);
    });
});
describe('cli.js heal-mcp-cache: Step C keeps the active and previous versions', () => {
    it('prunes everything but the active version and the highest one below it', () => {
        const h = versionsHome('gc', ['0.9', '1.0.0', '1.2.0-dev.2', '1.2.0-dev.10', '1.2.0', '1.10.0', 'unknown'], '1.2.0-dev.10');
        const run = heal(h, [], 'n\ny\nn\n');
        assert.equal(run.code, 0, run.out);
        assert.ok(run.out.includes('active (keep):    1.2.0-dev.10'), run.out);
        assert.ok(run.out.includes('previous (keep):  1.2.0-dev.2'), run.out);
        assert.equal(cachedVersions(h), '1.2.0-dev.2 1.2.0-dev.10 unknown');
    });
    it('never prunes the active version, even when it sorts below every other', () => {
        const h = versionsHome('gc-active-lowest', ['1.0.0', '1.1.0', '1.2.0'], '1.0.0');
        const run = heal(h, [], 'n\ny\nn\n');
        assert.equal(run.code, 0, run.out);
        assert.ok(run.out.includes('previous (keep):  (none)'), run.out);
        assert.equal(cachedVersions(h), '1.0.0');
    });
    it('with no usable active version keeps the highest cached one', () => {
        const h = versionsHome('gc-no-active', ['1.0.0', '1.1.0', '1.2.0'], 'unknown');
        const run = heal(h, [], 'n\ny\nn\n');
        assert.equal(run.code, 0, run.out);
        assert.ok(run.out.includes('treating highest cached 1.2.0 as active'), run.out);
        assert.equal(cachedVersions(h), '1.1.0 1.2.0');
    });
    it('orders versions as sort -V does', () => {
        const sorted = ['1.10.0', '1.2.0', '1.2.0-dev.10.gh1', '1.2.0~rc1', '1.2.0-dev.2.gh10', '1.0.0', '1.2.0.beta'].sort(versionCompare);
        assert.deepEqual(sorted, ['1.0.0', '1.2.0~rc1', '1.2.0', '1.2.0.beta', '1.2.0-dev.2.gh10', '1.2.0-dev.10.gh1', '1.10.0']);
    });
});
describe('cli.js heal-mcp-cache: --dry-run is a pure preview (GH 1675)', () => {
    for (const stdinMode of ['yes', 'closed']) {
        describe(`stdin ${stdinMode}`, () => {
            let h;
            let snapshot;
            let run;
            before(() => {
                h = versionsHome(`dry-${stdinMode}`, ['1.0.0', '1.1.0', '1.2.0'], '1.2.0');
                snapshot = listing(h);
                run = heal(h, ['--channel', 'dev', '--dry-run'], stdinMode === 'yes' ? 'y\n'.repeat(10) : null);
            });
            it('exits 0', () => {
                assert.equal(run.code, 0, run.out);
            });
            it('HOME is identical before and after', () => {
                assert.deepEqual(listing(h), snapshot);
            });
            it('previews Steps A, B and C', () => {
                assert.ok(run.out.includes('[dry-run] Step A would:'), run.out);
                assert.ok(run.out.includes(`[dry-run] Step C would: rm -rf ${h}/.claude/plugins/cache/trustmybot-dev/tmb/1.0.0`), run.out);
                assert.ok(run.out.includes(`[dry-run] Step B would: rm -rf ${h}/.claude/plugins/cache/trustmybot-dev;`), run.out);
            });
            it('never prompts', () => {
                assert.ok(!run.out.includes('Proceed with'), run.out);
            });
        });
    }
});
//# sourceMappingURL=cli-heal-mcp-cache.test.js.map