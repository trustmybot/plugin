/**
 * The cmd-analysis helpers (GH 1692), ported from the bash cmd-analysis l3
 * test: tmb_cmd_strip_literals, tmb_cmd_write_targets,
 * tmb_cmd_heredoc_bodies, tmb_cmd_write_shapes, tmb_is_prompt_surface_path,
 * tmb_path_canonical, tmb_cmd_statements, tmb_stmt_repo_root, the git and gh
 * helpers, tmb_agent_role, tmb_is_harness_turn,
 * tmb_deny_ambiguous_git_target and tmb_strip_quoted_spans, plus the
 * run_bounded watchdog (run-bounded-child.ts). Each case is judged on the
 * frozen answers of the shell lib and, where the TS module has the same
 * function, on the TS too.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  cmdStatements,
  cwdState,
  denyAmbiguousGitTarget,
  gitSubcommand,
  stmtRepoRoot,
  stripLiterals,
  writeShapes,
} from '../hooks/cmd-analysis/index.js';
import { gitCommitMessage } from '../hooks/cmd-analysis/commit-message.js';
import { isHarnessTurn } from '../hooks/cmd-analysis/harness-turn.js';
import { agentRole } from '../hooks/lib/role.js';
import { stripQuotedSpans } from '../hooks/prompt-intent-hints.js';
import {
  DIVERGENT,
  PLUGIN_ROOT,
  SH_ONLY,
  Suite,
  canonical,
  dropFirst,
  ghm,
  ghs,
  lastField,
  paste,
  runBounded,
  runSuite,
  spawnBounded,
  stmts,
  strip,
  surface,
  targets,
  type Probe,
} from './cmd-analysis-l3.js';

const lines = (...xs: string[]): string => xs.join('\n');
const TWO_HEREDOCS = lines('cat <<A <<B', 'git push', 'A', 'git commit -m x', 'B', 'git status');
const TMP = mkdtempSync(join(tmpdir(), 'tmb-cmd-analysis-'));
const REAL = realpathSync(TMP);
const PLAIN = join(TMP, 'plain');
const REPO = join(TMP, 'repo');
const SURF = join(TMP, 'surf');
mkdirSync(PLAIN);
after(() => rmSync(TMP, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

function stripJoined(cmd: string): Probe {
  return { ts: () => paste(stripLiterals(cmd), '|') };
}

const bodies = (_cmd: string): Probe => SH_ONLY;

function status(ts: (arg: string) => boolean, arg: string): Probe {
  return { ts: () => String(ts(arg)) };
}

const P = (cmd: string): Probe => stmts(cmd, PLAIN);
const G = (cmd: string): Probe => ghs(cmd, PLAIN);
const HEREDOC_CMD = lines("cat > notes.md <<'EOF'", 'git commit -m x', 'gh pr merge 1', 'EOF');

const commitMessage = (cmd: string): Probe =>
  ({
    ts: async () => {
      const m = await gitCommitMessage(cmd);
      return m.ok ? m.message : '';
    },
  });

const reason = (json: string): string =>
  (JSON.parse(json) as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason;

const s = new Suite('helpers').token('<TMP>', TMP).token('<REAL>', REAL);

s.group('tmb_cmd_strip_literals drops heredoc bodies and neutralizes quoted operators')
  .eq('cat <<EOF > out.txt|echo done', stripJoined(lines("cat <<'EOF' > out.txt", 'x > /tmp/z', 'EOF', 'echo done')), 'the heredoc body is gone, the operator line stays')
  .eq('echo __/tmp/z', strip('echo "> /tmp/z"'), 'a quoted redirect is one word')
  .eq('echo a___b >/tmp/q', strip("echo 'a > b' >/tmp/q"), 'single quotes too; the real redirect stays')
  .eq('mkdir $TMB_MODEL_CACHE_DIR/x', strip('mkdir "$TMB_MODEL_CACHE_DIR"/x'), 'quotes removed around a variable')
  .eq('grep x f ', strip('grep x f # > /tmp/c'), 'comments dropped')
  .eq('cat <<END', strip('cat <<-END\n\tbody > /tmp/z\n\tEND'), '<<- strips leading tabs before the delimiter');

s.group('tmb_cmd_write_targets finds every write position')
  .eq('~/.claude/y,', targets('echo hi > ~/.claude/y'), 'redirect')
  .eq('/dev/null,log.txt,', targets('ls 2>/dev/null >>log.txt'), 'fd redirect and append')
  .eq('', targets('echo x 2>&1 >&2'), 'fd duplications are not paths')
  .eq('/tmp/both,', targets('cmd &>/tmp/both'), '&> redirect')
  .eq('/tmp/t1,out,', targets('echo x | tee -a /tmp/t1 out'), 'tee arguments')
  .eq('/tmp/dest,/var/x,', targets('cp a b /tmp/dest && mv -t /var/x f'), 'cp destination, mv -t')
  .eq('/opt/x,', targets('FOO=1 sudo install -d /opt/x'), 'assignments and sudo skipped; install -d')
  .eq('', targets('rsync -a src/ host:/remote'), 'a remote rsync destination is not local')
  .eq('/tmp/foo*,a_b,', targets('rm -rf /tmp/foo* ; touch "a b"'), 'rm and touch arguments')
  .eq('../wt,', targets('git -C repo worktree add -b feat ../wt base'), 'git worktree add path')
  .eq('/tmp/clone,', targets('git clone --depth 1 https://x/y.git /tmp/clone'), 'git clone directory')
  .eq('', targets('git clone https://x/y.git'), 'git clone into cwd names no path')
  .eq('', targets('cat ~/.claude.json; grep -r x /etc'), 'reads name no write position');

s.group('tmb_cmd_write_targets treats every link as a write')
  .eq('root/link,/outside,', targets('ln -s /outside root/link'), 'ln -s destination and absolute source')
  .eq('build/y,build/../x,build/y/../x,', targets('ln -sf ../x build/y'), "a relative ln -s source read against the link's directory")
  .eq('b,a,', targets('ln a b'), 'hard link destination and source')
  .eq('dir,dir/../a,/b,', targets('ln -s -t dir ../a /b'), 'ln -t directory and sources')
  .eq('p,/etc/passwd,', targets('link /etc/passwd p'), 'link destination and source')
  .eq('/o/f,here,', targets('cp -s /o/f here'), 'cp -s source and destination')
  .eq('/o,d,', targets('cp -al /o d'), 'cp -l source and destination')
  .eq('b,', targets('cp a b'), 'a plain cp names only its destination');

s.group('tmb_cmd_write_targets: dd of=, truncate, git mv')
  .eq('out.img,', targets('dd if=in.img of=out.img bs=1M'), 'dd of=')
  .eq('a,b,', targets('truncate -s 0 a b'), 'truncate files, not the size')
  .eq('d/x.md,', targets('git -C r mv -f x.md d/x.md'), 'git mv destination');

s.group('tmb_cmd_heredoc_bodies: every form, with its delimiter and statement (GH 1279)')
  .eq('1#EOF#a > b|c', bodies(lines('cat <<EOF', 'a > b', 'c', 'EOF')), '<<EOF')
  .eq('1#EOF#a|b', bodies('cat <<-EOF\n\ta\n\tb\n\tEOF'), '<<-EOF strips leading tabs')
  .eq('1#EOF#$x', bodies(lines("cat <<'EOF'", '$x', 'EOF')), "<<'EOF'")
  .eq('1#EOF#y', bodies(lines('cat <<"EOF"', 'y', 'EOF')), '<<"EOF"')
  .eq('1#A#one;1#B#two', bodies(lines('cat <<A 3<<B', 'one', 'A', 'two', 'B')), 'two heredocs in one statement')
  .eq('2#EOF#in', bodies(lines('echo $(cat <<EOF', 'in', 'EOF', ')')), 'inside $( ): the statement that carries it')
  .eq('1#X#x;2#Y#y', bodies(lines('cat <<X && cat <<Y', 'x', 'X', 'y', 'Y')), 'one per statement')
  .eq('', bodies('cat <<< "here string"'), 'a here-string is not a heredoc')
  .eq('', bodies('echo "<<EOF"'), 'quoted text is not a heredoc');

const shapes: Probe = { ts: () => writeShapes() };
s.group('tmb_cmd_write_shapes lists the shapes once')
  .has(shapes, 'sed -i', 'sed -i')
  .has(shapes, 'dd of=', 'dd of=')
  .has(shapes, 'git mv', 'git mv');

s.group('tmb_is_prompt_surface_path matches at a path boundary');
for (const p of ['agents/swe.md', 'skills/x/SKILL.md', 'skills/x/references/r.md', 'commands/scan.md', 'templates/agents/a.md', 'rules/style.md', '.claude/agents/local.md', 'CLAUDE.md', 'sub/CLAUDE.md', '/w/.claude/worktrees/t/agents/a.md'])
  s.eq('true', surface(p), `${p} should be a prompt surface`);
for (const p of ['myskills/x/SKILL.md', 'myagents/a.md', 'src/agents.md', 'skills/x/helper.sh', 'agents/openai.yaml', 'NOTCLAUDE.md', 'docs/x.md', 'CODEX.md', 'sub/CODEX.md', 'CURSOR.md', 'GEMINI.md'])
  s.eq('false', surface(p), `${p} is not a prompt surface`);

s.group('tmb_is_prompt_surface_path anchors on the repo root');
for (const p of ['agents/x.md', '.claude/agents/x.md', '.claude/skills/s/SKILL.md', 'commands/c.md', 'nested/CLAUDE.md'])
  s.eq('true', surface(p), `${p} should be a prompt surface`);
for (const p of ['src/agents/x.md', 'docs/templates/a.md', 'myskills/x.md', 'src/rules/r.md'])
  s.eq('false', surface(p), `${p} is not a prompt surface`);
s.step(() => {
  mkdirSync(SURF);
  git(SURF, 'init', '-q');
  for (const d of ['src/agents', 'agents', '.claude/worktrees/t/agents']) mkdirSync(join(SURF, d), { recursive: true });
})
  .eq('false', surface(`${SURF}/src/agents/x.md`), '<repo>/src/agents/x.md is not a prompt surface')
  .eq('true', surface(`${SURF}/agents/x.md`), '<repo>/agents/x.md should be a prompt surface')
  .eq('true', surface(`${SURF}/.claude/worktrees/t/agents/x.md`), 'worktree agents/x.md should be a prompt surface')
  .eq('false', surface(`${SURF}/.claude/worktrees/t/src/agents/x.md`), 'worktree src/agents/x.md is not a prompt surface')
  .eq('false', surface(`${SURF}/src/agents/x.md`, SURF), 'explicit root: src/agents/x.md is not a prompt surface')
  .eq('true', surface('/nonexistent/agents/x.md'), 'an unresolvable root fails closed');

s.group('tmb_path_canonical')
  .step(() => {
    mkdirSync(join(TMP, 'a'));
    symlinkSync(join(TMP, 'a'), join(TMP, 'link'));
  })
  .eq(`${REAL}/a/new/file`, canonical(`${TMP}/link/new/file`), 'symlinked ancestor resolved; missing tail kept')
  .eq(`${REAL}/a`, canonical(`${TMP}/a/b/../.`), '. and .. resolved')
  .eq('/', canonical('/'), 'root')
  .step(() => {
    mkdirSync(join(TMP, 'outside/deep'), { recursive: true });
    mkdirSync(join(TMP, 'root/a'), { recursive: true });
    symlinkSync(join(TMP, 'outside/deep'), join(TMP, 'root/link'));
    symlinkSync('../outside/deep', join(TMP, 'root/rel'));
  })
  .eq(`${REAL}/outside/x`, canonical(`${TMP}/root/link/../x`), 'a symlink is followed before .. applies')
  .eq(`${REAL}/outside/deep/f`, canonical(`${TMP}/root/rel/f`), 'a relative symlink resolves against its directory')
  .eq(`${REAL}/root/b`, canonical(`${TMP}/root/a/../b`), 'a legitimate .. without a symlink')
  .eq(`${REAL}/root/a/new`, canonical(`${TMP}/root/missing/../a/new`), '.. collapses inside the missing tail')
  .eq(`${REAL}/outside/y`, canonical(`${TMP}/root/missing/../link/../y`), 'a link reached after the tail empties is still followed');

s.group('tmb_cmd_statements splits the skeleton into statements')
  .eq(`${PLAIN}#git add .|${PLAIN}#git commit -m x`, P('git add . && git commit -m x'), '&&')
  .eq(`${PLAIN}#a|${PLAIN}#b|${PLAIN}#c|${PLAIN}#d`, P('a; b || c & d'), '; || &')
  .eq(`${PLAIN}#git log|${PLAIN}#head -1`, P('git log | head -1'), 'pipe')
  .eq(`${PLAIN}#a|${PLAIN}#b`, P('a\nb'), 'newline')
  .eq(`${PLAIN}#echo|${PLAIN}#git status|${PLAIN}#git log`, P('echo $(git status) `git log`'), '$( ) and backticks')
  .eq(`${PLAIN}#true|${PLAIN}#git status|${PLAIN}#ls 2>&1|${PLAIN}#grep x &>/dev/null`, P('if true; then git status; fi; ls 2>&1 | grep x &>/dev/null'), 'keywords dropped; fd redirects are not separators')
  .eq(`${PLAIN}#git commit`, P('FOO=1 sudo git commit'), 'assignments and wrappers dropped');

const bashC = 'bash -c "cd /w && git status"; eval "git log"';
s.group('tmb_cmd_statements treats heredoc bodies and quoted text as data')
  .eq(`${PLAIN}#cat > notes.md <<EOF`, P(HEREDOC_CMD), 'heredoc body is not a statement')
  .eq(`${PLAIN}#python3 -c print_'gh_pr_merge_1'_`, P(`python3 -c "print('gh pr merge 1')"`), 'a python program is one word')
  .eq(`${PLAIN}#echo git_commit_-m_x`, P('echo "git commit -m x"'), 'a quoted command is one word')
  .has(P(bashC), '/w#git status', 'bash -c body statement carries its cd')
  .has(P(bashC), `${PLAIN}#git log`, 'eval body statement');

s.group('tmb_cmd_statements effective dir')
  .eq('/r/wt#git -C /r/wt commit', P('git -C /r/wt commit'), 'git -C')
  .eq('/r/wt#git -C wt commit', P('cd /r && git -C wt commit'), 'git -C relative to a cd', dropFirst)
  .eq('/a#git commit', P('cd /a && git commit'), 'leading cd', dropFirst)
  .eq(`${PLAIN}#git status|${PLAIN}#cd /b|/b#git commit`, P('git status; cd /b; git commit'), 'mid-chain cd applies to later statements only')
  .eq(`${PLAIN}/sub#git commit`, P('cd sub && git commit'), 'relative cd joins the cwd', dropFirst)
  .eq('/a#git log', P('cd /a && (cd /b && git x) && git log'), 'a subshell cd does not leak', lastField)
  .eq('-#git commit', P('cd "$WT" && git commit'), 'a variable path is unknown', dropFirst)
  .eq('-#git commit', stmts('git commit', `${TMP}/missing`), 'no cwd → unknown')
  .step(() => {
    mkdirSync(REPO);
    git(REPO, 'init', '-q', '-b', 'main');
    git(REPO, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  })
  .eq(`${REPO}#git commit`, stmts('git commit', REPO), 'cwd in a repo without worktrees is the dir')
  .step(() => git(REPO, 'worktree', 'add', '-q', '-b', 'feat/x', `${REPO}/.claude/worktrees/x`))
  .eq('?#git commit', stmts('git commit', REPO), 'cwd in a repo with worktrees is ambiguous')
  .eq(`${REPO}/.claude/worktrees/x#git commit`, stmts(`cd ${REPO}/.claude/worktrees/x && git commit`, REPO), 'explicit cd resolves the ambiguity', dropFirst)
  .eq(`${REAL}/repo`, { ts: () => stmtRepoRoot('?', REPO) }, 'an ambiguous dir still names its repo')
  .eq(`${REAL}/repo`, { ts: () => stmtRepoRoot(`${REPO}/.claude/worktrees/x`, '') }, "a worktree's repo is the main checkout")
  .eq('', { ts: () => stmtRepoRoot('-', '') }, 'unknown dir names no repo');

s.group('tmb_git_subcommand / tmb_git_commit_message')
  .eq('push origin main', { ts: () => gitSubcommand('git -C /x -c a=b --no-pager push origin main') }, 'global options dropped')
  .eq('', { ts: () => gitSubcommand('gh pr create') }, 'not git')
  .eq('✨ feat(x): a b', commitMessage('cd /w && git commit -m "✨ feat(x): a b" -m body'), 'first -m from argv')
  .eq('fix: y', commitMessage("git commit -am 'fix: y'"), '-am')
  .eq('', commitMessage(HEREDOC_CMD), 'a heredoc mentioning git commit has no message')
  .eq('', commitMessage('git commit -m "$(cat <<EOF\nfeat: x\nEOF\n)"'), 'a $( ) message is not judged');

s.group('tmb_gh_mutation: gh api implied POST shapes')
  .eq('POST', ghm("gh api graphql -f query='mutation { addComment(input: {}) { clientMutationId } }'"), 'graphql -f query is a POST')
  .eq('POST', ghm("gh api graphql -f query='query { viewer { login } }'"), 'a graphql read travels as a POST too')
  .eq('POST', ghm('gh api graphql -F query=@q.graphql -F owner=o'), 'graphql -F query=@file')
  .eq('POST', ghm('gh api graphql --input body.json'), 'graphql --input')
  .eq('POST', ghm('gh api graphql --raw-field=query=x'), 'graphql --raw-field=')
  .eq('', ghm('gh api graphql -X GET -f query=x'), 'an explicit GET wins')
  .eq('', ghm('gh api repos/o/r/pulls'), 'a bare api path is a GET');

s.group('tmb_cmd_statements drops every heredoc form, also inside $( ) (GH 1281)')
  .eq(`${PLAIN}#cat <<EOF`, P(lines('cat <<EOF', 'git push origin dev', 'EOF')), '<<EOF')
  .eq(`${PLAIN}#cat <<EOF`, P('cat <<-EOF\n\tgit push origin dev\n\tEOF'), '<<-EOF')
  .eq(`${PLAIN}#cat <<EOF`, P(lines("cat <<'EOF'", 'a && git push origin dev', 'EOF')), "<<'EOF'")
  .eq(`${PLAIN}#cat <<EOF`, P(lines('cat <<"EOF"', 'a; git push origin dev', 'EOF')), '<<"EOF"')
  .eq(`${PLAIN}#cat <<A <<B|${PLAIN}#git status`, P(TWO_HEREDOCS), 'two heredocs on one line, then a real statement')
  .eq(`${PLAIN}#echo|${PLAIN}#cat <<EOF`, P(lines('echo $(cat <<EOF', 'git push origin dev', 'EOF', ')')), 'heredoc inside an unquoted $( )')
  .eq(
    `${PLAIN}#cat <<EOF|${PLAIN}#gh issue comment 1 --body $_cat___EOF__`,
    P(lines(`gh issue comment 1 --body "$(cat <<'EOF'`, 'run: `cd x && git commit --amend` then rebase', `it's "done"`, 'EOF', ')"')),
    'a quoted $( ) body runs; its heredoc text does not',
  )
  .eq(`${PLAIN}#gh pr merge 1|${PLAIN}#echo $_gh_pr_merge_1_`, P('echo "$(gh pr merge 1)"'), 'a quoted $( ) is a statement and a word of its outer statement')
  .eq(`${PLAIN}#date|${PLAIN}#gh api $_date_ -X POST x`, P('gh api "`date`" -X POST x'), 'a quoted backtick runs; the outer statement keeps its later words')
  .eq(`${PLAIN}#echo it's_a____git_push`, P("echo $'it\\'s a && git push'"), "$'…' is a quoted span");

s.group('tmb_gh_mutation judges command-position words only (GH 1281)')
  .eq('', G(lines("cat > x.test.ts <<'EOF'", ' gh issue close 1', 'EOF')), 'heredoc test fixture')
  .eq('', G("printf 'gh pr merge' > notes.txt"), 'printf of a quoted string')
  .eq('', G('echo "gh pr merge 1"'), 'echo of a quoted string')
  .eq('', G('echo gh pr merge 1'), 'an operand of a data command')
  .eq('', G('grep -rn gh pr merge docs'), 'a grep pattern')
  .eq('pr merge', G('gh pr merge 1'), 'plain')
  .eq('pr merge', G('timeout 5 gh pr merge 1'), 'timeout')
  .eq('pr merge', G('echo 1 | xargs gh pr merge'), 'xargs')
  .eq('issue close', G('/usr/bin/gh issue close 2'), 'absolute path')
  .eq('POST', G('GH_TOKEN=x gh api -X POST repos/o/r/issues'), 'VAR=value prefix')
  .eq('', G('gh issue view 1'), 'read-only')
  .eq('mr merge', G('glab mr merge 3'), 'glab')
  .eq('pr merge', G('echo "$(gh pr merge 1)"'), 'inside a quoted $( )')
  .eq('POST', G('gh api "$(echo repos/o/r/issues)" -f title=x'), 'an outer api call keeps its fields after a quoted $( )')
  .eq('pr close', G('sudo -u bob nice -n 5 caffeinate -i gh pr close 2'), 'chained wrappers with options')
  .eq('pr merge', G('sudo -u git gh pr merge 1'), 'an option value named like a data command is not argv0')
  .eq('pr merge', G('env -u cat gh pr merge 1'), 'env -u cat')
  .eq('pr merge', G('git bisect run gh pr merge 1'), 'git bisect run executes its words')
  .eq('pr merge', G('git submodule foreach gh pr merge 1'), 'git submodule foreach executes its words')
  .eq('pr merge', G("git rebase -x 'gh pr merge 1' main"), 'git rebase -x executes its command')
  .eq('pr merge', G('git rebase --exec="gh pr merge 1" main'), 'git rebase --exec=')
  .eq('pr merge', G('git submodule --quiet foreach gh pr merge 1'), 'submodule options before foreach')
  .eq('pr merge', G('git submodule -q foreach gh pr merge 1'), 'submodule -q foreach')
  .eq('pr merge', G("git rebase -ix 'gh pr merge 1' main"), '-x in a short-option cluster')
  .eq('pr merge', G("git rebase -kx 'gh pr merge 1' main"), '-kx')
  .eq('pr merge', G("git rebase --exe='gh pr merge 1' main"), '--exe= prefix of --exec')
  .eq('pr merge', G("git rebase -i --exe 'gh pr merge 1' main"), '--exe <cmd>')
  .eq('pr merge', G('git rebase -x "echo hi && gh pr merge 1" main'), 'a compound -x command after a data command')
  .eq('pr merge', G("git submodule foreach 'echo x; gh pr merge 1'"), 'a compound foreach command after a data command')
  .eq('', G('git rebase -i --autosquash main'), 'a rebase without -x runs nothing')
  .eq('', G('git log --grep="gh pr merge"'), 'other git subcommands only read their words');

const role = (json: string): Probe => ({ ts: () => agentRole(json) });
s.group('tmb_agent_role reads identity only')
  .eq('swe', role('{"agent_type":"tmb:swe","cwd":"/r"}'), 'prefixed agent_type')
  .eq('bro', role('{"cwd":"/r/.claude/worktrees/x"}'), 'no agent_type is the main thread, whatever the cwd');

s.group('tmb_is_harness_turn');
for (const framing of [
  '<task-notification><task-id>1</task-id>',
  '[SYSTEM NOTIFICATION - NOT USER INPUT]',
  'Another Claude session sent a message: hi',
  '[Subagent hand-back] report',
  '<agent-message from="swe">done</agent-message>',
  '<cross-session-message from="x">y</cross-session-message>',
])
  s.eq('true', status(isHarnessTurn, framing), `not a harness turn: ${framing}`);
s.eq('false', status(isHarnessTurn, 'port the parser to Rust'), 'a Human prompt is not a harness turn');

const lastTwo = (v: string): string => v.split('|').slice(-2).join('|');
s.group('GH 1595/1610: a same-command VAR=<literal> resolves a cd or -C dir')
  .eq('/abs#git -C $R status', P('R=/abs; git -C $R status'), 'R=/abs; git -C $R', lastField)
  .eq('/abs#git -C ${R} status', P('R=/abs && git -C "${R}" status'), 'a braced, quoted ${R} after &&', lastField)
  .eq('/w/B#git commit', P('export WT=/w/B; cd $WT && git commit'), 'export WT=<literal>; cd $WT', lastField)
  .eq('/w/B#git add f|/w/B#git commit', P('WT=/w/B; cd "$WT" && git add f && git commit'), 'WT=<literal>; cd "$WT" && git add && git commit', lastTwo)
  .eq('/b#git -C $R status', P('R=/a; R=/b; git -C $R status'), 'the latest assignment wins', lastField);

interface StatementVarsRow {
  cmd: string;
  dirs: string[];
  why: string;
}
const STMT_VARS = join(PLUGIN_ROOT, 'tests/fixtures/cmd-analysis/statement-vars.jsonl');
const stmtVars = readFileSync(STMT_VARS, 'utf8')
  .split('\n')
  .filter((l) => l !== '')
  .map((l) => JSON.parse(l) as StatementVarsRow);
const holdsBothKinds =
  stmtVars.filter((r) => r.dirs[r.dirs.length - 1] === '-').length >= 60 &&
  stmtVars.filter((r) => (r.dirs[r.dirs.length - 1] ?? '').startsWith('/')).length >= 14;

s.group('GH 1911: VAR=<literal> survives quoted operators and data heredocs, and dies on anything that may assign')
  .eq('/w/r#git -C $W commit -q -m a__b_|/w/r#git -C $W status', P('W=/w/r; git -C $W commit -q -m "a (b)"; git -C $W status'), '-m "a (b)" and the git after it')
  .eq('/w/r#git -C $W commit -q -F - <<EOM|/w/r#git -C $W status', P('W=/w/r; git -C $W commit -q -F - <<EOM\nmsg\nEOM\ngit -C $W status'), '-F - <<EOM, its <<EOM unmarked')
  .eq(`${PLAIN}#cat <<EOM|-#git -C $W status`, P('W=/w/r; cat <<EOM\n$((W=0))\nEOM\ngit -C $W status'), 'an unquoted $((W=0)) body')
  .eq('true', SH_ONLY, 'the shared fixture holds both kinds');
for (const row of stmtVars) {
  const want = row.dirs.map((d) => (d === '@' ? PLAIN : d)).join('|');
  s.eq(want, SH_ONLY, `${row.why}: ${row.cmd}`);
}

const deny = (stmt: string, unresolved: boolean): Probe => ({ ts: () => denyAmbiguousGitTarget(stmt, unresolved) });
const denyReason = (stmt: string): Probe => ({ ts: () => reason(denyAmbiguousGitTarget(stmt, true)) });
s.group('GH 1595: tmb_deny_ambiguous_git_target names an unresolvable dir')
  .has(denyReason('git commit'), 'ambiguous_git_target', 'keeps the token')
  .has(denyReason('git commit'), 'comes through a variable', 'says the dir is unresolvable')
  .lacks(denyReason('git commit'), 'names no directory', 'not the no-directory reason')
  .has(deny('git commit', false), 'names no directory', 'the plain form is unchanged');

const spans = (text: string): Probe => ({ ts: () => stripQuotedSpans(text) });
s.group('tmb_strip_quoted_spans')
  .eq('see   and   then', spans('see `git push` and "push it" then'), 'backticks and double quotes')
  .eq('x   y', spans("x 'still open' y"), 'single quotes')
  .eq("let's keep users' words", spans("let's keep users' words"), 'apostrophes are not quotes')
  .eq('an "unclosed quote', spans('an "unclosed quote'), 'an unclosed quote stays');

runSuite('cmd-analysis helpers (GH 1692)', s);

describe('tests/fixtures/cmd-analysis/statement-vars.jsonl', () => {
  it('holds both kinds: rows that fail closed and rows that resolve a dir', () => {
    assert.ok(holdsBothKinds);
  });
});

describe('cwdState: a linked worktree cwd is one checkout (GH 2510)', () => {
  const main = join(TMP, 'linked');
  const wt = join(main, '.claude/worktrees/x');
  const dirs = async (cwd: string): Promise<string[]> => {
    const res = await cmdStatements('git commit -q -m x', cwd);
    return res.ok ? res.statements.map((st) => st.dir) : [];
  };
  before(() => {
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
    mkdirSync(join(wt, 'sub'));
  });

  it('the main checkout of a repo with linked worktrees is ambiguous', async () => {
    assert.equal(await cwdState(main), '?');
    assert.deepEqual(await dirs(main), ['?']);
  });

  it('a linked worktree cwd, and a subdirectory of it, is that cwd', async () => {
    assert.equal(await cwdState(wt), wt);
    assert.equal(await cwdState(join(wt, 'sub')), join(wt, 'sub'));
    assert.deepEqual(await dirs(wt), [wt]);
  });

  it('an unresolved dir from a linked worktree cwd stays ambiguous', async () => {
    assert.equal(await cwdState(wt, process.env, { unresolved: true }), '?');
    assert.equal(await cwdState(PLAIN, process.env, { unresolved: true }), PLAIN);
  });
});

describe('statement src: the deny quotes the command as written (GH 2536)', () => {
  const allowed = (out: string): string => JSON.parse(out).hookSpecificOutput.permissionDecisionReason.split(' Allowed form: ')[1];
  const srcs = async (cmd: string): Promise<Array<string | undefined>> => {
    const res = await cmdStatements(cmd, PLAIN);
    return res.ok ? res.statements.map((st) => st.src) : [];
  };

  it('each statement carries its source text, prefixes and wrappers dropped, its stmt still normalized', async () => {
    const res = await cmdStatements("git commit -m 'fix: thing' && FOO=1 time git push origin 'a b' >/dev/null", PLAIN);
    assert.ok(res.ok);
    assert.deepEqual(res.statements.map((st) => [st.stmt, st.src]), [
      ['git commit -m fix:_thing', "git commit -m 'fix: thing'"],
      ['git push origin a_b >/dev/null', "git push origin 'a b' >/dev/null"],
    ]);
    assert.deepEqual(await srcs(`bash -c "git status; git log -1"`), ['git status', 'git log -1']);
    assert.deepEqual(await srcs('git status; git status'), ['git status', 'git status']);
  });

  it('src stays off the enumerable fields', async () => {
    const res = await cmdStatements("git commit -m 'a b'", PLAIN);
    assert.ok(res.ok);
    assert.deepEqual(Object.keys(res.statements[0] ?? {}), ['dir', 'stmt']);
  });

  it('the allowed form drops the git options and keeps the args as written; a non-git statement takes cd', () => {
    assert.equal(allowed(denyAmbiguousGitTarget({ stmt: 'git commit -m fix:_thing', src: "git commit -m 'fix: thing'" })), "git -C <path> commit -m 'fix: thing'");
    assert.equal(
      allowed(denyAmbiguousGitTarget({ stmt: 'git -c user.name=A_B commit -m x_y', src: `git -c user.name='A B' commit -m "x y"` }, true)),
      'git -C <path> commit -m "x y"',
    );
    assert.equal(allowed(denyAmbiguousGitTarget({ stmt: 'gh pr create --title a_b', src: "gh pr create --title 'a b'" })), "cd <path> && gh pr create --title 'a b'");
  });

  it('with no src, or a src the lexer cannot split, the deny falls back to the stmt', () => {
    assert.equal(denyAmbiguousGitTarget({ stmt: 'git commit -m x' }), denyAmbiguousGitTarget('git commit -m x'));
    assert.equal(allowed(denyAmbiguousGitTarget({ stmt: 'git commit -m x', src: "git commit -m 'x" })), 'git -C <path> commit -m x');
  });
});

describe('cmdStatements on a recorded divergence (decision 703)', () => {
  it('refuses two heredocs opened on one line, which tree-sitter-bash cannot parse', async () => {
    assert.ok(DIVERGENT.has(TWO_HEREDOCS));
    assert.deepEqual(await cmdStatements(TWO_HEREDOCS, PLAIN), { ok: false });
  });
});

describe('run_bounded kills the whole process group (run-bounded-child.ts)', () => {
  const RB = mkdtempSync(join(tmpdir(), 'tmb-cmd-analysis-rb-'));
  const BODY = 'echo $PPID > "$1/helper"; sleep 60 & echo $! > "$1/sleep"; wait';
  after(() => rmSync(RB, { recursive: true, force: true }));

  const pidIn = (f: string): number => Number(readFileSync(join(RB, f), 'utf8').trim());
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const sleepAlive = (): boolean => alive(pidIn('sleep'));
  const started = (): boolean => existsSync(join(RB, 'sleep')) && readFileSync(join(RB, 'sleep'), 'utf8').trim() !== '';
  const poll = async (cond: () => boolean): Promise<boolean> => {
    for (let i = 0; i < 100; i++) {
      if (cond()) return true;
      await sleep(50);
    }
    return false;
  };
  const reset = (): void => {
    rmSync(join(RB, 'helper'), { force: true });
    rmSync(join(RB, 'sleep'), { force: true });
  };

  it('a command past its timeout exits 124 and the sleep it backgrounded is gone once the helper returns', () => {
    const r = runBounded(1, 'bash', ['-c', BODY, '_', RB]);
    assert.equal(r.status, 124);
    assert.equal(sleepAlive(), false);
  });

  it('a finished command keeps its exit code', () => {
    assert.equal(runBounded(10, 'bash', ['-c', 'exit 3']).status, 3);
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    it(`${sig} to the helper kills the group`, async () => {
      reset();
      const job = spawnBounded(30, 'bash', ['-c', BODY, '_', RB]);
      const exited = new Promise((res) => job.on('exit', res));
      assert.ok(await poll(started));
      process.kill(pidIn('helper'), sig);
      await exited;
      assert.ok(await poll(() => !sleepAlive()));
    });
  }

  it('the group dies with the suite that started it', async () => {
    reset();
    const suite = spawn('sleep', ['30'], { stdio: 'ignore' });
    const job = spawnBounded(30, 'bash', ['-c', BODY, '_', RB], suite.pid);
    const exited = new Promise((res) => job.on('exit', res));
    assert.ok(await poll(started));
    suite.kill('SIGKILL');
    await exited;
    assert.ok(await poll(() => !sleepAlive()));
  });
});
