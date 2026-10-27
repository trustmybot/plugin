import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AREA_OPTIONS, FORM_FIELDS, IMPACT_OPTIONS, IMPACT_PRIORITY, REPORT_MARKER_RE, } from '../bug-report/form.js';
import { EMAIL_RE, TOKEN_PATTERNS, redact } from '../bug-report/redact.js';
import { PREFILL_MAX_CHARS, render } from '../bug-report/render.js';
const t = (...parts) => parts.join('');
const TOKENS = {
    ghp: t('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
    gho: t('gh', 'o_', 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8'),
    ghs: t('gh', 's_', 'Server1Token2Value3Here4Abcdef5Ghij6'),
    pat: t('github', '_pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'),
    glpat: t('gl', 'pat-', 'xYz123AbC456dEf789gH'),
    sk: t('s', 'k-', 'ant-api03-AbCdEfGhIjKlMnOpQrStUv'),
    slack: t('xo', 'xb-', '1234567890-0987654321-AbCdEfGhIjKl'),
    aws: t('AK', 'IA', 'Q3EXAMPLEKEY7ZZZ'),
    jwt: t('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiJhbGljZSJ9', '.', 'c2lnbmF0dXJlLXZhbHVl'),
    pem: t('-----BEGIN RSA ', 'PRIVATE KEY-----\n', 'MIIEowIBAAKCAQEA7x\nq9ZKvG2a0\n', '-----END RSA ', 'PRIVATE KEY-----'),
};
const KEPT_URL = 'https://github.com/trustmybot/plugin/issues/2034';
const SURVIVOR_TAIL = ` Seen on main and dev, tracked at ${KEPT_URL}.`;
function ctxOf(partial) {
    return {
        remoteUrls: [],
        repoNames: [],
        branchNames: ['main', 'dev'],
        titles: [],
        ...partial,
    };
}
function baseInput(over) {
    return {
        tool: 'task_update_status',
        error_class: 'SqliteError',
        summary: 'task_update_status fails',
        reproduce: '1. Run the close.',
        frequency: 'Every time',
        error: 'SqliteError: database is locked',
        area: 'Trajectory Server',
        impact: 'Blocks one task, has a workaround',
        ...over,
        'what-happened': (over['what-happened'] ?? 'Expected the task to close.') + SURVIVOR_TAIL,
    };
}
const FIXTURES = [
    {
        name: 'macOS home, project, https GitHub remote, ghp token, email',
        ctx: ctxOf({
            home: '/Users/alice',
            projectRoot: '/Users/alice/code/acme-api',
            remoteUrls: ['https://github.com/acme-corp/acme-api.git'],
            repoNames: ['acme-api'],
            branchNames: ['feat/acme-login', 'main', 'dev'],
            titles: ['Acme billing outage on checkout'],
        }),
        input: baseInput({
            summary: 'close fails in /Users/alice/code/acme-api on feat/acme-login',
            'what-happened': `Pushing to https://github.com/acme-corp/acme-api.git with ${TOKENS.ghp} failed; mail alice@acme-corp.com.`,
            error: 'ENOENT: /Users/alice/code/acme-api/.tmb/db.sqlite at line 12',
            reproduce: 'Work on "Acme billing outage on checkout" then run /onboard.',
        }),
        env: { os: 'darwin 25.6.0', cwd: '/Users/alice/code/acme-api', node: 'v22.11.0' },
        leaks: ['/Users/alice', 'acme-corp/acme-api', 'alice@acme-corp.com', 'feat/acme-login', 'Acme billing outage on checkout'],
    },
    {
        name: 'Linux home, ssh GitLab remote, glpat token',
        ctx: ctxOf({
            home: '/home/bob',
            projectRoot: '/home/bob/work/widgets',
            remoteUrls: ['ssh://git@gitlab.com/bobco/widgets.git'],
            repoNames: ['widgets'],
            branchNames: ['bob/widget-rewrite', 'main', 'dev'],
        }),
        input: baseInput({
            'what-happened': `Remote ssh://git@gitlab.com/bobco/widgets.git rejected ${TOKENS.glpat} on bob/widget-rewrite.`,
            error: 'Error: cannot open /home/bob/work/widgets/src/index.ts:44:2',
            doctor: 'plugin cache: /home/bob/.claude/plugins/cache ok',
        }),
        env: { os: 'linux 6.8', shell: '/usr/bin/zsh', home: '/home/bob' },
        leaks: ['/home/bob', 'bobco/widgets', 'bob/widget-rewrite'],
    },
    {
        name: 'Windows home and project, git@ GitHub remote, sk token',
        ctx: ctxOf({
            home: 'C:\\Users\\Carol',
            projectRoot: 'C:\\Users\\Carol\\src\\ledger',
            remoteUrls: ['git@github.com:carol-co/ledger.git'],
            repoNames: ['ledger'],
            branchNames: ['carol/fix-rounding', 'main', 'dev'],
        }),
        input: baseInput({
            'what-happened': `Fetch from git@github.com:carol-co/ledger.git with key ${TOKENS.sk} on carol/fix-rounding.`,
            error: 'EPERM: C:\\Users\\Carol\\src\\ledger\\.tmb\\db.sqlite and C:/Users/Carol/AppData/Local/tmb/log.txt',
            'repro-script': 'cd C:\\Users\\Carol\\src\\ledger\nnode dist\\index.js',
        }),
        env: { os: 'win32 10.0.22631', cwd: 'C:\\Users\\Carol\\src\\ledger' },
        leaks: ['C:\\Users\\Carol', 'C:/Users/Carol', 'carol-co/ledger', 'carol/fix-rounding'],
    },
    {
        name: 'self-hosted GitLab https remote, Slack token',
        ctx: ctxOf({
            home: '/Users/dana',
            projectRoot: '/Users/dana/infra',
            remoteUrls: ['https://gitlab.example-corp.io/platform/infra.git'],
            repoNames: ['infra'],
        }),
        input: baseInput({
            'what-happened': `Webhook ${TOKENS.slack} posted for https://gitlab.example-corp.io/platform/infra/-/merge_requests/9.`,
            error: 'fatal: https://gitlab.example-corp.io/platform/infra.git not found',
        }),
        env: { os: 'darwin 24.1' },
        leaks: ['/Users/dana', 'gitlab.example-corp.io', 'platform/infra'],
    },
    {
        name: 'AWS key and JWT in error text',
        ctx: ctxOf({ home: '/home/erin', projectRoot: '/home/erin/svc' }),
        input: baseInput({
            error: `AccessDenied for ${TOKENS.aws}; bearer ${TOKENS.jwt} rejected at /home/erin/svc/app.ts`,
        }),
        env: { os: 'linux 6.1' },
        leaks: ['/home/erin', TOKENS.aws, TOKENS.jwt],
    },
    {
        name: 'PEM private key block',
        ctx: ctxOf({ home: '/Users/frank', projectRoot: '/Users/frank/keys-demo' }),
        input: baseInput({
            error: `Loaded key:\n${TOKENS.pem}\nthen crashed`,
            doctor: `key file ${TOKENS.pem}`,
        }),
        env: { os: 'darwin 25.0' },
        leaks: ['/Users/frank', 'MIIEowIBAAKCAQEA7x', 'q9ZKvG2a0'],
    },
    {
        name: 'fine-grained PAT and gho/ghs tokens',
        ctx: ctxOf({ home: '/home/gina', projectRoot: '/home/gina/app' }),
        input: baseInput({
            'what-happened': `gh auth used ${TOKENS.pat}, oauth ${TOKENS.gho}, app ${TOKENS.ghs}.`,
        }),
        env: { gh: 'gh 2.60.0', token_hint: TOKENS.gho },
        leaks: ['/home/gina', TOKENS.pat, TOKENS.gho, TOKENS.ghs],
    },
    {
        name: 'several emails, plus-addressed and subdomain',
        ctx: ctxOf({ home: '/Users/hank', projectRoot: '/Users/hank/site' }),
        input: baseInput({
            'what-happened': 'Notified hank+tmb@mail.hank.dev and ops.team@corp.example.co.uk, cc <h.k@x.io>.',
            workaround: 'Ask security@corp.example.co.uk to rotate.',
        }),
        env: { git_user: 'Hank <hank+tmb@mail.hank.dev>' },
        leaks: ['hank+tmb@mail.hank.dev', 'ops.team@corp.example.co.uk', 'h.k@x.io', 'security@corp.example.co.uk'],
    },
    {
        name: 'feature-branch names, kept main/dev/HEAD',
        ctx: ctxOf({
            home: '/home/ivy',
            projectRoot: '/home/ivy/payments',
            branchNames: ['fix/ISSUE-42-payments', 'ivy/experiment.v2', 'main', 'dev', 'HEAD'],
        }),
        input: baseInput({
            'what-happened': 'Rebasing fix/ISSUE-42-payments onto origin/ivy/experiment.v2 left HEAD detached.',
            reproduce: 'git checkout fix/ISSUE-42-payments && git merge dev',
        }),
        env: { branch: 'fix/ISSUE-42-payments' },
        leaks: ['fix/ISSUE-42-payments', 'ivy/experiment.v2', '/home/ivy'],
    },
    {
        name: 'local issue titles in free text',
        ctx: ctxOf({
            home: '/Users/jack',
            projectRoot: '/Users/jack/crm',
            titles: ['Migrate CRM contacts to Postgres', 'Secret partner rollout'],
        }),
        input: baseInput({
            summary: 'Close fails on Migrate CRM contacts to Postgres',
            reproduce: 'Plan "Secret partner rollout", then close task 3 of Migrate CRM contacts to Postgres.',
        }),
        env: { issue: 'Secret partner rollout' },
        leaks: ['Migrate CRM contacts to Postgres', 'Secret partner rollout'],
    },
    {
        name: 'absolute paths outside home and project',
        ctx: ctxOf({ home: '/Users/kim', projectRoot: '/Users/kim/dash' }),
        input: baseInput({
            error: 'read /opt/acmecorp/secret-config/app.yml and /var/lib/acmecorp/state.db failed',
            doctor: 'PATH=/usr/local/bin:/opt/acmecorp/tools/bin',
        }),
        env: { node_path: '/opt/acmecorp/node/bin/node' },
        leaks: ['/opt/acmecorp', '/var/lib/acmecorp', '/Users/kim'],
    },
    {
        name: 'credentials in an https remote and an oversized repro script',
        ctx: ctxOf({
            home: '/home/lee',
            projectRoot: '/home/lee/monorepo',
            remoteUrls: [`https://deploy:${TOKENS.ghp}@github.com/lee-org/monorepo.git`],
            repoNames: ['monorepo'],
        }),
        input: baseInput({
            'what-happened': `Push to https://deploy:${TOKENS.ghp}@github.com/lee-org/monorepo.git hung.`,
            'repro-script': 'echo step\n'.repeat(900),
            doctor: 'ok\n'.repeat(400),
        }),
        env: { os: 'linux 6.5' },
        leaks: ['/home/lee', 'lee-org/monorepo', 'deploy:'],
    },
    {
        name: 'Windows UNC path and forward-slash home',
        ctx: ctxOf({ home: 'C:\\Users\\Mia', projectRoot: 'D:\\work\\mia-tools' }),
        input: baseInput({
            error: 'cannot read \\\\fileserver\\mia-share\\cfg.json nor C:/Users/Mia/.claude/settings.json nor D:\\work\\mia-tools\\x.ts',
        }),
        env: { os: 'win32 11' },
        leaks: ['fileserver', 'mia-share', 'C:/Users/Mia', 'C:\\Users\\Mia', 'D:\\work\\mia-tools'],
    },
    {
        name: 'credentialed https and ssh remotes absent from remoteUrls',
        ctx: ctxOf({ home: '/Users/nora', projectRoot: '/Users/nora/p' }),
        input: baseInput({
            'what-happened': [
                `push https://user:${TOKENS.ghp}@github.com/acme/private-repo failed`,
                `push https://${TOKENS.ghp}@github.com/acme/private-repo.git failed`,
                `push https://oauth2:${TOKENS.glpat}@gitlab.com/acme/secret-svc.git failed`,
                `push ssh://alice:${TOKENS.ghp}@github.com/acme/private-repo.git failed`,
            ].join('\n'),
            error: `fatal: https://oauth2:${TOKENS.glpat}@gitlab.com/acme/secret-svc.git not found`,
        }),
        env: { remote: `ssh://alice:${TOKENS.ghp}@github.com/acme/private-repo.git` },
        leaks: ['acme', 'private-repo', 'secret-svc', 'github.com/acme', 'gitlab.com/acme', 'user:', 'oauth2:', 'alice:'],
    },
    {
        name: 'title glued to a branch or repo name',
        ctx: ctxOf({
            home: '/home/otto',
            projectRoot: '/home/otto/p',
            repoNames: ['widgets'],
            branchNames: ['feature', 'main', 'dev'],
            titles: ['My Title'],
        }),
        input: baseInput({
            summary: 'My Titlefeature breaks',
            'what-happened': 'Saw My Titlewidgets and My Titlefeature in the log.',
            error: 'Error: My Titlewidgets',
        }),
        env: { issue: 'My Titlefeature' },
        leaks: ['My Title', 'feature', 'widgets'],
    },
];
function outputsOf(report) {
    return [report.title, report.body, report.prefill_url, decodeURIComponent(report.prefill_url)];
}
function rehome(fixture, newHome) {
    const oldHome = fixture.ctx.home;
    const swap = (s) => s
        .split(oldHome).join(newHome)
        .split(oldHome.replace(/\\/g, '/')).join(newHome.replace(/\\/g, '/'));
    const input = Object.fromEntries(Object.entries(fixture.input).map(([k, v]) => [k, swap(String(v))]));
    const env = Object.fromEntries(Object.entries(fixture.env).map(([k, v]) => [k, swap(v)]));
    return { input, env, ctx: { ...fixture.ctx, home: newHome, projectRoot: swap(fixture.ctx.projectRoot) } };
}
describe('GH 2034 V5: rendered bug reports leak no private data across the fixture corpus', () => {
    it('has at least 12 fixtures', () => {
        assert.ok(FIXTURES.length >= 12);
    });
    for (const fixture of FIXTURES) {
        describe(fixture.name, () => {
            const report = render(fixture.input, fixture.env, fixture.ctx);
            it('every render() key is non-empty', () => {
                for (const [key, value] of Object.entries(report)) {
                    if (typeof value === 'boolean')
                        continue;
                    assert.ok(typeof value === 'string' && value.length > 0, `${key} is empty`);
                }
                assert.equal(typeof report.prefill_truncated, 'boolean');
            });
            it('contains no home, project root, remote, email, branch, title or token', () => {
                const secrets = [
                    fixture.ctx.home,
                    fixture.ctx.projectRoot,
                    ...fixture.ctx.remoteUrls,
                    ...fixture.ctx.titles,
                    ...fixture.ctx.branchNames.filter((b) => !['main', 'dev', 'HEAD'].includes(b)),
                    ...fixture.leaks,
                ];
                for (const out of outputsOf(report)) {
                    for (const secret of secrets) {
                        assert.ok(!out.includes(secret), `${JSON.stringify(secret)} leaked into ${out.slice(0, 200)}`);
                    }
                    for (const re of [...TOKEN_PATTERNS, EMAIL_RE]) {
                        const hit = out.match(new RegExp(re.source, re.flags));
                        assert.equal(hit, null, `${re} matched ${hit?.[0]}`);
                    }
                }
            });
            it('keeps main, dev and the trustmybot/plugin URL', () => {
                assert.match(report.body, /\bmain\b/);
                assert.match(report.body, /\bdev\b/);
                assert.ok(report.body.includes(KEPT_URL));
                assert.ok(decodeURIComponent(report.prefill_url).includes(KEPT_URL));
            });
            it('signature is stable across runs with different homes', () => {
                const other = rehome(fixture, fixture.ctx.home.includes('\\') ? 'C:\\Users\\Zed' : '/home/zed');
                const again = render(other.input, other.env, other.ctx);
                assert.equal(again.signature, report.signature);
                assert.equal(render(fixture.input, fixture.env, fixture.ctx).signature, report.signature);
            });
            it('redact is idempotent on every field', () => {
                const texts = [...Object.values(fixture.input).map(String), ...Object.values(fixture.env)];
                for (const text of texts) {
                    const once = redact(text, fixture.ctx).text;
                    assert.equal(redact(once, fixture.ctx).text, once);
                }
            });
            it('prefill URL stays within the limit', () => {
                assert.ok(report.prefill_url.length <= PREFILL_MAX_CHARS || report.prefill_truncated);
            });
        });
    }
});
describe('bug-report form', () => {
    it('lists the twelve fields in order with labels, types and required flags', () => {
        const rows = FORM_FIELDS.map((f) => [f.id, f.label, f.type, f.required, f.render ?? null]);
        assert.deepEqual(rows, [
            ['summary', 'What broke', 'input', true, null],
            ['what-happened', 'Expected vs actual', 'textarea', true, null],
            ['reproduce', 'Steps to reproduce', 'textarea', true, null],
            ['repro-script', 'Minimal repro script', 'textarea', false, 'shell'],
            ['frequency', 'How often', 'dropdown', true, null],
            ['error', 'Error message', 'textarea', true, 'text'],
            ['area', 'Area', 'dropdown', true, null],
            ['impact', 'Impact', 'dropdown', true, null],
            ['environment', 'Environment', 'textarea', true, 'text'],
            ['doctor', 'Doctor output', 'textarea', false, 'text'],
            ['workaround', 'Workaround', 'textarea', false, null],
            ['checks', 'Checks', 'checkboxes', true, null],
        ]);
    });
    it('carries the dropdown and checkbox options', () => {
        const byId = Object.fromEntries(FORM_FIELDS.map((f) => [f.id, f.options]));
        assert.deepEqual(byId.frequency, ['Every time', 'Sometimes', 'Once']);
        assert.deepEqual(byId.area, [...AREA_OPTIONS]);
        assert.equal(AREA_OPTIONS.length, 9);
        assert.deepEqual(byId.impact, [...IMPACT_OPTIONS]);
        assert.deepEqual(byId.checks, [
            { label: 'I searched existing issues for this error.', required: true },
            { label: 'I read this report and it contains no secrets, private code or personal paths.', required: true },
            { label: 'It still happens on the latest version.', required: false },
        ]);
    });
    it('maps impact to priority labels and matches the report marker', () => {
        assert.deepEqual(IMPACT_PRIORITY, {
            'Blocks all TMB work': 'Priority: High',
            'Blocks one task, has a workaround': 'Priority: Medium',
            'Annoying or cosmetic': 'Priority: Low',
        });
        assert.equal(REPORT_MARKER_RE.exec('x <!-- tmb-report v1 sig=0123456789ab --> y')?.[1], '0123456789ab');
        assert.equal(REPORT_MARKER_RE.test('<!-- tmb-report v1 sig=0123 -->'), false);
    });
});
describe('redact', () => {
    const ctx = ctxOf({
        home: '/Users/alice',
        projectRoot: '/Users/alice/proj',
        remoteUrls: ['https://github.com/acme/proj.git'],
        repoNames: ['proj', 'plugin', 'ab'],
        branchNames: ['feat/x-login', 'main', 'master', 'develop'],
        titles: ['Ship the thing', 'abc'],
    });
    it('applies each rule and counts it', () => {
        const { text, counts } = redact([
            `token ${TOKENS.ghp}`,
            'mail a@b.io',
            'remote https://github.com/acme/proj.git and git@gitlab.com:other/repo.git',
            'paths /Users/alice/proj/src/a.ts /Users/alice/notes.md /etc/acme/conf.d/x.conf',
            'branch feat/x-login, main, master, develop',
            'repo proj in projector, plugin',
            'title Ship the thing; abc',
        ].join('\n'), ctx);
        assert.equal(text, [
            'token <redacted>',
            'mail <email>',
            'remote <repo> and <repo>',
            'paths <project>/src/a.ts ~/notes.md <path>/x.conf',
            'branch <branch>, main, master, develop',
            'repo <repo> in projector, plugin',
            'title <title>; abc',
        ].join('\n'));
        assert.deepEqual(counts, { token: 1, email: 1, remote: 2, project: 1, home: 1, path: 1, branch: 1, repo: 1, title: 1 });
    });
    it('does not treat git@ remotes as emails and keeps trustmybot/plugin in every form', () => {
        const kept = 'https://github.com/trustmybot/plugin git@github.com:trustmybot/plugin.git https://github.com/trustmybot/plugin/issues/1';
        assert.equal(redact(kept, ctx).text, kept);
        assert.equal(redact('ssh://git@github.com/acme/private.git', ctx).text, '<repo>');
    });
    it('leaves slash commands, relative paths and home-relative paths alone', () => {
        const text = 'run /onboard then edit src/bug-report/form.ts and ~/notes/a.md';
        assert.equal(redact(text, ctx).text, text);
    });
    it('does not match a home prefix inside a longer user name', () => {
        assert.equal(redact('/Users/alice2/x/y', ctx).text, '<path>/y');
    });
    it('redacts credentialed https and ssh remotes not listed in remoteUrls', () => {
        const bare = ctxOf({ home: '/Users/a', projectRoot: '/Users/a/p' });
        for (const url of [
            `https://user:${TOKENS.ghp}@github.com/acme/private-repo`,
            `https://${TOKENS.ghp}@github.com/acme/private-repo.git`,
            `https://oauth2:${TOKENS.glpat}@gitlab.com/acme/secret-svc.git`,
            `ssh://alice:${TOKENS.ghp}@github.com/acme/private-repo.git`,
        ]) {
            assert.equal(redact(`push ${url} failed`, bare).text, 'push <repo> failed');
        }
    });
    it('reaches a fixpoint when a title is glued to a branch or repo name', () => {
        const glued = ctxOf({
            home: '/Users/a',
            projectRoot: '/Users/a/p',
            repoNames: ['widgets'],
            branchNames: ['feature'],
            titles: ['My Title'],
        });
        for (const [input, expected] of [
            ['My Titlefeature', '<title><branch>'],
            ['My Titlewidgets', '<title><repo>'],
        ]) {
            const once = redact(input, glued).text;
            assert.equal(once, expected);
            assert.equal(redact(once, glued).text, once);
        }
    });
    it('redacts an unterminated PEM block to the end of the text', () => {
        const pemStart = t('-----BEGIN OPENSSH ', 'PRIVATE KEY-----');
        assert.equal(redact(`before\n${pemStart}\nAAAA\nBBBB`, ctx).text, 'before\n<redacted>');
    });
});
describe('render', () => {
    const ctx = ctxOf({ home: '/Users/alice', projectRoot: '/Users/alice/proj' });
    const input = {
        tool: 'scan_run',
        error_class: 'TypeError',
        summary: 'scan fails',
        'what-happened': 'Expected a scan.',
        reproduce: 'Run /scan.',
        frequency: 'Sometimes',
        error: 'TypeError: x is undefined at /Users/alice/proj/a.ts:12',
        area: 'World Model',
        impact: 'Annoying or cosmetic',
    };
    const env = { os: 'darwin', node: 'v22.1.0' };
    it('renders one block per field, fences render fields and ends with the marker', () => {
        const report = render(input, env, ctx);
        const labels = [...report.body.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
        assert.deepEqual(labels, FORM_FIELDS.map((f) => f.label));
        assert.ok(report.body.includes('### Error message\n\n```text\nTypeError: x is undefined at <project>/a.ts:12\n```'));
        assert.ok(report.body.includes('### Minimal repro script\n\n_No response_'));
        assert.ok(report.body.includes('### Workaround\n\n_No response_'));
        assert.ok(report.body.includes(`### Environment\n\n\`\`\`text\nos: darwin\nnode: v22.1.0\nsignature: ${report.signature}\n\`\`\``));
        assert.ok(report.body.includes('### Checks\n\n- [x] I searched existing issues for this error.\n'
            + '- [ ] I read this report and it contains no secrets, private code or personal paths.\n'
            + '- [ ] It still happens on the latest version.'));
        assert.equal(report.body.split('\n').at(-1), report.marker);
        assert.equal(report.marker, `<!-- tmb-report v1 sig=${report.signature} -->`);
        assert.match(report.signature, /^[0-9a-f]{12}$/);
        assert.equal(report.title, '🐛 scan fails');
    });
    it('signature ignores digit runs and whitespace in the error', () => {
        const a = render({ ...input, error: 'TypeError:  x at line 12' }, env, ctx).signature;
        const b = render({ ...input, error: 'TypeError: x at line 999' }, env, ctx).signature;
        const c = render({ ...input, tool: 'other_tool', error: 'TypeError: x at line 999' }, env, ctx).signature;
        assert.equal(a, b);
        assert.notEqual(a, c);
    });
    it('caps the title at 80 characters', () => {
        const report = render({ ...input, summary: 'word '.repeat(40) }, env, ctx);
        assert.ok(Array.from(report.title).length <= 80);
        assert.ok(report.title.startsWith('🐛 word'));
    });
    it('prefills every non-checks field and drops the long optional ones first', () => {
        const short = render(input, env, ctx);
        const url = new URL(short.prefill_url);
        assert.equal(url.origin + url.pathname, 'https://github.com/trustmybot/plugin/issues/new');
        assert.equal(url.searchParams.get('template'), 'bug.yml');
        assert.equal(url.searchParams.get('title'), '🐛 scan fails');
        const ids = FORM_FIELDS.filter((f) => f.type !== 'checkboxes').map((f) => f.id);
        assert.deepEqual([...url.searchParams.keys()], ['template', 'title', ...ids]);
        assert.equal(short.prefill_truncated, false);
        const long = render({ ...input, 'repro-script': 'echo hi\n'.repeat(1200) }, env, ctx);
        const longUrl = new URL(long.prefill_url);
        assert.equal(long.prefill_truncated, true);
        assert.equal(longUrl.searchParams.has('repro-script'), false);
        assert.equal(longUrl.searchParams.has('doctor'), true);
        assert.ok(long.prefill_url.length <= PREFILL_MAX_CHARS);
    });
    it('rejects a dropdown value outside its options', () => {
        assert.throws(() => render({ ...input, area: 'Nope' }, env, ctx), /area must be one of/);
    });
});
describe('bug-report modules', () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'bug-report');
    it('define no unused module-private helpers', () => {
        for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
            const source = readFileSync(join(srcDir, file), 'utf8');
            for (const [, name] of source.matchAll(/^(?:function|const)\s+([A-Za-z_$][\w$]*)/gm)) {
                const uses = source.match(new RegExp(String.raw `\b${name}\b`, 'g'))?.length ?? 0;
                assert.ok(uses > 1, `${file}: ${name} is defined but never used`);
            }
        }
    });
});
//# sourceMappingURL=bug-report.test.js.map