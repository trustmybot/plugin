import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync, } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { CODEX_AGENT_CATALOG, CODEX_AGENT_TEMPLATE_SET_VERSION, sha256, } from './codex-agent-catalog.js';
import { validateCodexProjectRoot } from './codex-runtime.js';
const DEFAULT_FILE_SYSTEM = Object.freeze({
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
});
export class CodexAgentMaterializationError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'CodexAgentMaterializationError';
    }
}
export class CodexAgentMaterializer {
    fs;
    validateProjectRoot;
    constructor(options = {}) {
        this.fs = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
        this.validateProjectRoot =
            options.validateProjectRoot ?? validateCodexProjectRoot;
    }
    async get(projectRootInput) {
        const projectRoot = await this.validateProjectRoot(projectRootInput);
        const inspections = inspectAll(projectRoot, this.fs);
        return getResult(projectRoot, inspections);
    }
    async set(projectRootInput, desiredState) {
        const projectRoot = await this.validateProjectRoot(projectRootInput);
        const preflight = inspectAll(projectRoot, this.fs);
        const conflicts = preflight.filter((entry) => entry.status === 'conflict');
        if (conflicts.length > 0)
            throw conflictError(conflicts);
        const changed = [];
        const unchanged = [];
        try {
            if (desiredState === 'present') {
                ensureAgentDirectory(projectRoot, this.fs);
                for (const template of CODEX_AGENT_CATALOG) {
                    const before = preflight.find((entry) => entry.template.agentId === template.agentId);
                    if (before.status === 'current') {
                        unchanged.push(template.targetPath);
                        continue;
                    }
                    const outcome = createTarget(projectRoot, template, this.fs, changed);
                    if (outcome === 'unchanged')
                        unchanged.push(template.targetPath);
                }
            }
            else {
                for (const template of CODEX_AGENT_CATALOG) {
                    const before = preflight.find((entry) => entry.template.agentId === template.agentId);
                    if (before.status === 'absent') {
                        unchanged.push(template.targetPath);
                        continue;
                    }
                    const outcome = removeTarget(projectRoot, template, this.fs, changed);
                    if (outcome === 'unchanged')
                        unchanged.push(template.targetPath);
                }
            }
            const final = inspectAll(projectRoot, this.fs);
            const converged = final.every((entry) => desiredState === 'present'
                ? entry.status === 'current'
                : entry.status === 'absent');
            if (!converged) {
                const cause = final.some((entry) => entry.status === 'conflict')
                    ? conflictError(final.filter((entry) => entry.status === 'conflict'))
                    : ioError('Agent targets did not converge after the operation.');
                throw cause;
            }
            const coverage = new Set([...changed, ...unchanged]);
            if (coverage.size !== CODEX_AGENT_CATALOG.length) {
                throw ioError('Agent materialization result did not cover every catalog target.');
            }
            return Object.freeze({
                project_root: projectRoot,
                desired_state: desiredState,
                changed: Object.freeze([...changed]),
                unchanged: Object.freeze([...unchanged]),
                overall_status: desiredState === 'present' ? 'current' : 'absent',
                restart_required: changed.length > 0,
            });
        }
        catch (error) {
            throw materializationFailure(error, projectRoot, desiredState, changed, this.fs);
        }
    }
}
function layoutFor(projectRoot) {
    return {
        projectRoot,
        codexDir: join(projectRoot, '.codex'),
        agentsDir: join(projectRoot, '.codex', 'agents'),
    };
}
function inspectAll(projectRoot, fs) {
    const layout = layoutFor(projectRoot);
    const codexExists = inspectDirectory(layout.codexDir, layout.projectRoot, fs);
    if (!codexExists)
        return absentInspections();
    const agentsExists = inspectDirectory(layout.agentsDir, layout.projectRoot, fs);
    if (!agentsExists)
        return absentInspections();
    const fileKinds = CODEX_AGENT_CATALOG.map((template) => {
        const absolutePath = targetPath(layout, template);
        return {
            template,
            absolutePath,
            stat: inspectRegularTarget(absolutePath, projectRoot, fs),
        };
    });
    const inspections = [];
    let firstReadError;
    for (const target of fileKinds) {
        if (target.stat === undefined) {
            inspections.push({
                template: target.template,
                status: 'absent',
            });
            continue;
        }
        if (target.stat.size !== target.template.expectedBytes.length) {
            inspections.push({
                template: target.template,
                status: 'conflict',
            });
            continue;
        }
        try {
            const bytes = fs.readFile(target.absolutePath);
            const current = bytes.equals(target.template.expectedBytes);
            inspections.push({
                template: target.template,
                status: current ? 'current' : 'conflict',
                ...(current ? { currentContentSha256: sha256(bytes) } : {}),
            });
        }
        catch (error) {
            firstReadError ??= error;
        }
    }
    if (firstReadError !== undefined) {
        const conflicts = inspections.filter((entry) => entry.status === 'conflict');
        if (conflicts.length > 0)
            throw conflictError(conflicts);
        throw ioError('A managed Agent target could not be read.', firstReadError);
    }
    return inspections;
}
function absentInspections() {
    return CODEX_AGENT_CATALOG.map((template) => ({
        template,
        status: 'absent',
    }));
}
function inspectDirectory(path, projectRoot, fs) {
    let stat;
    try {
        stat = fs.lstat(path);
    }
    catch (error) {
        if (isMissing(error))
            return false;
        throw unsafePathError(projectRoot, path, 'could not be inspected');
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw unsafePathError(projectRoot, path, 'must be a real directory');
    }
    let canonical;
    try {
        canonical = fs.realpath(path);
    }
    catch {
        throw unsafePathError(projectRoot, path, 'could not be canonicalized');
    }
    if (!isWithin(projectRoot, canonical) || canonical !== path) {
        throw unsafePathError(projectRoot, path, 'resolves outside the canonical project path');
    }
    return true;
}
function inspectRegularTarget(path, projectRoot, fs) {
    let stat;
    try {
        stat = fs.lstat(path);
    }
    catch (error) {
        if (isMissing(error))
            return undefined;
        throw unsafePathError(projectRoot, path, 'could not be inspected');
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw unsafePathError(projectRoot, path, 'must be a regular file');
    }
    return stat;
}
function ensureAgentDirectory(projectRoot, fs) {
    const layout = layoutFor(projectRoot);
    ensureDirectory(layout.codexDir, layout.projectRoot, fs);
    ensureDirectory(layout.agentsDir, layout.projectRoot, fs);
    assertSafeParents(layout, fs);
}
function ensureDirectory(path, projectRoot, fs) {
    if (inspectDirectoryIfPresent(path, projectRoot, fs))
        return;
    try {
        fs.mkdir(path);
    }
    catch (error) {
        if (!isAlreadyExists(error)) {
            throw ioError(`Could not create ${relative(projectRoot, path)}.`, error);
        }
    }
    if (!inspectDirectoryIfPresent(path, projectRoot, fs)) {
        throw ioError(`Directory creation did not materialize ${relative(projectRoot, path)}.`);
    }
}
function inspectDirectoryIfPresent(path, projectRoot, fs) {
    return inspectDirectory(path, projectRoot, fs);
}
function assertSafeParents(layout, fs) {
    if (!inspectDirectory(layout.codexDir, layout.projectRoot, fs) ||
        !inspectDirectory(layout.agentsDir, layout.projectRoot, fs)) {
        throw unsafePathError(layout.projectRoot, layout.agentsDir, 'is not a stable directory path');
    }
}
function createTarget(projectRoot, template, fs, changed) {
    const layout = layoutFor(projectRoot);
    assertSafeParents(layout, fs);
    const absolutePath = targetPath(layout, template);
    const before = inspectOne(projectRoot, template, absolutePath, fs);
    if (before.status === 'current')
        return 'unchanged';
    if (before.status === 'conflict')
        throw conflictError([before]);
    let fd;
    try {
        fd = fs.openExclusive(absolutePath);
    }
    catch (error) {
        if (isAlreadyExists(error)) {
            const raced = inspectOne(projectRoot, template, absolutePath, fs);
            if (raced.status === 'current')
                return 'unchanged';
            if (raced.status === 'conflict')
                throw conflictError([raced]);
            throw ioError(`Agent target disappeared during create: ${template.targetPath}.`);
        }
        throw ioError(`Could not create ${template.targetPath}.`, error);
    }
    changed.push(template.targetPath);
    let failure;
    try {
        const written = fs.write(fd, template.expectedBytes);
        if (written !== template.expectedBytes.length) {
            throw new Error(`Short write: expected ${template.expectedBytes.length} bytes, wrote ${written}.`);
        }
    }
    catch (error) {
        failure = error;
    }
    try {
        fs.close(fd);
    }
    catch (error) {
        failure ??= error;
    }
    if (failure !== undefined) {
        throw ioError(`Could not finish writing ${template.targetPath}.`, failure);
    }
    const final = inspectOne(projectRoot, template, absolutePath, fs);
    if (final.status !== 'current') {
        throw final.status === 'conflict'
            ? conflictError([final])
            : ioError(`Agent target vanished after create: ${template.targetPath}.`);
    }
    return 'changed';
}
function removeTarget(projectRoot, template, fs, changed) {
    const layout = layoutFor(projectRoot);
    if (!inspectDirectory(layout.codexDir, layout.projectRoot, fs) ||
        !inspectDirectory(layout.agentsDir, layout.projectRoot, fs)) {
        return 'unchanged';
    }
    assertSafeParents(layout, fs);
    const absolutePath = targetPath(layout, template);
    const before = inspectOne(projectRoot, template, absolutePath, fs);
    if (before.status === 'absent')
        return 'unchanged';
    if (before.status === 'conflict')
        throw conflictError([before]);
    try {
        fs.unlink(absolutePath);
    }
    catch (error) {
        if (isMissing(error))
            return 'unchanged';
        throw ioError(`Could not remove ${template.targetPath}.`, error);
    }
    changed.push(template.targetPath);
    return 'changed';
}
function inspectOne(projectRoot, template, absolutePath, fs) {
    const stat = inspectRegularTarget(absolutePath, projectRoot, fs);
    if (stat === undefined) {
        return { template, status: 'absent' };
    }
    if (stat.size !== template.expectedBytes.length) {
        return { template, status: 'conflict' };
    }
    let bytes;
    try {
        bytes = fs.readFile(absolutePath);
    }
    catch (error) {
        throw ioError(`Could not read ${template.targetPath}.`, error);
    }
    const current = bytes.equals(template.expectedBytes);
    return {
        template,
        status: current ? 'current' : 'conflict',
        ...(current ? { currentContentSha256: sha256(bytes) } : {}),
    };
}
function targetPath(layout, template) {
    const path = join(layout.projectRoot, template.targetPath);
    if (!isWithin(layout.agentsDir, path) || dirname(path) !== layout.agentsDir) {
        throw unsafePathError(layout.projectRoot, path, 'is outside the fixed Agent directory');
    }
    return path;
}
function isWithin(parent, child) {
    if (!isAbsolute(parent) || !isAbsolute(child))
        return false;
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
function getResult(projectRoot, inspections) {
    return Object.freeze({
        project_root: projectRoot,
        template_set_version: CODEX_AGENT_TEMPLATE_SET_VERSION,
        overall_status: overallStatus(inspections),
        agents: Object.freeze(inspections.map(publicEntry)),
    });
}
function publicEntry(inspection) {
    return Object.freeze({
        agent_id: inspection.template.agentId,
        target_path: inspection.template.targetPath,
        status: inspection.status,
        expected_template_version: inspection.template.templateVersion,
        expected_body_sha256: inspection.template.bodySha256,
        ...(inspection.status === 'current'
            ? { current_content_sha256: inspection.currentContentSha256 }
            : {}),
        ...(inspection.status === 'conflict'
            ? { conflict_reason: 'content_mismatch' }
            : {}),
    });
}
function overallStatus(inspections) {
    if (inspections.some((entry) => entry.status === 'conflict'))
        return 'conflict';
    if (inspections.every((entry) => entry.status === 'current'))
        return 'current';
    if (inspections.every((entry) => entry.status === 'absent'))
        return 'absent';
    return 'mixed';
}
function conflictError(inspections) {
    return new CodexAgentMaterializationError('agent_materialization_conflict', 'A managed Agent target conflicts with the current template.', {
        conflicts: inspections.map((entry) => ({
            agent_id: entry.template.agentId,
            target_path: entry.template.targetPath,
            reason: 'content_mismatch',
        })),
    });
}
function unsafePathError(projectRoot, path, reason) {
    return new CodexAgentMaterializationError('unsafe_codex_agents_path', 'The project Codex Agent path could not be verified safely.', { target_path: relative(projectRoot, path) || '.', reason });
}
function ioError(message, cause) {
    const osErrorCode = cause?.code;
    return new CodexAgentMaterializationError('agent_materialization_io_failed', message, typeof osErrorCode === 'string' ? { os_error_code: osErrorCode } : undefined);
}
function materializationFailure(error, projectRoot, desiredState, changed, fs) {
    const cause = error instanceof CodexAgentMaterializationError
        ? error
        : ioError('Agent materialization failed.', error);
    if (changed.length === 0)
        return cause;
    return new CodexAgentMaterializationError('agent_materialization_partial', 'Agent targets did not converge after one target changed.', {
        desired_state: desiredState,
        cause_code: cause.code,
        changed: [...changed],
        agents: finalAgentStates(projectRoot, fs),
        restart_required: true,
    });
}
function finalAgentStates(projectRoot, fs) {
    const layout = layoutFor(projectRoot);
    return CODEX_AGENT_CATALOG.map((template) => {
        try {
            if (!inspectDirectory(layout.codexDir, layout.projectRoot, fs) ||
                !inspectDirectory(layout.agentsDir, layout.projectRoot, fs)) {
                return partialEntry(template, 'absent');
            }
            return partialEntry(template, inspectOne(projectRoot, template, targetPath(layout, template), fs).status);
        }
        catch {
            return partialEntry(template, 'unknown');
        }
    });
}
function partialEntry(template, status) {
    return {
        agent_id: template.agentId,
        target_path: template.targetPath,
        status,
    };
}
function isMissing(error) {
    return error.code === 'ENOENT';
}
function isAlreadyExists(error) {
    return error.code === 'EEXIST';
}
//# sourceMappingURL=codex-agent-materializer.js.map