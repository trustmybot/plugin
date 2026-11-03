/**
 * UserPromptSubmit hook (GH 1692), the port of scripts/hooks/prompt-intent-hints.sh:
 * one pass over the Human's prompt, where the first hint class that fires
 * emits its additionalContext — cheatcode-install, consultant-spawn,
 * search-grounding, concerns-protocol, push-intent, reonboard-intent,
 * headless-intent, resume-intent, adr-required, audit-intent — each with its
 * TMB_DISABLE_*_HINT switch. Harness turns, `!` shell spans and injected
 * <system-reminder>/<pasted_content>/<agent-message> blocks are never intent.
 *
 * Unlike the .sh (decision 703), it needs neither jq nor the sqlite3 CLI, and
 * the headless hint matches `claude -p` / `claude --print` only outside quoted
 * spans and fenced blocks and only in a clause that is not a question, its
 * other phrases only outside quoted spans and fenced blocks (GH 1751).
 */
import { statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ALLOW } from './gate.js';
import { LocaleGrep } from './activation-routine.js';
import { trLower } from './agent-arg-matches-caller.js';
import { isHarnessTurn } from './cmd-analysis/harness-turn.js';
import { auditAppend } from './lib/audit.js';
import { dbPath, dbPathAdvisory, haveSqlite, projectRoot, sqliteRo } from './lib/db.js';
import { jqCompact, jqFieldOr } from './lib/jq.js';
import { commandSubstitution, installRoot, posixDirname, setlocaleUtf8 } from './lib/project-env.js';
export const GATE_NAME = 'prompt-intent-hints';
const SUMMARY_MAX_BYTES = 200;
const C_SPACE = '\\t\\n\\v\\f\\r ';
const UTF8_SPACE = `${C_SPACE}\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000`;
const INJECTED_TAGS = ['system-reminder', 'pasted_content', 'agent-message'];
const SEARCH_PATTERNS = [
    'why did we', 'why we chose', 'why we picked', 'why we decided',
    'what was the rationale', 'what is the rationale',
    'what did we decide', 'what was decided', 'what was our decision',
    'how did we decide', 'when did we decide',
    'rationale for', 'reasoning behind',
    'past decision', 'prior decision', 'previous decision',
    'find the discussion', 'search the discussion', 'search discussions',
    'recall why', 'remind me why',
];
const CONCERNS_PATTERNS = [
    'delete the test', 'remove the test', 'skip the test', 'skip the tests',
    'skip validation', 'skip verification', 'skip the gate', 'force push',
    'ignore the gate', 'just do it', 'just push it', 'bypass the check',
    'weaken the assertion', 'loosen the check', 'just delete', 'just remove',
    'switch to approxequal', 'use approxequal', 'replace exact equality',
    'change to approx', 'approxequal with tolerance',
];
const PUSH_PATTERNS = [
    'git push', 'push it', 'push the work', 'push the branch', 'push the change',
    'push up', 'push them up', 'push my work', 'ship it', 'ship the work',
    'send it up', 'time to push',
];
const REONBOARD_PATTERNS = [
    'available on github', 'available on gitlab', 'available on a remote',
    'host on github', 'host on gitlab', 'host it on github', 'host it on gitlab',
    'push to github', 'push to gitlab', 'put this on github', 'put this on gitlab',
    'put it on github', 'put it on gitlab', 'publish to github', 'publish to gitlab',
    'switch to remote', 'go remote', 'add a remote', 'set up a remote',
    'set up the remote', 'add github remote', 'add gitlab remote',
    'live on a remote', 'live on github', 'live on gitlab',
    'lives on a remote', 'lives on github', 'lives on gitlab',
    'needs to live on', 'needs a remote',
    'change my issue tracker', 'switch issue tracker',
    'switch to gitflow', 'switch to git-flow', 'switch to github-flow',
    'switch to github flow', 'change branching model',
    'change the branching model', 'switch branching model',
    'change pr target', 'change the pr target', 'update pr target',
    'update the pr target',
];
const HEADLESS_PATTERNS = [
    'claude -p', 'claude --print', 'headless', 'non-interactive', 'noninteractive',
    'in ci', 'ci run', 'ci pipeline', 'github actions', 'gitlab ci',
];
/** The headless phrases that name the CLI itself: a question or quote about them is not intent (GH 1751). */
const HEADLESS_INVOCATIONS = new Set(['claude -p', 'claude --print']);
const RESUME_PATTERNS = [
    'keep going', 'pick it up', 'pick that up', 'pick this up', 'pick up',
    "let's continue", 'continue the work', 'continue with', 'resume',
    'finish that', 'finish the', 'finish it', 'wrap that up', 'wrap up',
    'still pending', 'still open', 'still waiting',
];
const ADR_PATTERNS = [
    'switch to clerk', 'switch to auth0', 'switch to okta', 'swap our auth',
    'switch our auth', 'change our auth', 'migrate to postgres', 'migrate to mysql',
    'migrate from postgres', 'migrate from mysql', 'switch to sqlite',
    'switch to postgres', 'switch to mysql', 'migrate storage', 'swap our db',
    'swap the db', 'switch our db', 'replace our db',
    'introduce a new service', 'new service boundary', 'new module boundary',
    'public api', 'new public api', 'change the public api',
    'strategic stack', 'production db', 'retention policy',
    'use react instead', 'use vue instead', 'use svelte instead',
    'use fastapi instead', 'use django instead', 'use flask instead',
    'replatform',
    'extract the storage layer', 'extract the storage', 'storage interface',
    'storage backend', 'backend interface', 'pluggable backend',
    'pluggable storage', 'swap between', 'plugin loader',
    'plugin architecture', 'dependency inversion',
];
const AUDIT_WORDS = ['audit', 'verify', 'double-check', 'check', 'architecture'];
const ADVISORY_SHAPES = [
    '?', 'should we use', 'should we keep', 'should we move', 'should we commit to', 'should we', 'should i',
    'recommend', 'trade-off', 'tradeoff', 'your take', 'your view', 'your read', 'which one', 'which of',
    'is it safe', 'is it ok', 'is it better', 'implication', 'better to use',
];
const DOMAINS = [
    ['security', ['security', 'vulnerability', 'injection', 'xss', 'csrf', 'auth bypass']],
    ['perf', ['latency', 'throughput', 'bottleneck', 'scaling', ' scale', 'benchmark']],
    ['legal', ['legal', 'licensing', 'compliance', 'gdpr', 'pii', 'copyright']],
    ['architect', ['architecture decision', 'design choice', 'adr', 'architecture trade', 'architectural trade']],
    ['architect', ['json or sqlite', 'sqlite or postgres', 'postgres or sqlite', 'sqlite vs postgres', 'sql or nosql']],
];
const CHEATCODE_INSTALL_CTX = '[tmb cheatcode-install routing] This is a cheatcode install, NOT agent/consultant creation. Record the per-candidate approval (cheatcode_approve) then call cheatcode_install with the requested scope (default local). Do NOT call agent_resolve / /tmb:agent-create for these names.';
const SEARCH_CTX_TAIL = `

Prefer the *_search MCP tools over linear scans:
- \`discussion_search(query='<key terms>', mode='hybrid')\` returns ranked snippets across ALL issues (keyword + semantic). Use this first.
- \`audit_search(query='<key terms>')\` for event-history grounding.
- \`world_model_search(query='<key terms>')\` for code-context / project-structure grounding.

Only fall back to \`discussion_list(issue_id=N)\` / \`issue_get_with_discussions\` once \`discussion_search\` has narrowed the candidate set — those tools enumerate, they don't rank. Hybrid mode auto-falls-back to keyword if the embedding model is offline (\`warning: 'semantic_unavailable'\`).`;
const PENDING_SQL = `
        SELECT t.id || '|' || t.branch_id || '|' || substr(COALESCE(t.title, ''), 1, 60)
          FROM tasks t
         WHERE t.status IN ('needs_validation', 'completed', 'closed')
           AND t.commit_sha IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM validation_attempts v
              WHERE v.task_id = t.id
                AND v.verdict = 'pass'
           );
      `;
