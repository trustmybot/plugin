/**
 * The PR-create recogniser git-guards and feature-branch-merge-gate share
 * (GH 2225): whether a statement cmdStatements lists opens a pull or merge
 * request, in any of the spellings gh and glab accept, and the head and base
 * branches it names. It lists the creating spellings only, so read-only
 * calls (`gh pr view`, a GET of `.../pulls`) stay unrecognised. User-defined
 * aliases and other forges are not recognised.
 */
/** The value-taking flags gh accepts before and between `pr` and `create`, and glab before `mr` and `create`. */
const REPO_FLAGS = new Set(['-R', '--repo']);
const CREATE_ACTIONS = new Set(['create', 'new']);
/** `gh api` flags that take the next word as their value, field flags aside. */
const API_VALUE_FLAGS = new Set(['-H', '--header', '-q', '--jq', '-t', '--template', '-p', '--preview', '--hostname', '--cache']);
const API_FIELD_FLAGS = new Set(['-f', '-F', '--field', '--raw-field']);
const PULLS_ENDPOINT = /^\/?repos\/[^/]+\/[^/]+\/pulls$/;
/** A `headRefName: "x"` (or baseRefName) literal inside a graphql query word, where cmdStatements writes a quoted blank as `_`. */
const GRAPHQL_LITERAL = (name) => new RegExp(`${name}[_\\s]*:[_\\s]*\\\\*"([^"\\\\]*)`);
function words(stmt) {
    return stmt.split(/[ \t\n\v\f\r]+/).filter((w) => w !== '');
}
function programOf(word) {
    return word.slice(word.lastIndexOf('/') + 1);
}
/**
 * The value of the first `--long` or `-s` option among <w>: `--long=v`,
 * `--long v`, `-s=v`, `-sv` or `-s v`; "" when neither is given.
 */
function optionValue(w, long, short) {
    for (let i = 0; i < w.length; i++) {
        const a = w[i];
        if (a === `--${long}` || a === `-${short}`)
            return w[i + 1] ?? '';
        if (a.startsWith(`--${long}=`))
            return a.slice(long.length + 3);
        if (a.startsWith(`-${short}`) && !a.startsWith('--'))
            return a.slice(2).replace(/^=/, '');
    }
    return '';
}
/** The index of the first word in <w> from <from> that is no flag, skipping each `-R`/`--repo` value; -1 when none. */
function nextPositional(w, from) {
    for (let k = from; k < w.length; k++) {
        if (REPO_FLAGS.has(w[k]))
            k += 1;
        else if (!w[k].startsWith('-'))
            return k;
    }
    return -1;
}
/** `<group> create|new` after the forge word, with `-R`/`--repo` and other flags allowed before either word. */
function isGroupCreate(w, group) {
    const g = nextPositional(w, 1);
    if (g < 0 || w[g] !== group)
        return false;
    const a = nextPositional(w, g + 1);
    return a >= 0 && CREATE_ACTIONS.has(w[a]);
}
/** The endpoint, effective method and `key=value` fields of a `gh api` call whose words after `api` are <w>. */
function apiCall(w) {
    let endpoint = '';
    let method = '';
    let body = false;
    const fields = new Map();
    const field = (kv) => {
        body = true;
        const eq = kv.indexOf('=');
        if (eq > 0 && !fields.has(kv.slice(0, eq)))
            fields.set(kv.slice(0, eq), kv.slice(eq + 1));
    };
    for (let k = 0; k < w.length; k++) {
        const a = w[k];
        if (a === '-X' || a === '--method')
            method = w[++k] ?? '';
        else if (a.startsWith('--method='))
            method = a.slice('--method='.length);
        else if (a.startsWith('-X'))
            method = a.slice(2);
        else if (API_FIELD_FLAGS.has(a))
            field(w[++k] ?? '');
        else if (a.startsWith('--field=') || a.startsWith('--raw-field='))
            field(a.slice(a.indexOf('=') + 1));
        else if (/^-[fF]./.test(a))
            field(a.slice(2));
        else if (a === '--input' || a.startsWith('--input=')) {
            body = true;
            if (a === '--input')
                k += 1;
        }
        else if (API_VALUE_FLAGS.has(a))
            k += 1;
        else if (!a.startsWith('-') && endpoint === '')
            endpoint = a;
    }
    return { endpoint, method: (method || (body ? 'POST' : 'GET')).toUpperCase(), fields };
}
function graphqlLiteral(stmt, name) {
    return GRAPHQL_LITERAL(name).exec(stmt)?.[1] ?? '';
}
function ghApiCreate(stmt, w) {
    const api = nextPositional(w, 1);
    if (api < 0 || w[api] !== 'api')
        return null;
    const call = apiCall(w.slice(api + 1));
    if (call.method === 'POST' && PULLS_ENDPOINT.test(call.endpoint)) {
        return { forge: 'gh', head: call.fields.get('head') ?? '', base: call.fields.get('base') ?? '', repo: '' };
    }
    if (call.endpoint === 'graphql' && stmt.includes('createPullRequest')) {
        return {
            forge: 'gh',
            head: call.fields.get('headRefName') ?? graphqlLiteral(stmt, 'headRefName'),
            base: call.fields.get('baseRefName') ?? graphqlLiteral(stmt, 'baseRefName'),
            repo: '',
        };
    }
    return null;
}
/**
 * The PR or MR <stmt> opens, null when it opens none: `gh pr create|new` and
 * `glab mr create|new` with `-R`/`--repo` anywhere before the action, a
 * `gh api` POST to `[/]repos/<o>/<r>/pulls`, and a `gh api graphql` call
 * carrying `createPullRequest`.
 */
export function prCreateOf(stmt) {
    const w = words(stmt);
    const program = programOf(w[0] ?? '');
    if (program === 'gh') {
        if (isGroupCreate(w, 'pr')) {
            return { forge: 'gh', head: optionValue(w, 'head', 'H'), base: optionValue(w, 'base', 'B'), repo: optionValue(w, 'repo', 'R') };
        }
        return ghApiCreate(stmt, w);
    }
    if (program === 'glab' && isGroupCreate(w, 'mr')) {
        return {
            forge: 'glab',
            head: optionValue(w, 'source-branch', 's'),
            base: optionValue(w, 'target-branch', 'b'),
            repo: optionValue(w, 'repo', 'R'),
        };
    }
    return null;
}
//# sourceMappingURL=pr-create.js.map