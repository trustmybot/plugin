import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
const execFileAsync = promisify(execFile);
const TEXT_EXTENSIONS = new Set([
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
    'json', 'yaml', 'yml', 'toml', 'env',
    'md', 'mdx', 'txt', 'rst',
    'sql', 'graphql', 'gql',
    'sh', 'bash', 'zsh', 'fish',
    'css', 'scss', 'sass', 'less',
    'html', 'htm', 'xml', 'svg',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp',
    'lock', 'gitignore', 'gitattributes',
]);
function extOf(filePath) {
    const dot = filePath.lastIndexOf('.');
    if (dot < 0)
        return '';
    return filePath.slice(dot + 1).toLowerCase();
}
async function hasBinaryBytes(filePath, cwd) {
    try {
        const abs = filePath.startsWith('/') ? filePath : `${cwd}/${filePath}`;
        const buf = Buffer.alloc(512);
        const { createReadStream } = await import('node:fs');
        return new Promise((resolve) => {
            const stream = createReadStream(abs, { start: 0, end: 511 });
            const chunks = [];
            stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            stream.on('end', () => {
                const data = Buffer.concat(chunks, Math.min(512, chunks.reduce((s, c) => s + c.length, 0)));
                for (let i = 0; i < data.length; i++) {
                    if (data[i] === 0) {
                        resolve(true);
                        return;
                    }
                }
                resolve(false);
            });
            stream.on('error', () => resolve(false));
            void buf;
        });
    }
    catch {
        return false;
    }
}
export async function isBinaryFile(filePath, cwd) {
    const ext = extOf(filePath);
    if (ext && TEXT_EXTENSIONS.has(ext))
        return false;
    return hasBinaryBytes(filePath, cwd);
}
export async function getHeadSha(opts) {
    try {
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: opts.cwd });
        return stdout.trim();
    }
    catch {
        return '';
    }
}
export async function listAllFiles(opts) {
    try {
        const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: opts.cwd });
        return stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    }
    catch {
        return [];
    }
}
export async function getDeltaSince(opts, sinceSha, sinceDate) {
    const args = ['log', '--name-status', '--pretty=format:', '--diff-filter=ADMR'];
    if (sinceSha) {
        args.push(`${sinceSha}..HEAD`);
    }
    else if (sinceDate) {
        args.push(`--since=${sinceDate}`);
    }
    else {
        args.push('HEAD');
    }
    try {
        const { stdout } = await execFileAsync('git', args, { cwd: opts.cwd });
        const lines = stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const delta = [];
        const seen = new Set();
        for (const line of lines) {
            const parts = line.split('\t');
            if (parts.length < 2)
                continue;
            const statusChar = parts[0][0];
            if (!['A', 'M', 'D', 'R'].includes(statusChar))
                continue;
            if (statusChar === 'R' && parts.length >= 3) {
                const newPath = parts[2];
                const oldPath = parts[1];
                if (!seen.has(newPath)) {
                    seen.add(newPath);
                    delta.push({ path: oldPath, status: 'R', newPath });
                }
            }
            else {
                const filePath = parts[1];
                if (!seen.has(filePath)) {
                    seen.add(filePath);
                    delta.push({ path: filePath, status: statusChar });
                }
            }
        }
        return delta;
    }
    catch {
        return [];
    }
}
export async function getFileCommitInfo(filePath, opts) {
    try {
        const { stdout } = await execFileAsync('git', ['log', '-1', '--pretty=format:%H|%aI', '--', filePath], { cwd: opts.cwd });
        const trimmed = stdout.trim();
        if (!trimmed)
            return null;
        const [sha, date] = trimmed.split('|');
        return { sha: sha ?? '', date: date ?? '' };
    }
    catch {
        return null;
    }
}
export async function getFileSize(filePath, cwd) {
    try {
        const abs = filePath.startsWith('/') ? filePath : `${cwd}/${filePath}`;
        const data = await readFile(abs);
        return data.length;
    }
    catch {
        return null;
    }
}
export async function readFileText(filePath, cwd) {
    try {
        const abs = filePath.startsWith('/') ? filePath : `${cwd}/${filePath}`;
        return await readFile(abs, 'utf8');
    }
    catch {
        return null;
    }
}
const SOURCE_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']);
const TEST_PATH_RE = /(?:^|\/)(?:test|tests|__tests__|spec)\//;
const TEST_SUFFIX_RE = /\.(?:test|spec)\.[a-z]+$/;
const CONFIG_NAMES = new Set([
    'package.json', 'tsconfig.json', 'tsconfig.build.json', '.eslintrc.json', '.eslintrc.js',
    '.babelrc', 'jest.config.js', 'jest.config.ts', 'vite.config.ts', 'vite.config.js',
    'rollup.config.js', 'webpack.config.js', '.prettierrc', 'Makefile', 'Dockerfile',
]);
const CONFIG_EXTS = new Set(['yaml', 'yml', 'toml', 'env', 'lock', 'gitignore', 'gitattributes']);
const DOC_EXTS = new Set(['md', 'mdx', 'txt', 'rst']);
export function classifyFile(filePath) {
    const filename = filePath.split('/').pop() ?? filePath;
    const ext = extOf(filePath);
    if (DOC_EXTS.has(ext))
        return 'doc';
    if (CONFIG_EXTS.has(ext))
        return 'config';
    if (CONFIG_NAMES.has(filename))
        return 'config';
    if (!SOURCE_EXTS.has(ext))
        return 'unknown';
    if (TEST_PATH_RE.test(filePath) || TEST_SUFFIX_RE.test(filePath))
        return 'test';
    return 'source';
}
export function detectLanguage(filePath) {
    const ext = extOf(filePath);
    const map = {
        ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
        py: 'py', rb: 'rb', go: 'go', rs: 'rs', java: 'java', kt: 'kt',
        swift: 'swift', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
        sql: 'sql', graphql: 'graphql', gql: 'graphql',
        sh: 'sh', bash: 'sh', zsh: 'sh', fish: 'fish',
    };
    return map[ext] ?? null;
}
export async function getGitLogEntries(opts, sinceSha, sinceDate) {
    const args = ['log', '--pretty=format:COMMIT|%H|%an|%aI|%s|%b', '--name-only'];
    if (sinceSha) {
        args.push(`${sinceSha}..HEAD`);
    }
    else if (sinceDate) {
        args.push(`--since=${sinceDate}`);
    }
    try {
        const { stdout } = await execFileAsync('git', args, { cwd: opts.cwd });
        const lines = stdout.split('\n');
        const entries = [];
        let current = null;
        const bodyLines = [];
        for (const rawLine of lines) {
            const line = rawLine.trimEnd();
            if (line.startsWith('COMMIT|')) {
                if (current) {
                    current.body = bodyLines.join('\n').trim();
                    entries.push(current);
                }
                bodyLines.length = 0;
                const parts = line.split('|');
                current = {
                    sha: parts[1] ?? '',
                    author: parts[2] ?? '',
                    date: parts[3] ?? '',
                    subject: parts[4] ?? '',
                    body: '',
                    filesChanged: [],
                };
            }
            else if (current && line.trim().length > 0 && !line.startsWith('COMMIT|')) {
                if (line.includes('/') || (line.length > 0 && !line.startsWith(' '))) {
                    current.filesChanged.push(line.trim());
                }
                else {
                    bodyLines.push(line);
                }
            }
        }
        if (current) {
            current.body = bodyLines.join('\n').trim();
            entries.push(current);
        }
        return entries;
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=git-walker.js.map