const RESUME_SQL = `
        SELECT
          t.id,
          t.issue_id,
          COALESCE(t.branch_id, ''),
          replace(substr(COALESCE(t.title, ''), 1, 60), '|', '/'),
          substr(COALESCE(i.objective, ''), 1, 80)
        FROM tasks t
        JOIN issues i ON i.id = t.issue_id
        JOIN audit a ON a.issue_id = i.id AND a.event_type = 'planning_complete'
        WHERE t.status = 'pending'
          AND i.status = 'open'
        ORDER BY a.id DESC
        LIMIT 1;
      `;
const CONSULTANTS_SQL = "SELECT name FROM agents WHERE kind='consultant';";
const ONBOARDED_SQL = "SELECT 1 FROM plugin_config WHERE key='onboarded' AND value_json='true' LIMIT 1;";
const HEADLESS_WANTED_SQL = "SELECT 1 WHERE EXISTS (SELECT 1 FROM plugin_config WHERE key='onboarded' AND value_json='true') AND NOT EXISTS (SELECT 1 FROM plugin_config WHERE key='headless_enforcement' AND value_json='\"yes\"');";
/** `case <text> in *[![:space:]]*`: whether <text> holds a character outside the locale's [:space:]. */
export function hasNonSpace(text, utf8) {
    return new RegExp(`[^${utf8 ? UTF8_SPACE : C_SPACE}]`, 'u').test(text);
}
/** The perl pass dropping `!` shell-turn spans: <bash-input|stdout|stderr>…</bash-…>, shortest match (GH 1598). */
export function stripBashSpans(text) {
    return text.replace(/<bash-(input|stdout|stderr)>[\s\S]*?<\/bash-\1>/g, '');
}
function openingTag(s, tag) {
    let k = s.indexOf(`<${tag}`);
    while (k >= 0) {
        const c = s.charAt(k + tag.length + 1);
        if (c === '>' || c === ' ' || c === '\t' || c === '\n')
            return k;
        k = s.indexOf(`<${tag}`, k + 1);
    }
    return -1;
}
/**
 * strip_injected_blocks: <text> without the harness-injected
 * <system-reminder…>, <pasted_content…> and <agent-message…> blocks, each cut
 * from its opening tag to the first matching close tag and replaced by a
 * space; an unclosed block stays (GH 1764).
 */
