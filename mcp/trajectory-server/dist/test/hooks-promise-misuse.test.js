/**
 * Promise misuse under src/hooks (GH 1692 R-async A2a), checked with the
 * TypeScript compiler API since the gates went async: a promise nobody awaits, a
 * promise used as a condition (always true), and an async predicate handed to an
 * array method that reads its result as a boolean. A deliberate site goes on
 * ALLOWED as file plus enclosing symbol; a new site fails, and so does an entry
 * that no longer matches one.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS_SRC = join(PACKAGE_ROOT, 'src', 'hooks');
const ALLOWED = new Set([
    // The parser load is cached as a promise every Bash gate awaits; a failed load clears the cache.
    'src/hooks/cmd-analysis/parser.ts::bashParser',
    // A gate returns a result or a promise; run() checks which before racing it against the deadline.
    'src/hooks/router/decide.ts::run',
    // A memo entry holds its run for every caller that awaits it.
    'src/hooks/lib/git.ts::entry',
]);
const PROMISE_COMBINATORS = new Set(['all', 'allSettled', 'any', 'race']);
const CHAIN_METHODS = new Set(['then', 'catch', 'finally']);
const PREDICATE_METHODS = new Set(['some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'filter', 'forEach', 'sort']);
function compilerOptions() {
    const configPath = join(PACKAGE_ROOT, 'tsconfig.json');
    const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
    return { ...ts.parseJsonConfigFileContent(config, ts.sys, PACKAGE_ROOT, undefined, configPath).options, noEmit: true };
}
function isNamedPromise(t) {
    return t.getSymbol()?.getName() === 'Promise';
}
/** A Promise on some path, so a value that is a promise only sometimes still has to be awaited. */
function mayBePromise(t) {
    return t.isUnion() ? t.types.some(isNamedPromise) : isNamedPromise(t);
}
/** A Promise on every path; a nullable one tested for presence is a fair condition. */
function isAlwaysPromise(t) {
    return t.isUnion() ? t.types.every(isNamedPromise) : isNamedPromise(t);
}
function isCondition(node) {
    const p = node.parent;
    if (ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p))
        return p.expression === node;
    if (ts.isForStatement(p))
        return p.condition === node;
    if (ts.isConditionalExpression(p))
        return p.condition === node;
    if (ts.isPrefixUnaryExpression(p))
        return p.operator === ts.SyntaxKind.ExclamationToken;
    if (!ts.isBinaryExpression(p))
        return false;
    const logical = p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || p.operatorToken.kind === ts.SyntaxKind.BarBarToken;
    return logical && (p.left === node || isConditionChain(p));
}
/** A `&&`/`||` whose own value is read as a condition, so its right operand is too. */
function isConditionChain(node) {
    let at = node;
    while (ts.isParenthesizedExpression(at.parent))
        at = at.parent;
    return isCondition(at);
}
function isCombinatorArgument(node) {
    const holder = ts.isArrayLiteralExpression(node.parent) ? node.parent : node;
    const call = holder.parent;
    if (!ts.isCallExpression(call) || !call.arguments.includes(holder))
        return false;
    const callee = call.expression;
    return ts.isPropertyAccessExpression(callee) && callee.expression.getText() === 'Promise' && PROMISE_COMBINATORS.has(callee.name.text);
}
/** Whether the promise a call yields reaches an await, a return or a chain that is judged in its own right. */
function isConsumed(call) {
    let at = call;
    for (;;) {
        const p = at.parent;
        if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p)) {
            at = p;
            continue;
        }
        if (ts.isConditionalExpression(p) && p.condition !== at) {
            at = p;
            continue;
        }
        if (ts.isBinaryExpression(p) && p.right === at && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind)) {
            at = p;
            continue;
        }
        if (ts.isAwaitExpression(p) || ts.isReturnStatement(p))
            return true;
        if (ts.isArrowFunction(p))
            return p.body === at;
        if (ts.isPropertyAccessExpression(p))
            return p.expression === at && CHAIN_METHODS.has(p.name.text);
        return isCombinatorArgument(at);
    }
}
function enclosingSymbol(node) {
    for (let at = node.parent; at; at = at.parent) {
        const named = at;
        if ((ts.isFunctionLike(at) || ts.isVariableDeclaration(at) || ts.isPropertyDeclaration(at)) && named.name && ts.isIdentifier(named.name))
            return named.name.text;
    }
    return '<top level>';
}
/** The misuses in <files>; `file` in each is relative to <base>. */
function findMisuse(files, options, base) {
    const program = ts.createProgram([...files], options);
    const checker = program.getTypeChecker();
    const found = [];
    const wanted = new Set(files);
    for (const source of program.getSourceFiles()) {
        if (!wanted.has(source.fileName))
            continue;
        const report = (kind, node) => {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart());
            found.push({ kind, file: relative(base, source.fileName), symbol: enclosingSymbol(node), line: line + 1, text: node.getText().slice(0, 90).replace(/\s+/g, ' ') });
        };
        const visit = (node) => {
            const condition = ts.isExpression(node) && isCondition(node);
            if (condition && isAlwaysPromise(checker.getTypeAtLocation(node)))
                report('condition', node);
            else if (ts.isCallExpression(node) && !condition && mayBePromise(checker.getTypeAtLocation(node)) && !isConsumed(node))
                report('floating', node);
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && PREDICATE_METHODS.has(node.expression.name.text)) {
                const [callback] = node.arguments;
                const signatures = callback ? checker.getTypeAtLocation(callback).getCallSignatures() : [];
                if (signatures.some((s) => mayBePromise(s.getReturnType())))
                    report('predicate', callback);
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    return found;
}
const siteKey = (m) => `${m.file}::${m.symbol}`;
describe('Promise misuse in src/hooks', () => {
    it('no site outside the allowlist, and no allowlist entry without a site', () => {
        const files = readdirSync(HOOKS_SRC, { recursive: true, encoding: 'utf8' })
            .filter((file) => file.endsWith('.ts'))
            .map((file) => join(HOOKS_SRC, file));
        const misuse = findMisuse(files, compilerOptions(), PACKAGE_ROOT);
        const unexpected = misuse.filter((m) => !ALLOWED.has(siteKey(m))).map((m) => `${m.kind} ${m.file}:${m.line} (${m.symbol}) ${m.text}`);
        assert.deepEqual(unexpected, []);
        const sites = new Set(misuse.map(siteKey));
        assert.deepEqual([...ALLOWED].filter((entry) => !sites.has(entry)), []);
    });
});
describe('the check flags each class on a fixture', () => {
    let dir;
    const FIXTURE = `
declare function hook(): Promise<boolean>;
declare function sometimes(): boolean | Promise<boolean>;
declare const maybe: Promise<boolean> | null;
const asyncCheck = async (n: number): Promise<boolean> => n > 0;

export function floatingStatement(): void {
  hook();
}
export function floatingBinding(): void {
  const held = hook();
  console.log(held);
}
export function floatingUnion(): void {
  sometimes();
}
export function floatingChain(): void {
  hook().then(() => undefined);
}
export function conditionIf(): number {
  if (hook()) return 1;
  return 0;
}
export function conditionNot(): boolean {
  return !hook();
}
export function conditionTernary(): number {
  return hook() ? 1 : 0;
}
export function conditionAnd(flag: boolean): number {
  if (flag && hook()) return 1;
  return 0;
}
export function predicateSome(xs: number[]): boolean {
  return xs.some(async (n) => n > 0);
}
export function predicateFind(xs: number[]): number | undefined {
  return xs.find(async (n) => n > 0);
}
export function predicateFilter(xs: number[]): number[] {
  return xs.filter(async (n) => n > 0);
}
export function predicateEvery(xs: number[]): boolean {
  return xs.every(asyncCheck);
}

export async function clean(xs: number[]): Promise<boolean> {
  await hook();
  if (await hook()) return true;
  if (maybe) await maybe;
  const all = await Promise.all(xs.map((n) => asyncCheck(n)));
  await Promise.race([hook(), hook()]);
  const chained = await hook().catch(() => false);
  return all.every(Boolean) && chained ? hook() : xs.length > 0;
}
`;
    before(() => {
        dir = mkdtempSync(join(tmpdir(), 'tmb-promise-misuse-'));
        writeFileSync(join(dir, 'fixture.ts'), FIXTURE);
    });
    after(() => rmSync(dir, { recursive: true, force: true }));
    it('every misuse is flagged in its class, and the clean function not at all', () => {
        const misuse = findMisuse([join(dir, 'fixture.ts')], { ...compilerOptions(), types: [] }, dir);
        const by = (kind) => misuse.filter((m) => m.kind === kind).map((m) => m.symbol).sort();
        assert.deepEqual(by('floating'), ['floatingChain', 'floatingStatement', 'floatingUnion', 'held']);
        assert.deepEqual(by('condition'), ['conditionAnd', 'conditionIf', 'conditionNot', 'conditionTernary']);
        assert.deepEqual(by('predicate'), ['predicateEvery', 'predicateFilter', 'predicateFind', 'predicateSome']);
    });
});
//# sourceMappingURL=hooks-promise-misuse.test.js.map