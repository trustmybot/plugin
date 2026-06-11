import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl } from '../utils/classify-url.js';
describe('classifyUrl — host-based provider classification', () => {
    describe('github.com', () => {
        it('https remote classifies as github', () => {
            assert.equal(classifyUrl('https://github.com/owner/repo'), 'github');
        });
        it('ssh scp-form classifies as github', () => {
            assert.equal(classifyUrl('git@github.com:owner/repo.git'), 'github');
        });
        it('github.com only in path classifies as other (not github)', () => {
            assert.equal(classifyUrl('https://evil.com/github.com/x'), 'other');
        });
        it('subdomain of github.com classifies as github', () => {
            assert.equal(classifyUrl('https://gist.github.com/owner/abc'), 'github');
        });
    });
    describe('gitlab', () => {
        it('https gitlab.com remote classifies as gitlab', () => {
            assert.equal(classifyUrl('https://gitlab.com/owner/repo'), 'gitlab');
        });
        it('ssh scp-form gitlab.com classifies as gitlab', () => {
            assert.equal(classifyUrl('git@gitlab.com:owner/repo.git'), 'gitlab');
        });
        it('self-hosted gitlab.<corp>.<tld> classifies as gitlab', () => {
            assert.equal(classifyUrl('https://gitlab.corp.example/owner/repo'), 'gitlab');
        });
        it('ssh scp-form self-hosted gitlab classifies as gitlab', () => {
            assert.equal(classifyUrl('git@gitlab.corp.example:owner/repo.git'), 'gitlab');
        });
    });
    describe('bitbucket', () => {
        it('https bitbucket.org classifies as bitbucket', () => {
            assert.equal(classifyUrl('https://bitbucket.org/owner/repo'), 'bitbucket');
        });
        it('ssh scp-form bitbucket classifies as bitbucket', () => {
            assert.equal(classifyUrl('git@bitbucket.org:owner/repo.git'), 'bitbucket');
        });
    });
    describe('codeberg', () => {
        it('https codeberg.org classifies as codeberg', () => {
            assert.equal(classifyUrl('https://codeberg.org/owner/repo'), 'codeberg');
        });
        it('ssh scp-form codeberg classifies as codeberg', () => {
            assert.equal(classifyUrl('git@codeberg.org:owner/repo.git'), 'codeberg');
        });
    });
    describe('azure devops', () => {
        it('https dev.azure.com classifies as azuredev', () => {
            assert.equal(classifyUrl('https://dev.azure.com/org/project/_git/repo'), 'azuredev');
        });
    });
    describe('other / unknown', () => {
        it('unknown host classifies as other', () => {
            assert.equal(classifyUrl('https://selfhosted.example.com/owner/repo'), 'other');
        });
        it('empty string classifies as other', () => {
            assert.equal(classifyUrl(''), 'other');
        });
    });
});
//# sourceMappingURL=classify-url.test.js.map