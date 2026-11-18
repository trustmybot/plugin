// collectEnvEvidence: walks a repo read-only and returns, per package root, the manifests, lockfiles, configs, CI steps, runner targets and dev dependencies its files declare.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, posix } from 'node:path';
import { readCargoToml } from './readers/cargo-toml.js';
import { readActionsWorkflow, readGitlabCi } from './readers/ci.js';
import { readGoMod } from './readers/go-mod.js';
import { readJustfile, readMakefile, readTaskfile } from './readers/make.js';
import { readPackageJson } from './readers/package-json.js';
import { readPyproject } from './readers/pyproject.js';
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'target']);
const KEPT_DOT_DIRS = new Set(['.github']);
export const MAX_WALK_DEPTH = 4;
const MANIFESTS = new Set(['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'CMakeLists.txt']);
const LOCKFILE = /(\.lock|\.lockb|-lock\.json|-lock\.yaml)$|^go\.sum$/;
const ROOT_READERS = {
    'package.json': readPackageJson,
    'pyproject.toml': readPyproject,
    'Cargo.toml': readCargoToml,
    'go.mod': readGoMod,
    Makefile: readMakefile,
    makefile: readMakefile,
    GNUmakefile: readMakefile,
    justfile: readJustfile,
    Justfile: readJustfile,
    '.justfile': readJustfile,
    'Taskfile.yml': readTaskfile,
    'Taskfile.yaml': readTaskfile,
    'taskfile.yml': readTaskfile,
    'taskfile.yaml': readTaskfile,
};
const GITLAB_CI = '.gitlab-ci.yml';
const ACTIONS_WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
// The env reader for a repo-relative path: a CI file by its path (ci: its
// steps run from the repo root), else a manifest or task file by basename.
export function envReaderFor(path) {
    if (path === GITLAB_CI)
        return { reader: readGitlabCi, ci: true };
    if (ACTIONS_WORKFLOW.test(path))
        return { reader: readActionsWorkflow, ci: true };
    const reader = ROOT_READERS[posix.basename(path)];
    return reader ? { reader, ci: false } : null;
}
// Root files that are code, prose or assets rather than configuration.
const NON_CONFIG_EXTENSIONS = new Set([
    '.md', '.markdown', '.rst', '.adoc',
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.pdf',
    '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
    '.py', '.pyi', '.go', '.rs', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh',
    '.java', '.kt', '.swift', '.rb', '.php', '.cs', '.scala', '.lua',
    '.sh', '.bash', '.zsh', '.css', '.scss', '.html', '.sql',
]);
const PROSE_STEM = /^(readme|license|licence|copying|notice|authors|changelog|contributing|code_of_conduct|security)(\.|$)/i;
const SKIPPED_NAMES = new Set(['.DS_Store', '.gitignore', '.gitattributes']);
const SECRETS = /^\.env(\.|$)/;
const CONFIG_NAMED = /\.config\.[^.]+$|^\.[^.]+rc(\.[^.]+)?$/;
function isConfigName(name) {
    if (SKIPPED_NAMES.has(name) || SECRETS.test(name) || PROSE_STEM.test(name))
        return false;
    if (CONFIG_NAMED.test(name))
        return true;
    return !NON_CONFIG_EXTENSIONS.has(extname(name).toLowerCase());
}
function walk(root) {
    const files = [];
    const visit = (rel, depth) => {
        let entries;
        try {
            entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true });
        }
        catch {
            return;
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const e of entries) {
            const path = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && !KEPT_DOT_DIRS.has(e.name)))
                    continue;
                if (depth < MAX_WALK_DEPTH)
                    visit(path, depth + 1);
            }
            else if (e.isFile()) {
                files.push(path);
            }
        }
    };
    visit('', 0);
    return files;
}
function dirOf(path) {
    const d = posix.dirname(path);
    return d === '' ? '.' : d;
}
function within(dir, path) {
    return dir === '.' || path.startsWith(`${dir}/`);
}
function byText(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
function byLocation(a, b) {
    return byText(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0);
}
function readText(root, path) {
    try {
        return readFileSync(join(root, path), 'utf8');
    }
    catch {
        return null;
    }
}
function evidenceHash(root, paths) {
    const hash = createHash('sha256');
    for (const path of paths) {
        hash.update(`${path}\0`);
        try {
            hash.update(readFileSync(join(root, path)));
        }
        catch {
            hash.update('\0unreadable');
        }
        hash.update('\0');
    }
    return hash.digest('hex');
}
function packageEvidence(root, dir, files, owned) {
    const here = files.filter((f) => dirOf(f) === dir);
    const name = (f) => posix.basename(f);
    const manifests = here.filter((f) => MANIFESTS.has(name(f)));
    const lockfiles = here.filter((f) => LOCKFILE.test(name(f)));
    const ci = dir === '.' ? files.filter((f) => ACTIONS_WORKFLOW.test(f) || f === GITLAB_CI) : [];
    const special = new Set([...manifests, ...lockfiles, ...ci]);
    const config_files = here.filter((f) => !special.has(f) && isConfigName(name(f))).map((file) => ({ file }));
    const out = { config_files, ci_steps: [], runner_targets: [], dev_dependencies: [] };
    const merge = (r) => {
        out.config_files.push(...(r.config_files ?? []));
        out.ci_steps.push(...(r.ci_steps ?? []));
        out.runner_targets.push(...(r.runner_targets ?? []));
        out.dev_dependencies.push(...(r.dev_dependencies ?? []));
    };
    for (const f of here) {
        const reader = ROOT_READERS[name(f)];
        const text = reader ? readText(root, f) : null;
        if (reader && text !== null)
            merge(reader(f, text));
    }
    for (const f of ci) {
        const text = readText(root, f);
        if (text !== null)
            merge(envReaderFor(f).reader(f, text));
    }
    const extensions = {};
    const counts = new Map();
    for (const f of owned) {
        const ext = extname(name(f));
        if (ext)
            counts.set(ext, (counts.get(ext) ?? 0) + 1);
    }
    for (const ext of [...counts.keys()].sort(byText))
        extensions[ext] = counts.get(ext);
    const evidence_files = [...new Set([...special, ...out.config_files.map((c) => c.file)])].sort(byText);
    return {
        package_path: dir,
        manifests,
        lockfiles,
        config_files: out.config_files.sort(byLocation),
        ci_steps: out.ci_steps.sort(byLocation),
        runner_targets: out.runner_targets.sort((a, b) => byLocation(a, b) || byText(a.name, b.name)),
        dev_dependencies: out.dev_dependencies.sort((a, b) => byLocation(a, b) || byText(a.name, b.name)),
        extensions,
        evidence_files,
        evidence_hash: evidenceHash(root, evidence_files),
    };
}
export function collectEnvEvidence(root) {
    const files = walk(root);
    const roots = new Set(['.']);
    for (const f of files)
        if (MANIFESTS.has(posix.basename(f)))
            roots.add(dirOf(f));
    const dirs = [...roots].sort(byText);
    const depth = (d) => (d === '.' ? 0 : d.split('/').length);
    const deepest = [...dirs].sort((a, b) => depth(b) - depth(a));
    const owned = new Map(dirs.map((d) => [d, []]));
    for (const f of files)
        owned.get(deepest.find((d) => within(d, f))).push(f);
    return dirs.map((dir) => packageEvidence(root, dir, files, owned.get(dir)));
}
//# sourceMappingURL=collect.js.map