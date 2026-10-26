/**
 * The forge-write classifier of scripts/hooks/lib/cmd-analysis.sh (GH 1692):
 * tmb_gh_mutation, _tmb_gh_mutation_in and tmb_gh_mutation_from, over the
 * statements cmdStatements lists.
 */
import { gitSubcommand } from './git.js';
const READERS = new Set([
    'echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'cat', 'head', 'tail', 'less', 'more', 'sed', 'awk',
    'gawk', 'jq', 'yq', 'test', '[', '[[', 'man', 'which', 'type', 'wc', 'sort', 'cut', 'tr',
]);
const WRITES = {
    'gh issue': ['create', 'close', 'edit', 'delete', 'comment', 'reopen', 'transfer', 'lock', 'unlock', 'pin', 'unpin', 'develop'],
    'gh pr': ['create', 'merge', 'close', 'edit', 'comment', 'reopen', 'ready', 'review', 'lock', 'unlock'],
    'gh release': ['create', 'edit', 'delete', 'delete-asset', 'upload'],
    'gh repo': ['create', 'delete', 'edit', 'fork', 'rename', 'archive', 'unarchive', 'sync'],
    'gh label': ['create', 'edit', 'delete', 'clone'],
    'glab issue': ['create', 'close', 'update', 'edit', 'delete', 'note', 'reopen'],
    'glab mr': ['create', 'merge', 'close', 'update', 'edit', 'delete', 'note', 'reopen', 'approve', 'rebase'],
    'glab release': ['create', 'update', 'delete', 'upload'],
    'glab repo': ['create', 'delete', 'archive', 'fork', 'transfer'],
};
const API_VERBS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
/** `read -r -a w <<< "$s"`: the first line's blank-separated words. */
function readWords(s) {
    return (s.split('\n')[0] ?? '').split(/[ \t]+/).filter((w) => w !== '');
}
function base(word) {
    return word.slice(word.lastIndexOf('/') + 1);
}
function isForge(word) {
    const b = base(word);
    return b === 'gh' || b === 'glab';
}
/** tmb_gh_mutation_from <words…>: `POST|PATCH|PUT|DELETE` for a writing `gh api`, `<group> <action>` for a write subcommand, else "". */
export function ghMutationFrom(w) {
    const n = w.length;
    const tool = base(w[0] ?? '');
    let k = 1;
    let skipval = false;
    let group = '';
    let action = '';
    while (k < n) {
        const a = w[k];
        k += 1;
        if (skipval) {
            skipval = false;
            continue;
        }
        if (a === '-R' || a === '--repo') {
            skipval = true;
            continue;
        }
        if (a.startsWith('-'))
            continue;
        if (group === '') {
            group = a;
            if (group === 'api')
                break;
            continue;
        }
        action = a;
        break;
    }
    if (group === 'api') {
        let verb = '';
        let fields = false;
        while (k < n) {
            const a = w[k];
            k += 1;
            if (a === '-X' || a === '--method') {
                verb = w[k] ?? '';
                k += 1;
            }
            else if (a.startsWith('--method='))
                verb = a.slice('--method='.length);
            else if (a.startsWith('-X'))
                verb = a.slice(2);
            else if (['-f', '-F', '--field', '--raw-field', '--input'].includes(a)) {
                fields = true;
                k += 1;
            }
            else if (/^(-f|-F|--field=|--raw-field=|--input=)/.test(a))
                fields = true;
        }
        verb = verb.replace(/[a-z]/g, (c) => c.toUpperCase());
        if (verb === '' && fields)
            verb = 'POST';
        return API_VERBS.has(verb) ? verb : '';
    }
    const writes = WRITES[`${tool} ${group}`];
    if (!writes || action === '' || !writes.includes(action))
        return '';
    return `${group} ${action}`;
}
/** _tmb_gh_mutation_in <words…>: the first forge write of a command git runs from its own arguments. */
function ghMutationIn(words) {
    const cmd = words.join(' ');
    if (cmd === '')
        return '';
    const w = readWords(cmd.replaceAll('_', ' '));
    for (let k = 0; k < w.length; k++) {
        if (!isForge(w[k]))
            continue;
        const found = ghMutationFrom(w.slice(k));
        if (found !== '')
            return found;
    }
    return '';
}
function rebaseExec(g) {
    for (let k = 1; k < g.length; k++) {
        const a = g[k];
        let found = '';
        if (a === '--ex' || a === '--exe' || a === '--exec') {
            found = ghMutationIn([g[k + 1] ?? '']);
            k += 1;
        }
        else if (/^--(ex|exe|exec)=/.test(a))
            found = ghMutationIn([a.slice(a.indexOf('=') + 1)]);
        else if (a.startsWith('--'))
            found = '';
        else if (a.startsWith('-') && a.slice(1).includes('x')) {
            const rest = a.slice(a.indexOf('x') + 1);
            if (rest !== '')
                found = ghMutationIn([rest]);
            else {
                found = ghMutationIn([g[k + 1] ?? '']);
                k += 1;
            }
        }
        if (found !== '')
            return found;
    }
    return '';
}
function gitMutation(words) {
    const g = readWords(gitSubcommand(words.join(' ')));
    if (`${g[0] ?? ''} ${g[1] ?? ''}` === 'bisect run')
        return ghMutationIn(g.slice(2));
    if (g[0] === 'submodule') {
        let k = 1;
        while (k < g.length && g[k].startsWith('-'))
            k += 1;
        if (g[k] !== 'foreach')
            return '';
        k += 1;
        while (k < g.length && g[k].startsWith('-'))
            k += 1;
        return ghMutationIn(g.slice(k));
    }
    return g[0] === 'rebase' ? rebaseExec(g) : '';
}
/**
 * tmb_gh_mutation <stmt>: the forge write a statement makes (`gh`/`glab` write
 * subcommands, `gh api` with a write verb, and those a `git rebase --exec`,
 * `bisect run` or `submodule foreach` runs), or "".
 */
export function ghMutation(stmt) {
    const w = readWords(stmt);
    let k = 0;
    while (k < w.length && /^[A-Za-z_][^]*=/.test(w[k]))
        k += 1;
    if (k >= w.length)
        return '';
    const head = base(w[k]);
    if (head === 'git')
        return gitMutation(w.slice(k));
    if (READERS.has(head))
        return '';
    for (; k < w.length; k++) {
        if (!isForge(w[k]))
            continue;
        const found = ghMutationFrom(w.slice(k));
        if (found !== '')
            return found;
    }
    return '';
}
//# sourceMappingURL=forge.js.map