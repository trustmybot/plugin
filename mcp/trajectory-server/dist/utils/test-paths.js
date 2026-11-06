// Test or fixture paths (GH 2282): a test/tests/__tests__/fixtures segment, a
// .test./.spec./.suite. basename, or a schema-v<digits> segment or basename
// prefix.
const TEST_SEGMENTS = new Set(['test', 'tests', '__tests__', 'fixtures']);
const TEST_BASENAME_RE = /\.(?:test|spec|suite)\./;
const SCHEMA_RE = /^schema-v\d+/;
export function isTestPath(path) {
    const segments = path.replace(/\\/g, '/').split('/').filter(Boolean);
    const base = segments.at(-1) ?? '';
    const dirs = segments.slice(0, -1);
    if (dirs.some((s) => TEST_SEGMENTS.has(s) || SCHEMA_RE.test(s)))
        return true;
    return TEST_BASENAME_RE.test(base) || SCHEMA_RE.test(base);
}
//# sourceMappingURL=test-paths.js.map