export function stripInjectedBlocks(text) {
    let buf = text;
    let out = '';
    for (;;) {
        let first = -1;
        let tag = '';
        for (const t of INJECTED_TAGS) {
            const k = openingTag(buf, t);
            if (k >= 0 && (first < 0 || k < first)) {
                first = k;
                tag = t;
            }
        }
        if (first < 0)
            break;
        const closeTag = `</${tag}>`;
        const e = buf.indexOf(closeTag, first);
        if (e < 0) {
            out += buf.slice(0, first + 1);
            buf = buf.slice(first + 1);
            continue;
        }
        out += `${buf.slice(0, first)} `;
        buf = buf.slice(e + closeTag.length);
    }
    return commandSubstitution(out + buf);
}
const AWK_ALNUM = /[A-Za-z0-9]/;
const AWK_SPACE = /[\t\n\v\f\r ]/;
/**
 * tmb_strip_quoted_spans: <text> with each backticked span and each quoted
 * span ('…' or "…" opening after a non-alnum and before a non-space, closing
 * before a non-alnum) replaced by a space.
 */
export function stripQuotedSpans(text) {
    const n = text.length;
    let out = '';
    let i = 0;
    while (i < n) {
        const c = text[i];
        let j = -1;
        if (c === '`') {
            j = text.indexOf('`', i + 1);
        }
        else if ((c === "'" || c === '"') &&
            (i === 0 || !AWK_ALNUM.test(text[i - 1])) &&
            i + 1 < n &&
            !AWK_SPACE.test(text[i + 1])) {
            for (let k = i + 2; k < n; k++) {
                if (text[k] === c && (k === n - 1 || !AWK_ALNUM.test(text[k + 1]))) {
                    j = k;
                    break;
                }
            }
        }
        if (j >= 0) {
            out += ' ';
            i = j + 1;
            continue;
        }
        out += c;
        i += 1;
    }
    return commandSubstitution(out);
}
/** <text> with each ```-fenced block replaced by a space; an unclosed fence stays. */
export function stripFencedBlocks(text) {
    return text.replace(/```[\s\S]*?```/g, ' ');
}
/** The clauses of <text>: each line split after . ; ? !, a clause ending in ? being a question. */
export function splitClauses(text) {
    const out = [];
    for (const line of text.split('\n')) {
        for (const piece of line.split(/(?<=[.;?!])/)) {
            out.push({ text: piece.replace(/[.;?!]$/, ''), question: piece.endsWith('?') });
        }
    }
    return out;
}
function codePointBefore(text, k) {
    if (k <= 0)
        return '';
    const low = text.charCodeAt(k - 1);
    if (k >= 2 && low >= 0xdc00 && low <= 0xdfff) {
        const high = text.charCodeAt(k - 2);
        if (high >= 0xd800 && high <= 0xdbff)
            return text.slice(k - 2, k);
    }
    return text[k - 1];
}
function codePointAt(text, k) {
    if (k >= text.length)
        return '';
    return String.fromCodePoint(text.codePointAt(k) ?? 0);
}
/**
 * Whether bash's glob `[a-z]` takes <c>: ASCII a-z under C; under a UTF-8
 * locale the collation range from a to z, which holds the Latin letters
 * other than Z and its variants.
 */
