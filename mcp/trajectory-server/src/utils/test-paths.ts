// The test lane (GH 2282, GH 2886): which repo-relative paths hold test code.
// The defaults are the common per-language conventions; a project widens or
// narrows them with plugin_config.world_model_test_lane globs. No parser
// imports, so the hooks bundle can load it.
import { matchesGlob } from 'node:path';

export type Lane = 'test' | 'product';

export interface TestLaneConfig {
  readonly extend: readonly string[];
  readonly exclude: readonly string[];
}

export const DEFAULT_TEST_LANE: TestLaneConfig = { extend: [], exclude: [] };

// Maven and Gradle's src/test/ is covered by the 'test' segment.
const TEST_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'e2e', 'fixtures']);
const TEST_BASENAMES = [
  /\.(?:test|spec|suite)\./,
  /_test\.go$/,
  /^test_.*\.py$/,
  /_test\.py$/,
  /_spec\.rb$/,
  /^conftest\.py$/,
];

function segmentsOf(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
}

export function isTestBasename(path: string): boolean {
  const base = segmentsOf(path).at(-1) ?? '';
  return TEST_BASENAMES.some((re) => re.test(base));
}

export function isDefaultTestPath(path: string): boolean {
  return segmentsOf(path).slice(0, -1).some((s) => TEST_SEGMENTS.has(s)) || isTestBasename(path);
}

/** The classifier for one project's config: exclude wins over the defaults and extend. */
export function testLaneClassifier(config: TestLaneConfig): (path: string) => boolean {
  if (config.extend.length === 0 && config.exclude.length === 0) return isDefaultTestPath;
  return (path) => {
    const posixPath = segmentsOf(path).join('/');
    if (config.exclude.some((glob) => matchesGlob(posixPath, glob))) return false;
    return isDefaultTestPath(posixPath) || config.extend.some((glob) => matchesGlob(posixPath, glob));
  };
}

function isGlobList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((el) => typeof el === 'string' && el.trim().length > 0);
}

export function isTestLaneConfig(value: unknown): value is Partial<TestLaneConfig> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { extend, exclude, ...rest } = value as Record<string, unknown>;
  return Object.keys(rest).length === 0 && (extend === undefined || isGlobList(extend)) && (exclude === undefined || isGlobList(exclude));
}

/** A stored world_model_test_lane value; anything malformed reads as the defaults. */
export function parseTestLaneConfig(value: unknown): TestLaneConfig {
  if (!isTestLaneConfig(value)) return DEFAULT_TEST_LANE;
  return { extend: value.extend ?? [], exclude: value.exclude ?? [] };
}

let activeClassifier: (path: string) => boolean = isDefaultTestPath;

/** Sets the process-wide classifier isTestPath answers with. */
export function configureTestLane(config: TestLaneConfig): void {
  activeClassifier = testLaneClassifier(config);
}

export function isTestPath(path: string): boolean {
  return activeClassifier(path);
}

export function laneOf(path: string): Lane {
  return isTestPath(path) ? 'test' : 'product';
}
