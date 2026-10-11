import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalPath, isWithinRoot, outsideProject } from '../tools/containment.js';
describe('canonicalPath — symlinks resolve before `..` applies', () => {
    let sandbox;
    let real;
    let root;
    let outside;
    before(() => {
        sandbox = mkdtempSync(join(tmpdir(), 'tmb-containment-'));
        real = realpathSync(sandbox);
        root = join(sandbox, 'root');
        outside = join(sandbox, 'outside', 'deep');
        mkdirSync(join(root, 'a'), { recursive: true });
        mkdirSync(outside, { recursive: true });
        symlinkSync(outside, join(root, 'link'));
        symlinkSync('../outside/deep', join(root, 'rel'));
    });
    after(() => {
        rmSync(sandbox, { recursive: true, force: true });
    });
    it('<root>/link/../x lands beside the link target, outside the root', () => {
        assert.equal(canonicalPath(join(root, 'link') + '/../x'), join(real, 'outside', 'x'));
        assert.equal(isWithinRoot(root, join(root, 'link') + '/../x'), false);
        assert.equal(outsideProject('t', root, join(root, 'link') + '/../x')?.error, 'outside_project');
    });
    it('a relative symlink resolves against its own directory', () => {
        assert.equal(canonicalPath(join(root, 'rel', 'f')), join(real, 'outside', 'deep', 'f'));
        assert.equal(isWithinRoot(root, join(root, 'rel', 'f')), false);
    });
    it('a legitimate <root>/a/../b stays inside the root', () => {
        assert.equal(canonicalPath(join(root, 'a') + '/../b'), join(real, 'root', 'b'));
        assert.equal(isWithinRoot(root, join(root, 'a') + '/../b'), true);
    });
    it('`..` inside the missing tail collapses lexically', () => {
        assert.equal(canonicalPath(join(root, 'missing') + '/../a/new'), join(real, 'root', 'a', 'new'));
        assert.equal(canonicalPath(join(root, 'missing') + '/../link/../y'), join(real, 'outside', 'y'));
    });
    it('a symlinked spelling of the root compares equal', () => {
        const alias = join(sandbox, 'alias');
        symlinkSync(root, alias);
        assert.equal(isWithinRoot(root, join(alias, 'a', 'z')), true);
    });
});
//# sourceMappingURL=containment.test.js.map