export function globAz(c, utf8) {
    if (c === '')
        return false;
    if (/^[a-z]$/.test(c))
        return true;
    if (!utf8)
        return false;
    return /^\p{Script=Latin}$/u.test(c) && !c.normalize('NFD').startsWith('Z');
}
/** has_word <word> <text>: <word> in <text> with no [a-z] letter on either side. */
export function hasWord(word, text, utf8) {
    let k = text.indexOf(word);
    while (k >= 0) {
        if (!globAz(codePointBefore(text, k), utf8) && !globAz(codePointAt(text, k + word.length), utf8))
            return true;
        k = text.indexOf(word, k + 1);
    }
    return false;
}
const awkWord = (c) => /^[a-z0-9_]$/.test(c);
function hasTarget(tail, agent) {
    for (const prep of ['for', 'to', 'onto']) {
        const needle = `${prep} ${agent}`;
        let k = tail.indexOf(needle);
        while (k >= 0) {
            const before = k === 0 ? '' : tail[k - 1];
            const after = tail.charAt(k + needle.length);
            if (!awkWord(before) && !awkWord(after) && after !== '-')
                return true;
            k = tail.indexOf(needle, k + 1);
        }
    }
    return false;
}
/**
 * The capability-on-agent awk: the first agent named as "for|to|onto <agent>"
 * after a whole-word install/add in the same clause, or "".
 */
export function capabilityOnAgent(lower, agents) {
    for (const clause of splitClauses(lower)) {
        const s = clause.text.replace(/[ \t]+/g, ' ');
        const verb = /install|add/g;
        let m;
        while ((m = verb.exec(s)) !== null) {
            const v = m.index;
            const e = v + m[0].length;
            if ((v === 0 || !awkWord(s[v - 1])) && !awkWord(s.charAt(e))) {
                const tail = s.slice(e);
                for (const agent of agents)
                    if (hasTarget(tail, agent))
                        return agent;
            }
            verb.lastIndex = v + 1;
        }
    }
    return '';
}
function wholePhrase(pattern) {
    return new RegExp(`(^|[^a-z0-9_])${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_]|$)`);
}
/**
 * The headless phrase the prompt names, or "": every phrase is matched as
 * whole words outside quoted spans and fenced blocks, and `claude -p` /
 * `claude --print` only in a clause that is not a question (GH 1751).
 */
