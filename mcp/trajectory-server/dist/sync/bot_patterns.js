export const DEFAULT_BOT_PATTERNS = [
    /\[bot\]$/i,
    /-bot$/i,
    /^dependabot/i,
    /^coderabbitai/i,
    /^github-actions/i,
    /^codecov/i,
    /^renovate/i,
];
export function isBot(author, extra = []) {
    const all = [...DEFAULT_BOT_PATTERNS, ...extra];
    return all.some((p) => p.test(author));
}
export function buildBotPatterns(configOverride) {
    if (!configOverride || !configOverride.trim())
        return DEFAULT_BOT_PATTERNS;
    const extras = configOverride
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
        try {
            return new RegExp(s, 'i');
        }
        catch {
            return null; // skip an invalid user-supplied pattern rather than throw
        }
    })
        .filter((r) => r !== null);
    return [...DEFAULT_BOT_PATTERNS, ...extras];
}
//# sourceMappingURL=bot_patterns.js.map