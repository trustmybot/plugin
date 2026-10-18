export function toFtsQuery(raw: string): string {
  const tokens = Array.from(raw.matchAll(/"([^"]*)"|\S+/g), (m) =>
    (m[1] ?? m[0].replace(/^"+|"+$/g, '')).trim(),
  )
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replace(/"/g, '""')}"`);
  return tokens.length > 0 ? tokens.join(' ') : '""';
}

export function withFtsGuard<T>(run: () => T): T {
  try {
    return run();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/fts5|no such column/i.test(message)) {
      throw new Error(`fts_query_invalid: ${message}`);
    }
    throw e;
  }
}
