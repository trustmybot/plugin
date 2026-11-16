/**
 * prCreateOf (GH 2225): the PR-create recogniser git-guards and
 * feature-branch-merge-gate share, over statements as cmdStatements lists
 * them (a quoted blank written as `_`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prCreateOf } from '../hooks/lib/pr-create.js';

describe('prCreateOf', () => {
  const recognised: Array<[string, { forge: 'gh' | 'glab'; head: string; base: string }]> = [
    ['gh pr create', { forge: 'gh', head: '', base: '' }],
    ['gh pr create --head feat/x --base dev', { forge: 'gh', head: 'feat/x', base: 'dev' }],
    ['gh pr new -H o:feat/x -B dev', { forge: 'gh', head: 'o:feat/x', base: 'dev' }],
    ['gh -R o/r pr create --head=feat/x --base=dev', { forge: 'gh', head: 'feat/x', base: 'dev' }],
    ['gh --repo o/r pr create -Hfeat/x -B=dev', { forge: 'gh', head: 'feat/x', base: 'dev' }],
    ['gh pr -R o/r create -B dev', { forge: 'gh', head: '', base: 'dev' }],
    ['/usr/local/bin/gh pr create --base dev', { forge: 'gh', head: '', base: 'dev' }],
    ['gh pr create --title use_--base_main --base dev', { forge: 'gh', head: '', base: 'dev' }],
    ['glab mr create --source-branch feat/x --target-branch dev', { forge: 'glab', head: 'feat/x', base: 'dev' }],
    ['glab -R o/r mr new -s feat/x -b dev', { forge: 'glab', head: 'feat/x', base: 'dev' }],
    ['gh api repos/o/r/pulls -f head=feat/x -f base=dev', { forge: 'gh', head: 'feat/x', base: 'dev' }],
    ['gh api /repos/o/r/pulls -Fhead=feat/x --raw-field=base=dev', { forge: 'gh', head: 'feat/x', base: 'dev' }],
    ['gh api -X POST repos/o/r/pulls --input body.json', { forge: 'gh', head: '', base: '' }],
    ['gh api --method post -H Accept:x repos/o/r/pulls', { forge: 'gh', head: '', base: '' }],
    [
      'gh api graphql -f query=mutation_{_createPullRequest_input:_{baseRefName:_"dev",_headRefName:_"feat/x"}__{_pullRequest_{_id_}_}_}',
      { forge: 'gh', head: 'feat/x', base: 'dev' },
    ],
    [
      'gh api graphql -f query=mutation_{_createPullRequest_input:_{headRefName:_$h}__{_x_}_} -f headRefName=feat/x -f baseRefName=dev',
      { forge: 'gh', head: 'feat/x', base: 'dev' },
    ],
  ];
  for (const [stmt, expected] of recognised) {
    it(`recognises ${stmt}`, () => assert.deepEqual(prCreateOf(stmt), expected));
  }

  for (const stmt of [
    'gh pr view 3',
    'gh pr list --head feat/x',
    'gh -R o/r pr merge 3',
    'gh pr checkout create',
    'glab mr list',
    'gh api repos/o/r/pulls',
    'gh api -X GET repos/o/r/pulls -f state=open',
    'gh api repos/o/r/pulls/3',
    'gh api repos/o/r/pulls/3 -X PATCH -f base=dev',
    'gh api repos/o/r/pulls/3/comments -f body=x',
    'gh api graphql -f query={_viewer_{_login_}_}',
    'gh issue create --title pr_create',
    'echo gh pr create',
    'git push origin feat/x',
  ]) {
    it(`leaves ${stmt} unrecognised`, () => assert.equal(prCreateOf(stmt), null));
  }
});
