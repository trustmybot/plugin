import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncProjectPersona } from '../tools/onboard-persona.js';

describe('syncProjectPersona', () => {
  let root: string;
  let pluginRoot: string;
  let projectRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tmb-persona-'));
    pluginRoot = join(root, 'plugin');
    projectRoot = join(root, 'project');
    mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
    mkdirSync(projectRoot);
    writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1.2.3' }));
    writeFileSync(join(pluginRoot, 'CLAUDE.md'), '# You are bro\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  for (const enabled of [true, false]) {
    describe(`enabled=${enabled}`, () => {
      it('skips a symlinked CLAUDE.md and leaves link and target untouched', () => {
        const target = join(root, 'AGENTS.md');
        writeFileSync(target, '# Shared\n');
        const link = join(projectRoot, 'CLAUDE.md');
        symlinkSync(target, link);
        const r = syncProjectPersona({ pluginRoot, projectRoot, enabled });
        assert.equal(r.action, 'skipped');
        assert.match(r.reason ?? '', /symlink/);
        assert.ok(lstatSync(link).isSymbolicLink());
        assert.equal(readlinkSync(link), target);
        assert.equal(readFileSync(target, 'utf8'), '# Shared\n');
      });

      it('skips a read-only CLAUDE.md and leaves content and mode untouched', () => {
        const file = join(projectRoot, 'CLAUDE.md');
        const content = '# Mine\n\n<!-- tmb:persona start v1.0.0 -->\nold\n<!-- tmb:persona end -->\n';
        writeFileSync(file, content);
        chmodSync(file, 0o444);
        const r = syncProjectPersona({ pluginRoot, projectRoot, enabled });
        assert.equal(r.action, 'skipped');
        assert.match(r.reason ?? '', /read-only/);
        assert.equal(readFileSync(file, 'utf8'), content);
        assert.equal(statSync(file).mode & 0o7777, 0o444);
      });
    });
  }

  it('a writable regular file is appended to and keeps its mode', () => {
    const file = join(projectRoot, 'CLAUDE.md');
    writeFileSync(file, '# Mine\n');
    chmodSync(file, 0o640);
    const r = syncProjectPersona({ pluginRoot, projectRoot, enabled: true });
    assert.equal(r.action, 'appended');
    assert.equal(r.version, '1.2.3');
    assert.ok(readFileSync(file, 'utf8').includes('<!-- tmb:persona start v1.2.3 -->'));
    assert.equal(statSync(file).mode & 0o7777, 0o640);
  });
});
