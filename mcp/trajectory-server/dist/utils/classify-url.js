function extractHost(url) {
    // scp-like git remote: git@host:path or git@host:port/path
    const scpMatch = url.match(/^[^@]+@([^:/]+)[:/]/);
    if (scpMatch)
        return scpMatch[1].toLowerCase();
    try {
        const parsed = new URL(url);
        if (parsed.hostname)
            return parsed.hostname.toLowerCase();
    }
    catch {
        // not a standard URL
    }
    return null;
}
function classifyHost(host) {
    if (host === 'github.com' || host.endsWith('.github.com'))
        return 'github';
    // gitlab.com OR self-hosted gitlab.<anything>
    if (host === 'gitlab.com' || /(?:^|\.)gitlab\./i.test(host))
        return 'gitlab';
    if (host === 'bitbucket.org' || host.endsWith('.bitbucket.org'))
        return 'bitbucket';
    if (host === 'codeberg.org' || host.endsWith('.codeberg.org'))
        return 'codeberg';
    if (host === 'dev.azure.com' || host.endsWith('.dev.azure.com'))
        return 'azuredev';
    return 'other';
}
export function classifyUrl(url) {
    const host = extractHost(url);
    if (!host)
        return 'other';
    return classifyHost(host);
}
//# sourceMappingURL=classify-url.js.map