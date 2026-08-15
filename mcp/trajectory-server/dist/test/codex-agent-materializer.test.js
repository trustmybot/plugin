import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { CODEX_AGENT_CATALOG, CODEX_AGENT_TEMPLATE_SET_VERSION, sha256, } from '../codex-agent-catalog.js';
import { CodexAgentMaterializationError, CodexAgentMaterializer, } from '../codex-agent-materializer.js';
import { CodexRuntimeManager, validateCodexProjectRoot, } from '../codex-runtime.js';
import { CODEX_SCOPE_4_TOOL_NAMES, createCodexToolRegistry, } from '../codex-tools.js';
const cleanup = [];
const realFileSystem = {
    lstat: lstatSync,
    mkdir: (path) => mkdirSync(path, { mode: 0o755 }),
    realpath: realpathSync,
    readFile: (path) => readFileSync(path),
    openExclusive: (path) => openSync(path, constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0), 0o644),
    write: (fd, bytes) => writeSync(fd, bytes, 0, bytes.length),
    close: closeSync,
    unlink: unlinkSync,
};
afterEach(() => {
    while (cleanup.length > 0) {
        rmSync(cleanup.pop(), { recursive: true, force: true });
    }
});
describe('Codex Agent catalog', () => {
    it('is the single canonical source for exactly two parseable Agent files', () => {
        assert.equal(CODEX_AGENT_TEMPLATE_SET_VERSION, 1);
        assert.deepEqual(CODEX_AGENT_CATALOG.map((entry) => entry.agentId), ['tmb_swe', 'tmb_pr_reviewer']);
        assert.deepEqual(CODEX_AGENT_CATALOG.map((entry) => entry.targetPath), [
            '.codex/agents/tmb_swe.toml',
            '.codex/agents/tmb_pr_reviewer.toml',
        ]);
        const fixture = tempDirectory('tmb-codex-catalog-');
        for (const template of CODEX_AGENT_CATALOG) {
            const text = template.expectedBytes.toString('utf8');
            assert.equal(template.body.endsWith('\n'), true);
            assert.equal(template.body.startsWith(`name = "${template.agentId}"\n`), true);
            assert.match(text, /^# Managed by TrustMyBot Codex Scope 4\.\n/);
            assert.match(text, new RegExp(`# tmb-template-id: ${template.agentId}\\n`));
            assert.match(text, /# tmb-template-version: 1\n/);
            assert.match(text, new RegExp(`# tmb-body-sha256: ${template.bodySha256}\\n\\n`));
            assert.equal(sha256(template.body), template.bodySha256);
            assert.equal(sha256(template.expectedBytes), template.expectedContentSha256);
            assert.doesNotMatch(template.body, /^model\s*=/m);
            assert.doesNotMatch(template.body, /^model_reasoning_effort\s*=/m);
            assert.match(template.body, /sandbox_mode = "(?:workspace-write|read-only)"/);
            assert.match(template.body, /\[mcp_servers\."trajectory-server"\]\ncommand = "node"\nargs = \["--version"\]\nenabled = false/);
            assert.doesNotMatch(template.body, /^\[plugins\./m);
            const target = join(fixture, `${template.agentId}.toml`);
            writeFileSync(target, template.expectedBytes);
            execFileSync('bun', [
                '-e',
                'Bun.TOML.parse(await Bun.file(process.argv[1]).text())',
                target,
            ]);
        }
    });
});
describe('Codex Agent materializer', () => {
    it('installs, reports, and removes both files idempotently', async () => {
        const project = gitProject();
        const materializer = new CodexAgentMaterializer();
        const absent = await materializer.get(project);
        assert.equal(absent.overall_status, 'absent');
        assert.deepEqual(absent.agents.map((entry) => entry.status), ['absent', 'absent']);
        assert.equal(existsSync(join(project, '.tmb')), false);
        assert.equal(existsSync(join(project, '.codex')), false);
        const installed = await materializer.set(project, 'present');
        assert.deepEqual(installed, {
            project_root: realpathSync(project),
            desired_state: 'present',
            changed: CODEX_AGENT_CATALOG.map((entry) => entry.targetPath),
            unchanged: [],
            overall_status: 'current',
            restart_required: true,
        });
        for (const template of CODEX_AGENT_CATALOG) {
            assert.deepEqual(readFileSync(join(project, template.targetPath)), template.expectedBytes);
        }
        const current = await materializer.get(project);
        assert.equal(current.overall_status, 'current');
        for (const entry of current.agents) {
            assert.equal(entry.status, 'current');
            assert.equal(entry.current_content_sha256?.length, 64);
            assert.equal('conflict_reason' in entry, false);
        }
        const repeated = await materializer.set(project, 'present');
        assert.deepEqual(repeated.changed, []);
        assert.deepEqual(repeated.unchanged, CODEX_AGENT_CATALOG.map((entry) => entry.targetPath));
        assert.equal(repeated.restart_required, false);
        const sentinel = join(project, '.codex', 'agents', 'sentinel.toml');
        writeFileSync(sentinel, 'name = "sentinel"\n');
        const removed = await materializer.set(project, 'absent');
        assert.deepEqual(removed.changed, CODEX_AGENT_CATALOG.map((entry) => entry.targetPath));
        assert.equal(removed.overall_status, 'absent');
        assert.equal(removed.restart_required, true);
        assert.equal(readFileSync(sentinel, 'utf8'), 'name = "sentinel"\n');
        assert.equal(existsSync(join(project, '.codex', 'agents')), true);
        const repeatedRemoval = await materializer.set(project, 'absent');
        assert.deepEqual(repeatedRemoval.changed, []);
        assert.deepEqual(repeatedRemoval.unchanged, CODEX_AGENT_CATALOG.map((entry) => entry.targetPath));
        assert.equal(repeatedRemoval.restart_required, false);
    });
    it('reconciles safe mixed states in catalog order', async () => {
        const project = gitProject();
        const materializer = localMaterializer(project);
        const first = CODEX_AGENT_CATALOG[0];
        mkdirSync(join(project, '.codex', 'agents'), { recursive: true });
        writeFileSync(join(project, first.targetPath), first.expectedBytes);
        const mixed = await materializer.get(project);
        assert.equal(mixed.overall_status, 'mixed');
        assert.deepEqual(mixed.agents.map((entry) => entry.status), ['current', 'absent']);
        const installed = await materializer.set(project, 'present');
        assert.deepEqual(installed.changed, [CODEX_AGENT_CATALOG[1].targetPath]);
        assert.deepEqual(installed.unchanged, [first.targetPath]);
        unlinkSync(join(project, first.targetPath));
        const inverseMixed = await materializer.get(project);
        assert.equal(inverseMixed.overall_status, 'mixed');
        assert.deepEqual(inverseMixed.agents.map((entry) => entry.status), ['absent', 'current']);
        const removed = await materializer.set(project, 'absent');
        assert.deepEqual(removed.changed, [CODEX_AGENT_CATALOG[1].targetPath]);
        assert.deepEqual(removed.unchanged, [first.targetPath]);
    });
    it('reports byte-level conflicts without returning conflict hashes or content', async () => {
        const variants = [
            Buffer.from('# Managed by TrustMyBot Codex Scope 4.\nname = "fake"\n'),
            Buffer.concat([CODEX_AGENT_CATALOG[0].expectedBytes, Buffer.from('\n')]),
            Buffer.from(CODEX_AGENT_CATALOG[0].expectedBytes.toString('utf8').replaceAll('\n', '\r\n')),
            Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), CODEX_AGENT_CATALOG[0].expectedBytes]),
        ];
        for (const [index, bytes] of variants.entries()) {
            const project = gitProject();
            const materializer = localMaterializer(project);
            mkdirSync(join(project, '.codex', 'agents'), { recursive: true });
            writeFileSync(join(project, CODEX_AGENT_CATALOG[0].targetPath), bytes);
            const status = await materializer.get(project);
            assert.equal(status.overall_status, 'conflict', `variant ${index}`);
            const conflict = status.agents[0];
            assert.equal(conflict.status, 'conflict');
            assert.equal(conflict.conflict_reason, 'content_mismatch');
            assert.equal('current_content_sha256' in conflict, false);
            assert.equal(JSON.stringify(status).includes(bytes.toString('utf8')), false);
        }
    });
    it('rejects size-mismatched conflicts without reading their contents', async () => {
        const project = gitProject();
        const target = join(project, CODEX_AGENT_CATALOG[0].targetPath);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, 0x78));
        let readCount = 0;
        const materializer = localMaterializer(project, faultFileSystem({
            readFile: (path) => {
                readCount += 1;
                return realFileSystem.readFile(path);
            },
        }));
        const result = await materializer.get(project);
        assert.equal(result.overall_status, 'conflict');
        assert.equal(result.agents[0].status, 'conflict');
        assert.equal('current_content_sha256' in result.agents[0], false);
        assert.equal(readCount, 0);
    });
    it('fails the entire setter preflight when either target conflicts', async () => {
        const project = gitProject();
        const materializer = localMaterializer(project);
        mkdirSync(join(project, '.codex', 'agents'), { recursive: true });
        writeFileSync(join(project, CODEX_AGENT_CATALOG[0].targetPath), CODEX_AGENT_CATALOG[0].expectedBytes);
        writeFileSync(join(project, CODEX_AGENT_CATALOG[1].targetPath), 'name = "user-reviewer"\n');
        await expectMaterializerError(materializer.set(project, 'absent'), 'agent_materialization_conflict');
        assert.equal(existsSync(join(project, CODEX_AGENT_CATALOG[0].targetPath)), true);
        await expectMaterializerError(materializer.set(project, 'present'), 'agent_materialization_conflict');
        assert.deepEqual(readFileSync(join(project, CODEX_AGENT_CATALOG[1].targetPath), 'utf8'), 'name = "user-reviewer"\n');
    });
    it('reports a known conflict before a later target read failure', async () => {
        const project = gitProject();
        const [first, second] = CODEX_AGENT_CATALOG;
        mkdirSync(join(project, '.codex', 'agents'), { recursive: true });
        writeFileSync(join(project, first.targetPath), Buffer.alloc(first.expectedBytes.length, 0x78));
        writeFileSync(join(project, second.targetPath), second.expectedBytes);
        const fs = faultFileSystem({
            readFile: (path) => {
                if (path.endsWith(second.targetPath))
                    throw errno('EACCES');
                return realFileSystem.readFile(path);
            },
        });
        const error = await expectMaterializerError(localMaterializer(project, fs).set(project, 'present'), 'agent_materialization_conflict');
        assert.deepEqual(error.details?.['conflicts'], [{
                agent_id: first.agentId,
                target_path: first.targetPath,
                reason: 'content_mismatch',
            }]);
        assert.deepEqual(readFileSync(join(project, first.targetPath)), Buffer.alloc(first.expectedBytes.length, 0x78));
    });
    it('reports every preflight conflict in deterministic catalog order', async () => {
        const project = gitProject();
        const materializer = localMaterializer(project);
        mkdirSync(join(project, '.codex', 'agents'), { recursive: true });
        for (const template of [...CODEX_AGENT_CATALOG].reverse()) {
            writeFileSync(join(project, template.targetPath), `name = "user-${template.agentId}"\n`);
        }
        const error = await expectMaterializerError(materializer.set(project, 'present'), 'agent_materialization_conflict');
        assert.deepEqual((error.details?.['conflicts']).map((entry) => entry.agent_id), CODEX_AGENT_CATALOG.map((entry) => entry.agentId));
        assert.equal(JSON.stringify(error.details).includes('user-tmb_'), false);
    });
    it('rejects symlinked and non-regular path segments without reading them', async () => {
        for (const target of ['codex', 'agents', 'file', 'directory', 'fifo']) {
            const project = gitProject();
            const materializer = localMaterializer(project);
            const outside = tempDirectory('tmb-codex-outside-');
            if (target === 'codex') {
                symlinkSync(outside, join(project, '.codex'));
            }
            else {
                mkdirSync(join(project, '.codex'), { recursive: true });
                if (target === 'agents') {
                    symlinkSync(outside, join(project, '.codex', 'agents'));
                }
                else {
                    mkdirSync(join(project, '.codex', 'agents'));
                    const path = join(project, CODEX_AGENT_CATALOG[0].targetPath);
                    if (target === 'file')
                        symlinkSync(join(outside, 'missing'), path);
                    if (target === 'directory')
                        mkdirSync(path);
                    if (target === 'fifo')
                        execFileSync('mkfifo', [path]);
                }
            }
            const error = await expectMaterializerError(materializer.get(project), 'unsafe_codex_agents_path');
            assert.equal(String(error.details?.['target_path']).startsWith(project), false);
            assert.equal(existsSync(join(project, '.tmb')), false);
        }
    });
    it('orders unsafe paths before content conflicts regardless of catalog position', async () => {
        for (const unsafeIndex of [0, 1]) {
            const project = gitProject();
            mkdirSync(join(project, '.codex', 'agents'), { recursive: true });
            for (const [index, template] of CODEX_AGENT_CATALOG.entries()) {
                const target = join(project, template.targetPath);
                if (index === unsafeIndex)
                    mkdirSync(target);
                else
                    writeFileSync(target, Buffer.alloc(template.expectedBytes.length, 0x78));
            }
            await expectMaterializerError(localMaterializer(project).get(project), 'unsafe_codex_agents_path');
        }
        const parentProject = gitProject();
        const outside = tempDirectory('tmb-codex-unsafe-parent-');
        mkdirSync(join(parentProject, '.codex'));
        symlinkSync(outside, join(parentProject, '.codex', 'agents'));
        writeFileSync(join(outside, CODEX_AGENT_CATALOG[0].agentId + '.toml'), Buffer.alloc(CODEX_AGENT_CATALOG[0].expectedBytes.length, 0x78));
        await expectMaterializerError(localMaterializer(parentProject).get(parentProject), 'unsafe_codex_agents_path');
    });
    it('returns direct I/O failures before a target mutation', async () => {
        const project = gitProject();
        const mkdirFailure = localMaterializer(project, faultFileSystem({
            mkdir: () => {
                throw errno('EACCES');
            },
        }));
        await expectMaterializerError(mkdirFailure.set(project, 'present'), 'agent_materialization_io_failed');
        mkdirSync(join(project, '.codex', 'agents'), { recursive: true });
        const openFailure = localMaterializer(project, faultFileSystem({
            openExclusive: () => {
                throw errno('EACCES');
            },
        }));
        await expectMaterializerError(openFailure.set(project, 'present'), 'agent_materialization_io_failed');
        assert.equal(existsSync(join(project, CODEX_AGENT_CATALOG[0].targetPath)), false);
        const normal = localMaterializer(project);
        await normal.set(project, 'present');
        const unlinkFailure = localMaterializer(project, faultFileSystem({
            unlink: () => {
                throw errno('EACCES');
            },
        }));
        await expectMaterializerError(unlinkFailure.set(project, 'absent'), 'agent_materialization_io_failed');
        assert.equal(existsSync(join(project, CODEX_AGENT_CATALOG[0].targetPath)), true);
    });
    it('classifies read failures before and after target mutation', async () => {
        const preflightProject = gitProject();
        const preflightTarget = join(preflightProject, CODEX_AGENT_CATALOG[0].targetPath);
        mkdirSync(dirname(preflightTarget), { recursive: true });
        writeFileSync(preflightTarget, CODEX_AGENT_CATALOG[0].expectedBytes);
        await expectMaterializerError(localMaterializer(preflightProject, faultFileSystem({
            readFile: () => {
                throw errno('EIO');
            },
        })).get(preflightProject), 'agent_materialization_io_failed');
        const postCreateProject = gitProject();
        const postCreateError = await expectMaterializerError(localMaterializer(postCreateProject, faultFileSystem({
            readFile: () => {
                throw errno('EIO');
            },
        })).set(postCreateProject, 'present'), 'agent_materialization_partial');
        assertPartialError(postCreateError, 'present', 'agent_materialization_io_failed', [CODEX_AGENT_CATALOG[0].targetPath], ['unknown', 'absent']);
        const postflightProject = gitProject();
        let postflightReadCount = 0;
        const postflightError = await expectMaterializerError(localMaterializer(postflightProject, faultFileSystem({
            readFile: (path) => {
                postflightReadCount += 1;
                if (postflightReadCount === 3)
                    throw errno('EIO');
                return realFileSystem.readFile(path);
            },
        })).set(postflightProject, 'present'), 'agent_materialization_partial');
        assertPartialError(postflightError, 'present', 'agent_materialization_io_failed', CODEX_AGENT_CATALOG.map((entry) => entry.targetPath), ['current', 'current']);
        const removeProject = gitProject();
        await localMaterializer(removeProject).set(removeProject, 'present');
        let removeReadCount = 0;
        const removeError = await expectMaterializerError(localMaterializer(removeProject, faultFileSystem({
            readFile: (path) => {
                removeReadCount += 1;
                if (removeReadCount === 4)
                    throw errno('EIO');
                return realFileSystem.readFile(path);
            },
        })).set(removeProject, 'absent'), 'agent_materialization_partial');
        assertPartialError(removeError, 'absent', 'agent_materialization_io_failed', [CODEX_AGENT_CATALOG[0].targetPath], ['absent', 'current']);
    });
    it('uses the generic I/O cause when postflight is mixed without a specific error', async () => {
        const project = gitProject();
        let secondTargetLstatCount = 0;
        const secondTarget = join(realpathSync(project), CODEX_AGENT_CATALOG[1].targetPath);
        const fs = faultFileSystem({
            lstat: (path) => {
                if (path === secondTarget) {
                    secondTargetLstatCount += 1;
                    if (secondTargetLstatCount === 3)
                        throw errno('ENOENT');
                }
                return realFileSystem.lstat(path);
            },
        });
        const error = await expectMaterializerError(localMaterializer(project, fs).set(project, 'present'), 'agent_materialization_partial');
        assertPartialError(error, 'present', 'agent_materialization_io_failed', CODEX_AGENT_CATALOG.map((entry) => entry.targetPath), ['current', 'current']);
    });
    it('treats open success as the mutation point for short-write and close failures', async () => {
        for (const failure of ['write', 'close']) {
            const project = gitProject();
            mkdirSync(join(project, '.codex', 'agents'), { recursive: true });
            let failed = false;
            const fs = faultFileSystem(failure === 'write'
                ? {
                    write: (fd, bytes) => {
                        if (!failed) {
                            failed = true;
                            return 0;
                        }
                        return realFileSystem.write(fd, bytes);
                    },
                }
                : {
                    close: (fd) => {
                        realFileSystem.close(fd);
                        if (!failed) {
                            failed = true;
                            throw errno('EIO');
                        }
                    },
                });
            const error = await expectMaterializerError(localMaterializer(project, fs).set(project, 'present'), 'agent_materialization_partial');
            assertPartialError(error, 'present', 'agent_materialization_io_failed', [CODEX_AGENT_CATALOG[0].targetPath], [failure === 'write' ? 'conflict' : 'current', 'absent']);
        }
    });
    it('reports post-write byte corruption as partial conflict', async () => {
        const project = gitProject();
        mkdirSync(join(project, '.codex', 'agents'), { recursive: true });
        let corrupted = false;
        const fs = faultFileSystem({
            write: (fd, bytes) => {
                if (!corrupted) {
                    corrupted = true;
                    realFileSystem.write(fd, Buffer.from('x'));
                    return bytes.length;
                }
                return realFileSystem.write(fd, bytes);
            },
        });
        const error = await expectMaterializerError(localMaterializer(project, fs).set(project, 'present'), 'agent_materialization_partial');
        assertPartialError(error, 'present', 'agent_materialization_conflict', [CODEX_AGENT_CATALOG[0].targetPath], ['conflict', 'absent']);
    });
    it('handles create races without overwriting the competing target', async () => {
        for (const race of ['current', 'conflict']) {
            const project = gitProject();
            mkdirSync(join(project, '.codex', 'agents'), { recursive: true });
            let raced = false;
            const fs = faultFileSystem({
                openExclusive: (path) => {
                    if (!raced) {
                        raced = true;
                        writeFileSync(path, race === 'current'
                            ? CODEX_AGENT_CATALOG[0].expectedBytes
                            : 'name = "competing-user-agent"\n');
                        throw errno('EEXIST');
                    }
                    return realFileSystem.openExclusive(path);
                },
            });
            if (race === 'current') {
                const result = await localMaterializer(project, fs).set(project, 'present');
                assert.deepEqual(result.changed, [CODEX_AGENT_CATALOG[1].targetPath]);
                assert.deepEqual(result.unchanged, [CODEX_AGENT_CATALOG[0].targetPath]);
            }
            else {
                await expectMaterializerError(localMaterializer(project, fs).set(project, 'present'), 'agent_materialization_conflict');
                assert.equal(readFileSync(join(project, CODEX_AGENT_CATALOG[0].targetPath), 'utf8'), 'name = "competing-user-agent"\n');
            }
        }
    });
    it('preserves the original cause when the second create races after mutation', async () => {
        for (const race of ['conflict', 'unsafe']) {
            const project = gitProject();
            mkdirSync(join(project, '.codex', 'agents'), { recursive: true });
            let openCount = 0;
            const fs = faultFileSystem({
                openExclusive: (path) => {
                    openCount += 1;
                    if (openCount === 2) {
                        if (race === 'conflict')
                            writeFileSync(path, 'name = "competitor"\n');
                        else
                            mkdirSync(path);
                        throw errno('EEXIST');
                    }
                    return realFileSystem.openExclusive(path);
                },
            });
            const error = await expectMaterializerError(localMaterializer(project, fs).set(project, 'present'), 'agent_materialization_partial');
            assertPartialError(error, 'present', race === 'conflict'
                ? 'agent_materialization_conflict'
                : 'unsafe_codex_agents_path', [CODEX_AGENT_CATALOG[0].targetPath], ['current', race === 'conflict' ? 'conflict' : 'unknown']);
        }
    });
    it('reports partial create and remove failures after the first target changes', async () => {
        const createProject = gitProject();
        mkdirSync(join(createProject, '.codex', 'agents'), { recursive: true });
        let openCount = 0;
        const createFs = faultFileSystem({
            openExclusive: (path) => {
                openCount += 1;
                if (openCount === 2)
                    throw errno('EACCES');
                return realFileSystem.openExclusive(path);
            },
        });
        const createError = await expectMaterializerError(localMaterializer(createProject, createFs).set(createProject, 'present'), 'agent_materialization_partial');
        assertPartialError(createError, 'present', 'agent_materialization_io_failed', [CODEX_AGENT_CATALOG[0].targetPath], ['current', 'absent']);
        const removeProject = gitProject();
        const normal = localMaterializer(removeProject);
        await normal.set(removeProject, 'present');
        let unlinkCount = 0;
        const removeFs = faultFileSystem({
            unlink: (path) => {
                unlinkCount += 1;
                if (unlinkCount === 2)
                    throw errno('EACCES');
                realFileSystem.unlink(path);
            },
        });
        const removeError = await expectMaterializerError(localMaterializer(removeProject, removeFs).set(removeProject, 'absent'), 'agent_materialization_partial');
        assertPartialError(removeError, 'absent', 'agent_materialization_io_failed', [CODEX_AGENT_CATALOG[0].targetPath], ['absent', 'current']);
        const recovered = await normal.set(removeProject, 'absent');
        assert.deepEqual(recovered.changed, [CODEX_AGENT_CATALOG[1].targetPath]);
        assert.deepEqual(recovered.unchanged, [CODEX_AGENT_CATALOG[0].targetPath]);
    });
    it('converges simultaneous same-state calls without duplicate targets', async () => {
        const project = gitProject();
        const first = new CodexAgentMaterializer();
        const second = new CodexAgentMaterializer();
        const results = await Promise.all([
            first.set(project, 'present'),
            second.set(project, 'present'),
        ]);
        assert.equal(results.reduce((sum, result) => sum + result.changed.length, 0), 2);
        assert.deepEqual((await first.get(project)).agents.map((entry) => entry.status), ['current', 'current']);
    });
    it('converges a removal race that reports ENOENT after another remover wins', async () => {
        const project = gitProject();
        const materializer = localMaterializer(project);
        await materializer.set(project, 'present');
        const sentinel = join(project, '.codex', 'agents', 'sentinel.toml');
        writeFileSync(sentinel, 'name = "sentinel"\n');
        let raced = false;
        const racingMaterializer = localMaterializer(project, faultFileSystem({
            unlink: (path) => {
                if (!raced) {
                    raced = true;
                    realFileSystem.unlink(path);
                    throw errno('ENOENT');
                }
                realFileSystem.unlink(path);
            },
        }));
        const result = await racingMaterializer.set(project, 'absent');
        assert.deepEqual(result.changed, [CODEX_AGENT_CATALOG[1].targetPath]);
        assert.deepEqual(result.unchanged, [CODEX_AGENT_CATALOG[0].targetPath]);
        assert.deepEqual((await materializer.get(project)).agents.map((entry) => entry.status), ['absent', 'absent']);
        assert.equal(readFileSync(sentinel, 'utf8'), 'name = "sentinel"\n');
    });
});
describe('Scope 4 tool and root contracts', () => {
    it('reuses the read-only root validator without creating project state', async () => {
        const project = gitProject();
        const canonical = await validateCodexProjectRoot(project);
        assert.equal(canonical, realpathSync(project));
        assert.equal(existsSync(join(project, '.tmb')), false);
        for (const simulated of [
            { args: ['rev-parse'], code: 'project_root_not_git_toplevel' },
            { args: ['check-ignore'], code: 'project_state_not_ignored' },
            { args: ['ls-files'], code: 'project_state_not_ignored' },
        ]) {
            await assert.rejects(validateCodexProjectRoot(project, {
                runGit: async (_cwd, args) => {
                    if (args[0] === simulated.args[0])
                        return { ok: false, stdout: '' };
                    if (args[0] === 'rev-parse')
                        return { ok: true, stdout: canonical };
                    return { ok: true, stdout: '' };
                },
            }), (error) => error.code === simulated.code);
        }
        assert.equal(existsSync(join(project, '.tmb')), false);
        assert.equal(existsSync(join(project, '.codex')), false);
    });
    it('returns the full getter root-error matrix without creating state', async () => {
        const project = gitProject();
        const nested = join(project, 'nested');
        mkdirSync(nested);
        const nonGit = tempDirectory('tmb-codex-agent-nongit-');
        const missing = join(nonGit, 'missing');
        const file = join(nonGit, 'file');
        writeFileSync(file, 'not a directory');
        const unignored = tempDirectory('tmb-codex-agent-unignored-');
        execFileSync('git', ['init', '--quiet', unignored]);
        const unsafeNonGit = tempDirectory('tmb-codex-agent-root-first-');
        const unsafeOutside = tempDirectory('tmb-codex-agent-root-outside-');
        symlinkSync(unsafeOutside, join(unsafeNonGit, '.codex'));
        const tracked = gitProject();
        const trackedState = join(tracked, '.tmb', 'tmb', 'tracked.txt');
        mkdirSync(dirname(trackedState), { recursive: true });
        writeFileSync(trackedState, 'preserve me');
        execFileSync('git', ['-C', tracked, 'add', '--force', trackedState]);
        const runtimeManager = manager();
        try {
            const registry = createCodexToolRegistry(runtimeManager);
            for (const fixture of [
                { root: missing, code: 'project_root_not_found' },
                { root: file, code: 'project_root_not_directory' },
                { root: nonGit, code: 'project_root_not_git_toplevel' },
                {
                    root: unsafeNonGit,
                    code: 'project_root_not_git_toplevel',
                    codexExistsBefore: true,
                },
                { root: nested, code: 'project_root_not_git_toplevel' },
                { root: unignored, code: 'project_state_not_ignored' },
                { root: tracked, code: 'project_state_not_ignored' },
            ]) {
                const result = await registry.call('agent_materialization_get', {
                    project_root: fixture.root,
                });
                assert.equal(errorCode(result), fixture.code, fixture.root);
                assert.equal(existsSync(join(fixture.root, '.codex')), 'codexExistsBefore' in fixture ? fixture.codexExistsBefore : false);
            }
            assert.equal(existsSync(join(project, '.tmb')), false);
            assert.equal(existsSync(join(nonGit, '.tmb')), false);
            assert.equal(lstatSync(join(unsafeNonGit, '.codex')).isSymbolicLink(), true);
            assert.equal(existsSync(join(unignored, '.tmb')), false);
            assert.equal(readFileSync(trackedState, 'utf8'), 'preserve me');
        }
        finally {
            runtimeManager.close();
        }
    });
    it('exposes exactly 15 tools with deterministic schema and error precedence', async () => {
        const project = gitProject();
        const runtimeManager = manager();
        try {
            const registry = createCodexToolRegistry(runtimeManager);
            assert.deepEqual(Object.keys(registry.handlers), CODEX_SCOPE_4_TOOL_NAMES);
            assert.deepEqual(registry.definitions.map((entry) => entry.name), CODEX_SCOPE_4_TOOL_NAMES);
            assert.equal(registry.definitions.length, 15);
            const getter = registry.definitions.find((entry) => entry.name === 'agent_materialization_get');
            assert.deepEqual(getter.inputSchema.required, ['project_root']);
            assert.equal(getter.inputSchema.additionalProperties, false);
            assert.equal(getter.annotations?.readOnlyHint, true);
            assert.equal(getter.annotations?.idempotentHint, true);
            const setter = registry.definitions.find((entry) => entry.name === 'agent_materialization_set');
            assert.deepEqual(setter.inputSchema.required, ['project_root', 'desired_state']);
            assert.equal(setter.annotations?.destructiveHint, true);
            assert.equal(setter.annotations?.idempotentHint, true);
            const missing = await registry.call('agent_materialization_set', {
                desired_state: 'wrong',
            });
            assert.equal(errorCode(missing), 'missing_project_root');
            const identityFirst = await registry.call('agent_materialization_set', {
                project_root: 'relative',
                desired_state: 'wrong',
                unexpected: true,
                provenance: 'human',
            });
            assert.equal(errorCode(identityFirst), 'unsupported_identity_claim');
            const invalidBeforeRoot = await registry.call('agent_materialization_set', {
                project_root: 'relative',
                desired_state: 'wrong',
            });
            assert.equal(errorCode(invalidBeforeRoot), 'invalid_arguments');
            const relative = await registry.call('agent_materialization_get', {
                project_root: 'relative',
            });
            assert.equal(errorCode(relative), 'project_root_not_absolute');
            const unknownField = await registry.call('agent_materialization_get', {
                project_root: project,
                target_path: '.codex/agents/user.toml',
            });
            assert.equal(errorCode(unknownField), 'invalid_arguments');
            assert.equal(existsSync(join(project, '.tmb')), false);
            assert.equal(existsSync(join(project, '.codex')), false);
        }
        finally {
            runtimeManager.close();
        }
    });
});
function gitProject() {
    const project = tempDirectory('tmb-codex-agent-project-');
    execFileSync('git', ['init', '--quiet', project]);
    writeFileSync(join(project, '.gitignore'), '.tmb/\n');
    writeFileSync(join(project, 'README.md'), '# Fixture\n');
    execFileSync('git', [
        '-C',
        project,
        '-c',
        'user.name=Codex Agent Test',
        '-c',
        'user.email=codex-agent@example.com',
        'add',
        '.gitignore',
        'README.md',
    ]);
    execFileSync('git', [
        '-C',
        project,
        '-c',
        'user.name=Codex Agent Test',
        '-c',
        'user.email=codex-agent@example.com',
        'commit',
        '--quiet',
        '-m',
        'fixture',
    ]);
    return project;
}
function tempDirectory(prefix) {
    const path = mkdtempSync(join(tmpdir(), prefix));
    cleanup.push(path);
    return path;
}
function localMaterializer(project, fileSystem = realFileSystem) {
    return new CodexAgentMaterializer({
        fileSystem,
        validateProjectRoot: async () => realpathSync(project),
    });
}
function faultFileSystem(overrides) {
    return { ...realFileSystem, ...overrides };
}
function errno(code) {
    return Object.assign(new Error(`injected ${code}`), { code });
}
async function expectMaterializerError(promise, code) {
    try {
        await promise;
    }
    catch (error) {
        assert.ok(error instanceof CodexAgentMaterializationError);
        assert.equal(error.code, code);
        return error;
    }
    assert.fail(`Expected materializer error: ${code}`);
}
function assertPartialError(error, desiredState, causeCode, changed, statuses) {
    assert.equal(error.code, 'agent_materialization_partial');
    assert.equal(error.details?.['desired_state'], desiredState);
    assert.equal(error.details?.['cause_code'], causeCode);
    assert.deepEqual(error.details?.['changed'], changed);
    assert.deepEqual((error.details?.['agents']).map((entry) => entry.status), statuses);
    assert.equal(error.details?.['restart_required'], true);
}
function manager() {
    const testFile = fileURLToPath(import.meta.url);
    const sourceDist = dirname(dirname(testFile));
    const sourceRoot = dirname(dirname(dirname(sourceDist)));
    return new CodexRuntimeManager({
        plugin: {
            root: sourceRoot,
            name: 'tmb',
            version: '1.0.2',
        },
    });
}
function errorCode(result) {
    const content = result.content[0];
    assert.equal(content?.type, 'text');
    if (!content || content.type !== 'text' || content.text === undefined) {
        throw new Error('Expected text MCP result');
    }
    return JSON.parse(content.text).error.code;
}
//# sourceMappingURL=codex-agent-materializer.test.js.map