export function headlessMatch(promptRaw, env) {
    const open = trLower(stripQuotedSpans(stripFencedBlocks(promptRaw)), env);
    const statements = splitClauses(open)
        .filter((c) => !c.question)
        .map((c) => c.text)
        .join('\n');
    return HEADLESS_PATTERNS.find((pat) => wholePhrase(pat).test(HEADLESS_INVOCATIONS.has(pat) ? statements : open)) ?? '';
}
/** `IFS='|' read -r v1 … v<n>` of the first line of <text>: the last field takes the rest. */
export function readPipeFields(text, n) {
    let rest = text.split('\n')[0];
    const out = [];
    for (let i = 0; i < n - 1; i++) {
        const k = rest.indexOf('|');
        out.push(k < 0 ? rest : rest.slice(0, k));
        rest = k < 0 ? '' : rest.slice(k + 1);
    }
    out.push(/^[^|]*\|$/.test(rest) ? rest.slice(0, -1) : rest);
    return out;
}
/** The push hint's task list: one `  - task_id=…  branch=…  (…)` line per row. */
export function pendingList(pending) {
    return pending
        .split('\n')
        .map((line) => {
        const f = line.split('|');
        return `  - task_id=${f[0] ?? ''}  branch=${f[1] ?? ''}  (${f[2] ?? ''})`;
    })
        .join('\n');
}
/** The proximity awk: "port ... to" when `port` has `to` within 6 words after it, "rewrite ... in" likewise. */
export function proximityMatch(lowerOpen) {
    const w = lowerOpen.replace(/\n/g, ' ').split(/[^a-z0-9]+/);
    for (let i = 0; i < w.length; i++) {
        if (w[i] !== 'port' && w[i] !== 'rewrite')
            continue;
        const want = w[i] === 'port' ? 'to' : 'in';
        for (let j = i + 1; j < w.length && j <= i + 6; j++)
            if (w[j] === want)
                return `${w[i]} ... ${want}`;
    }
    return '';
}
function firstIncluded(text, patterns) {
    return patterns.find((pat) => text.includes(pat)) ?? '';
}
function disabled(env, key) {
    return (env[key] ?? '0') === '1';
}
function emit(context, prefix = '') {
    return {
        stdout: `${prefix}${jqCompact({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } })}\n`,
        code: 0,
    };
}
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
function defaultPluginRoot() {
    try {
        return installRoot(posixDirname(fileURLToPath(import.meta.url))) ?? '';
    }
    catch {
        return '';
    }
}
/** headless_shim_entries: countShimEntries of the built server, "" when it is missing or throws. */
async function shimEntries(env) {
    const root = env.CLAUDE_PLUGIN_ROOT || defaultPluginRoot();
    const mod = `${root}/mcp/trajectory-server/dist/tools/onboard-hooks-shim.js`;
    if (!isFile(mod))
        return '';
    try {
        const shim = (await import(pathToFileURL(mod).href));
        return String(shim.countShimEntries(root));
    }
    catch {
        return '';
    }
}
class Context {
    env;
    db;
    constructor(env) {
        this.env = env;
    }
    /** `tmb_db_path` with sqlite available, else null. */
    database() {
        if (this.db === undefined)
            this.db = dbPath(this.env);
        return this.db !== null && this.db !== '' && haveSqlite(this.env) ? this.db : null;
    }
    query(sql) {
        const db = this.database();
        return db === null ? '' : commandSubstitution(sqliteRo(db, sql, this.env));
    }
    consultants() {
        return this.query(CONSULTANTS_SQL)
            .split('\n')
            .filter((role) => role !== '')
            .map((role) => trLower(role, this.env));
    }
    /** audit_consultant_spawn_nudged: the audit row, with what sqlite3 printed to pass through on stdout. */
    auditNudge(detail) {
        const db = this.database();
        if (db === null || !isFile(db))
            return '';
        const cut = commandSubstitution(Buffer.from(detail, 'utf8').subarray(0, SUMMARY_MAX_BYTES).toString('utf8'));
        const written = auditAppend(db, {
            issueId: '-1',
            branchId: '',
            fromNode: `hook:${GATE_NAME}`,
            eventType: 'consultant_spawn_nudged',
            summary: `Consultant-spawn nudge emitted: ${cut}`,
            contentJson: '{}',
        }, { caller: GATE_NAME, env: this.env });
        if (!written.ok && written.error !== '')
            process.stderr.write(`${written.error}\n`);
        return written.stdout;
    }
}
function cheatcodeInstall(lower, ctx, grep) {
    if (/(^|[^a-z0-9_])(install|add)([^a-z0-9_]|$)/m.test(lower)) {
        const agents = ['swe', 'code-reviewer', 'bro', ...ctx.consultants()].join(' ').split(/[ \t\n]+/).filter((a) => a !== '');
        const agent = capabilityOnAgent(lower, agents);
        if (agent !== '') {
            return emit(`[tmb cheatcode-routing] This installs a capability ONTO the \`${agent}\` agent — that is the cheatcode-reuse path. Load \`tmb_cheatcode\`: search/vet/approve the capability (cheatcode_search → cheatcode_approve) then materialize it onto the agent. This is capability reuse, so it routes through the cheatcode pipeline rather than the build flow.`);
        }
    }
    if (lower.includes('in local scope') || lower.includes('in global scope'))
        return emit(CHEATCODE_INSTALL_CTX);
    if (!lower.includes('install'))
        return null;
    const bytes = Buffer.from(`${lower}\n`, 'utf8');
    const space = `[${grep.utf8 ? UTF8_SPACE : C_SPACE}]`;
    if (grep.test(bytes, grep.regex('\\b(install|installing)\\b')) &&
        grep.test(bytes, grep.regex('\\b(plugin|plugins|skill|skills|mcp|cheatcode|cheatcodes)\\b')) &&
        !grep.test(bytes, grep.regex(`\\b(npm|npx|bun|yarn|pnpm|pip|pipx|brew|apt|apt-get|cargo|gem)${space}+install(ing)?\\b`))) {
        return emit(CHEATCODE_INSTALL_CTX);
    }
    return null;
}
function namedRole(lower, ctx) {
    for (const role of ctx.consultants()) {
        const shapes = [`${role}'s read`, `${role}'s view`, `${role}'s take`, `${role} agent`, `the ${role} `, `the ${role}.`, `the ${role},`];
        if (shapes.some((shape) => lower.includes(shape)))
            return role;
    }
    return '';
}
function domainOf(lower, utf8) {
    for (const [domain, keywords] of DOMAINS)
        if (keywords.some((k) => lower.includes(k)))
            return domain;
    return hasWord('perf', lower, utf8) ? 'perf' : '';
}
function consultantSpawn(lower, ctx, utf8) {
    const role = namedRole(lower, ctx);
    if (role !== '') {
        const passthrough = ctx.auditNudge(`named-role ${role}`);
        return emit(`[tmb consultant-spawn enforcement] The user's prompt names the \`${role}\` role. Invoke \`/tmb:agent-create ${role} <one-line restatement of the user question>\` — the command resolves the creation mode with agent_resolve, writes the agent file, registers it (the server audits the creation), and spawns the consultant in the same call. Bare \`Agent(subagent_type='${role}')\` without the command bypasses the registry; do NOT take that shortcut.`, passthrough);
    }
    const domain = domainOf(lower, utf8);
    if (domain === '' || firstIncluded(lower, ADVISORY_SHAPES) === '')
        return null;
    const passthrough = ctx.auditNudge(`domain ${domain}`);
    return emit(`[tmb consultant-spawn enforcement] The user's prompt looks like a \`${domain}\` judgment call. Invoke \`/tmb:agent-create <role> <one-line restatement>\` with the role that fits this domain (architect / cto / pm / legal-reviewer / a custom from-scratch role). The slash command resolves the creation mode with agent_resolve, writes the agent file, registers it (the server audits the creation), and spawns the consultant. Answering directly from general knowledge bypasses the consultant gate.`, passthrough);
}
function pushIntent(lowerOpen, ctx) {
    const matched = firstIncluded(lowerOpen, PUSH_PATTERNS);
    if (matched === '' || ctx.database() === null)
        return null;
    const pending = ctx.query(PENDING_SQL);
    if (pending === '')
        return null;
    return emit(`🚦 push-intent hint: the user's prompt contains '${matched}'. ${pending.split('\n').length} task(s) await code-reviewer signoff before push:

${pendingList(pending)}

Before \`git push\`, spawn code-reviewer for each pending task via \`Agent(subagent_type='code-reviewer', isolation=)\` (no worktree — code-reviewer reviews from the main checkout). On all-pass verdicts the push will clear the git-push-guard. If you skip this, the guard will deny the push and you'll have to redo the work anyway.`);
}
function reonboardIntent(lower, ctx) {
    const matched = firstIncluded(lower, REONBOARD_PATTERNS);
    if (matched === '' || ctx.database() === null || ctx.query(ONBOARDED_SQL) !== '1')
        return null;
    return emit(`🔁 reonboard-intent hint: the user's prompt contains '${matched}'. This signals a *reonboard* (project already onboarded — switching shape, not initial setup).

Policy/config mutations stay Human-gated. Route the Human to \`/onboard\` — do NOT call \`onboard_apply\` yourself.

REQUIRED FIRST ACTION — before any reply or git command: call \`onboard_state_get(agent='bro')\`. Your recommendation must cite the current config it returns (branching_model, pr_target, remotes); a reonboard answer composed without reading state is a workflow violation.

Then reply pointing the Human to \`/onboard\`. Do NOT spawn code work (no \`task_create_batch\`, no \`issue_create\`, no \`Agent\` for SWE) and do NOT wire remotes with raw git.`);
}
async function headlessIntent(promptRaw, ctx) {
    const matched = headlessMatch(promptRaw, ctx.env);
    if (matched === '' || ctx.database() === null || ctx.query(HEADLESS_WANTED_SQL) !== '1')
        return null;
    const settings = `${projectRoot(ctx.env) || '<project>'}/.claude/settings.local.json`;
    const entries = await shimEntries(ctx.env);
    const what = entries !== '' ? `${entries} PreToolUse gate entries` : "TMB's PreToolUse gate entries";
    return emit(`🤖 headless-intent hint: the user's prompt contains '${matched}'. Plugin hooks do not fire in non-interactive \`claude -p\` runs, and headless enforcement is off for this project.

Ask ONE \`AskUserQuestion\` consent before anything else: may TMB write ${what} into \`${settings}\` so its gates also run in \`claude -p\`? Name that file and the entry count in the question; if TMB creates the file in a git work tree, it is added to \`.gitignore\`.
- Yes → call \`onboard_apply(agent='bro', headless_enforcement='yes')\` and report \`applied.headless_shim\`.
- No → write nothing and carry on with the request.

Never call \`onboard_apply\` for this without the Human's answer.`);
}
function resumeIntent(lowerOpen, ctx) {
    const matched = firstIncluded(lowerOpen, RESUME_PATTERNS);
    if (matched === '' || ctx.database() === null)
        return null;
    const resume = ctx.query(RESUME_SQL);
    if (resume === '')
        return null;
    const [taskId, issueId, branchId, title, objective] = readPipeFields(resume, 5);
    return emit(`↩️  resume-intent hint: the user's prompt contains '${matched}'. There's a pending task that already has \`planning_complete\` audit — resume that, do NOT create new tasks or replan.

  task_id=${taskId}
  issue_id=${issueId}
  branch_id=${branchId}
  title='${title}'
  issue.objective='${objective}'

Required workflow:
1. Call \`task_get(task_id=${taskId})\` to load the spec.
2. If the task has no worktree yet, call \`task_reopen(task_id=${taskId}, reason="resume planned task")\`, which creates it; then spawn SWE via \`Agent(subagent_type='swe')\` with \`task_id=${taskId}\` in the prompt. Leave the main checkout on its current branch.
3. Do NOT call \`issue_create\` or \`task_create_batch\` — replanning is forbidden when planning_complete already exists for this work.`);
}
async function hints(promptRaw, env) {
    const utf8 = setlocaleUtf8(env);
    const lower = trLower(promptRaw, env);
    const lowerOpen = trLower(stripQuotedSpans(promptRaw), env);
    const ctx = new Context(env);
    if (!disabled(env, 'TMB_DISABLE_CHEATCODE_INSTALL_HINT')) {
        const r = cheatcodeInstall(lower, ctx, new LocaleGrep(utf8));
        if (r)
            return r;
    }
    if (!disabled(env, 'TMB_DISABLE_CONSULTANT_HINT')) {
        const r = consultantSpawn(lower, ctx, utf8);
        if (r)
            return r;
    }
    if (!disabled(env, 'TMB_DISABLE_SEARCH_HINT')) {
        const matched = firstIncluded(lower, SEARCH_PATTERNS);
        if (matched !== '') {
            return emit(`🔎 search-grounding hint: the user's prompt contains '${matched}' — a retrieval question over past decisions.${SEARCH_CTX_TAIL}`);
        }
    }
    if (!disabled(env, 'TMB_DISABLE_CONCERNS_HINT')) {
        const matched = firstIncluded(lowerOpen, CONCERNS_PATTERNS);
        if (matched !== '') {
            return emit(`🚨 concerns-protocol hint: the user's prompt contains '${matched}'. This is a doubt-class request — load \`tmb_concerns-protocol\`. REQUIRED FIRST ACTION before any compliance, edit, or task creation: \`discussion_append(agent='bro', kind='note', body='Concern: …')\` recording what the request risks (or why it is pointless) and your recommendation. Then follow the protocol — hold for the Human's alignment; a documented decision is not a substitute for the Concern: record.`);
        }
    }
    if (!disabled(env, 'TMB_DISABLE_PUSH_INTENT_HINT')) {
        const r = pushIntent(lowerOpen, ctx);
        if (r)
            return r;
    }
    const onboardPrompt = lower.includes('/onboard');
    if (!disabled(env, 'TMB_DISABLE_REONBOARD_HINT') && !onboardPrompt) {
        const r = reonboardIntent(lower, ctx);
        if (r)
            return r;
    }
    if (!disabled(env, 'TMB_DISABLE_HEADLESS_HINT') && !onboardPrompt) {
        const r = await headlessIntent(promptRaw, ctx);
        if (r)
            return r;
    }
    if (!disabled(env, 'TMB_DISABLE_RESUME_HINT')) {
        const r = resumeIntent(lowerOpen, ctx);
        if (r)
            return r;
    }
    if (!disabled(env, 'TMB_DISABLE_ADR_HINT')) {
        const matched = firstIncluded(lowerOpen, ADR_PATTERNS) || proximityMatch(lowerOpen);
        if (matched !== '') {
            return emit(`🏛️  architectural-change hint: the user's prompt contains '${matched}'. This change crosses TMB's architectural threshold — load \`tmb_planning\` and follow §"Architectural changes" before speccing the work.`);
        }
    }
    if (!disabled(env, 'TMB_DISABLE_AUDIT_HINT')) {
        const matched = AUDIT_WORDS.find((word) => hasWord(word, lowerOpen, utf8));
        if (matched !== undefined) {
            return emit(`🔍 audit-intent hint: the user's prompt contains '${matched}'. Load \`tmb_audit\` and work outputs-first: name the component and the invariants its outputs must satisfy, test each against live data or a dry run before reading code, and report violations architecture-first with their evidence.`);
        }
    }
    return ALLOW;
}
export async function promptIntentHints(payload, env) {
    try {
        let prompt = commandSubstitution(jqFieldOr(`${commandSubstitution(payload)}\n`, 'prompt'));
        if (prompt === '')
            return ALLOW;
        const utf8 = setlocaleUtf8(env);
        prompt = commandSubstitution(stripBashSpans(prompt));
        if (!hasNonSpace(prompt, utf8) || isHarnessTurn(prompt))
            return ALLOW;
        dbPathAdvisory(GATE_NAME, env, (line) => process.stderr.write(`${line}\n`));
        prompt = stripInjectedBlocks(prompt);
        if (!hasNonSpace(prompt, utf8))
            return ALLOW;
        return await hints(prompt, env);
    }
    catch {
        return ALLOW;
    }
}
//# sourceMappingURL=prompt-intent-hints.js.map