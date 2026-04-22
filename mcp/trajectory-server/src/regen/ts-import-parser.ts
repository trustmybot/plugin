/**
 * Regex-only TS/JS import extractor. No AST dependency.
 * Limitation: does not handle dynamic import(), tagged template literals, or
 * imports inside string literals. Sufficient for doc-renderer purposes.
 */

const STATIC_IMPORT_RE = /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const EXPORT_FROM_RE = /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;

export function parseImports(source: string): string[] {
  const result = new Set<string>();

  for (const re of [STATIC_IMPORT_RE, REQUIRE_RE, EXPORT_FROM_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const target = m[1];
      if (target && target.length > 0) {
        result.add(target);
      }
    }
  }

  return Array.from(result);
}
