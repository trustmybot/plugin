/**
 * tmb_cmd_write_paths of scripts/hooks/lib/cmd-analysis.sh on inline programs
 * (GH 1692), ported from the bash cmd-analysis l3 test: programs fed through a
 * heredoc (GH 1279), write-call path arguments and text calls (GH 1510, 1550,
 * 1567), and process calls, chdirs, string evaluation and written data
 * (GH 1531, 1602), plus _tmb_cmd_prog_calls on every child_process import form.
 * Each case runs on the bash lib and on the TS module, except a command
 * recorded in divergences.jsonl, which runs on the bash lib only.
 */
import { progCalls } from '../hooks/cmd-analysis/prog-calls.js';
import { LIB, Suite, paste, runBounded, runSuite, wpaths, type Probe } from './cmd-analysis-l3.js';

const HOME = process.env.HOME ?? '';
const lines = (...xs: string[]): string => xs.join('\n');
const heredoc = (prefix: string, ...body: string[]): string => lines(`${prefix} <<'EOF'`, ...body, 'EOF');
const w = (cmd: string): Probe => wpaths(cmd, '/w');
const hw = (prefix: string, ...body: string[]): Probe => w(heredoc(prefix, ...body));
const wt = (prefix: string, ...body: string[]): Probe => wpaths(heredoc(prefix, ...body), '/w/wt');
const pyw = (...body: string[]): Probe => wt('python3 -', ...body);
const nodew = (body: string): Probe => wt('node -', body);
const U = 'UNRESOLVED:$(proc):$(proc)';

const s = new Suite();

s.group('tmb_cmd_write_paths: programs fed to an interpreter through a heredoc (GH 1279)')
  .eq('/etc/x', hw('python3 -', "open('/etc/x','w').write('y')"), 'python3 -')
  .eq('/w/o.txt', hw('python', "from pathlib import Path; Path('o.txt').write_text('y')"), 'python, no script')
  .eq('/tmp/x', hw('node', "require('fs').writeFileSync('/tmp/x','y')"), 'node')
  .eq('/w/d', hw('node -', "require('fs').mkdirSync('d/', {recursive: true})"), 'node - mkdirSync')
  .eq('/w/p.txt', hw('perl', 'open(my $f, ">", "p.txt");'), 'perl')
  .eq('/w/r.txt', hw('ruby -', "File.write('r.txt', 'x')"), 'ruby -')
  .eq('/tmp/s,/w/sub/t', w(lines("sh <<'EOF'", 'echo x > /tmp/s', 'cd sub && touch t', 'EOF')), "sh: redirects and write commands, in the program's own dirs")
  .eq('/w/sub/a', hw('cd sub && bash -s', 'echo x > a'), "bash -s, from its statement's dir")
  .eq('/w/a.txt,/w/b.txt', w(lines('python3 - <<A 3<<B', "open('a.txt','w')", 'A', "open('b.txt','w')", 'B')), 'every heredoc of the statement')
  .eq('/w/t.txt', w('python3 - <<-EOF\n\topen("t.txt","w")\n\tEOF'), '<<-EOF')
  .eq('/o/sub', w(lines('x=$(python3 - <<"EOF"', "open('/o/sub','w')", 'EOF', ')')), 'inside $( )')
  .eq('/yes', w(lines("cat <<'X' && python3 <<'Y'", "open('/no','w')", 'X', "open('/yes','w')", 'Y')), "only the interpreter's own heredoc")
  .eq('/hs', w('python3 - <<< "open(\\"/hs\\",\\"w\\")"'), 'a here-string program')
  .eq('', hw('python3 -', "print(open('/etc/hosts').read())"), 'a program that only reads')
  .eq('/w/f', hw('cat > f', "open('/etc/passwd','w')"), 'a data heredoc: only the redirect')
  .eq('', hw('python3 script.py', "open('/etc/passwd','w')"), 'a script is given: stdin is data')
  .eq('', hw('python3 -c pass', "open('/etc/passwd','w')"), 'python -c: stdin is data')
  .eq('', hw('bash script.sh', 'echo x > /etc/passwd'), 'bash script: stdin is data');

s.group("tmb_cmd_write_paths: a program writes its write calls' own path arguments (GH 1510)")
  .eq('/w/out.txt', hw('python3 -', 'import json', "cfg = json.load(open('/etc/tmb-cg/config.json', encoding='utf-8'))", "open('out.txt','w').write(str(cfg))"), 'a file opened to read is not written')
  .eq('/w/out.txt', hw('python3 -', "import os; open('out.txt','w').write(str(os.listdir('/usr/share/doc')))"), 'os.listdir reads')
  .eq('/w/out.txt', hw('python3 -', "import sys; sys.path.insert(0, '/opt/tmb-cg/lib'); open('out.txt','w')"), 'sys.path.insert names no write')
  .eq('/w/out.txt', w(`python3 -c "open('out.txt','w').write(open('/etc/hosts').read())"`), 'a one-liner')
  .eq('/w/scripts/x.sh', hw('python3 -', "s = open('scripts/x.sh').read()", String.raw`s = s.replace('/^[\\/~$]/', '/x/')`, "open('scripts/x.sh','w').write(s)"), 'regex text with / in a program is data')
  .eq('/etc/tmb-cg/x', hw('python3 -', "open('/etc/tmb-cg/x', 'w')"), 'an outside open w')
  .eq('/etc/tmb-cg/x', hw('python3 -', "p = '/etc/tmb-cg/x'", "open(p, 'w').write('y')"), 'a write to a variable: every literal not only read')
  .eq('/etc/tmb-cg', hw('python3 -', "import shutil; shutil.copy('in.txt', '/etc/tmb-cg/')"), 'shutil.copy: the destination')
  .eq('/w/a.txt,/w/b.txt,/w/d', hw('python3 -', "import os; os.rename('a.txt', 'b.txt'); os.makedirs('d', exist_ok=True)"), 'os.rename: both paths; makedirs')
  .eq('/etc/x,/etc/z', hw('python3 -', "from pathlib import Path; p = Path('/etc/x'); p.write_text(open('/etc/y').read()); print('/etc/z')"), 'an unknown receiver: every literal not only read, a printed one too')
  .eq('/etc/x,/etc/z', hw('python3 -', "from pathlib import Path; p = Path('/etc/x'); p.write_text(open('/etc/y').read()); q = '/etc/z'"), 'an unknown receiver: an assigned literal counts')
  .eq('/w/notes.txt', hw('python3 -', "s = open('notes.txt').read()", "s = s.replace('x', '/user/own')", "open('notes.txt', 'w').write(s)"), 'GH 1550: a literal write path; replace text is data')
  .eq('/w/notes.txt', hw('python3 -', 'import re', "s = re.sub('a', '/user/own', open('notes.txt').read())", "open('notes.txt', 'w').write(s)"), 'GH 1550: a literal write path; re.sub text is data')
  .eq('/w/notes.txt', hw('node -', "const fs = require('fs'); fs.writeFileSync('notes.txt', fs.readFileSync('notes.txt', 'utf8').replace('a', '/user/own'));"), 'GH 1550: node, a literal write path')
  .has(hw('python3 -', "p = 'notes.txt'", 's = open(p).read()', "s = s.replace('x', '/user/own')", "open(p, 'w').write(s)"), '/user/own', 'GH 1550: a write through a variable counts the replace text')
  .has(hw('python3 -', 'import re', "p = 'notes.txt'", "s = re.sub('a', '/user/own', open(p).read())", "open(p, 'w').write(s)"), '/user/own', 'GH 1550: a write through a variable counts the re.sub text')
  .has(hw('node -', "const fs = require('fs'); const p = 'notes.txt'; const s = fs.readFileSync(p, 'utf8').replace('a', '/user/own'); fs.writeFileSync(p, s);"), '/user/own', 'GH 1550: node, a write through a const counts the replace text')
  .eq('/outside/f', w('echo x > /outside/f'), 'GH 1550: a redirect stays a target');

s.group('tmb_cmd_write_paths: a path inside a larger string literal is not a literal of its own (GH 1567)')
  .eq('/w/a.sh', hw('python3 -', "p='a.sh'", "new='''", 'x "$P" "/onboard"', "'''", "open(p,'w').write(new)"), 'a triple-quoted string quoting /onboard')
  .eq('/w/a.txt', hw('node -', "const fs = require('fs'); const p = 'a.txt';", 'const s = `x "/abs" y`;', 'fs.writeFileSync(p, s);'), 'node: a template literal quoting /abs')
  .eq('/w/a.txt', hw('perl', 'my $p = "a.txt";', "my $s = 'one", 'two "/abs" three', "';", 'open(my $f, ">", $p); print $f $s;'), 'perl: a multi-line string quoting /abs')
  .has(hw('python3 -', "p = 'a.txt'", 'q = "/abs/x"', "open(p, 'w').write('1')"), '/abs/x', 'a standalone literal with a write through a variable counts')
  .has(hw('python3 -', "p = 'a.txt'", "open(p, 'w').write('1')", `s = 'see "/abs/y" here`), '/abs/y', 'a program that does not parse counts quoted sub-tokens');

s.group('tmb_cmd_write_paths: a variable rebound unseen still counts every literal (GH 1550)')
  .has(w(`python3 -c "import cProfile; p='notes.txt'; cProfile.run('p=%r' % '/etc/evil'); open(p,'w').write('1')"`), '/etc/evil', 'python -c: cProfile.run rebinds the variable')
  .has(hw('python3 -', 'import cProfile', "p = 'notes.txt'", "cProfile.run('p=%r' % '/etc/evil')", "open(p, 'w').write('1')"), '/etc/evil', 'cProfile.run rebinds the variable')
  .has(hw('python3 -', 'import trace', "p = 'notes.txt'", "trace.Trace(count=0, trace=0).run('p=%r' % '/etc/evil')", "open(p, 'w').write('1')"), '/etc/evil', 'trace.Trace().run rebinds the variable')
  .has(hw('python3 -', 'import pdb', "p = 'notes.txt'", "pdb.run('p=%r' % '/etc/evil')", "open(p, 'w').write('1')"), '/etc/evil', 'pdb.run rebinds the variable')
  .has(
    hw('python3 -', 'import gc', "p = 'notes.txt'", 'for o in gc.get_objects():', "    if isinstance(o, dict) and o.get('p') == 'notes.txt': o['p'] = '/etc/evil'", "open(p, 'w').write('1')"),
    '/etc/evil',
    'a gc.get_objects() dict write rebinds the variable',
  )
  .has(hw('python3 -', 'import pickle', "p = 'notes.txt'", "globals().update(pickle.loads(pickle.dumps({'p': '/etc/evil'})))", "open(p, 'w').write('1')"), '/etc/evil', 'a pickle round trip rebinds the variable');

s.group('tmb_cmd_write_paths: a path routed through a text call is still written (GH 1550)')
  .has(w(`python3 -c "p='x'.replace('x','/etc/evil'); open(p,'w').write('1')"`), '/etc/evil', 'python -c: a variable assigned from replace()')
  .has(hw('python3 -', "p='x'.replace('x','/etc/evil'); open(p,'w').write('1')"), '/etc/evil', 'python heredoc: a variable assigned from replace()')
  .has(w(`python3 -c "open('x'.replace('x','/etc/evil'),'w')"`), '/etc/evil', "replace() as open's path")
  .has(w(`node -e "const p='x'.replace('x','/etc/evil'); require('fs').writeFileSync(p,'1')"`), '/etc/evil', 'node: a const assigned from replace()')
  .has(hw('python3 -', "p = 'notes.txt'", "p = p.replace('notes.txt', '/etc/evil')", "open(p, 'w')"), '/etc/evil', 'a variable bound twice is not resolved')
  .has(hw('python3 -', "p = 'notes.txt'", "for p in ['/etc/evil']: open(p, 'w')"), '/etc/evil', 'a loop rebinding the variable')
  .has(hw('python3 -', "p = 'notes.txt'", "def f(p): open(p, 'w')", "f('/etc/evil')"), '/etc/evil', 'a parameter shadowing the variable')
  .has(hw('python3 -', "p = 'notes.txt'", "globals()['p'] = '/etc/evil'", "open(p, 'w')"), '/etc/evil', 'a write through globals()')
  .has(hw('node -', "const p = 'notes.txt'; try { throw '/etc/evil' } catch (p) { require('fs').writeFileSync(p, '1') }"), '/etc/evil', 'node: a catch binding shadowing the const')
  .has(hw('node -', "const p = 'notes.txt'; ({ m(p) { require('fs').writeFileSync(p, '1') } }).m('/etc/evil');"), '/etc/evil', 'node: a method parameter shadowing the const')
  .eq('/w/o.txt', hw('node -', "const fs = require('fs'); fs.writeFileSync('o.txt', fs.readFileSync('/etc/hosts'))"), 'node: the readFileSync path is not written')
  .eq('/w/h.txt', hw('node -', "require('fs').copyFileSync('/etc/hosts', 'h.txt')"), 'node copyFileSync: the destination')
  .eq('/w/p.txt', hw('perl', 'open(my $i, "<", "/etc/hosts"); open my $o, ">", "p.txt" or die; print $o <$i>;'), 'perl: < reads, > writes')
  .eq('/w/q.txt', hw('perl', 'open(F, ">>q.txt"); print F "/etc/hosts";'), 'perl two-argument open');

s.group('tmb_cmd_write_paths: truncate, zip and subprocess writes (GH 1531)')
  .eq('/etc/x', hw('python3 -', "import os; os.truncate('/etc/x', 0)"), 'os.truncate')
  .eq('/etc/x.zip', hw('python3 -', "import zipfile; zipfile.ZipFile('/etc/x.zip', 'w').writestr('a', 'b')"), 'zipfile.ZipFile w')
  .eq('/etc/x.zip', hw('python3 -', "import zipfile; zipfile.ZipFile('/etc/x.zip', mode='a')"), 'zipfile.ZipFile mode=a')
  .eq('', hw('python3 -', "import zipfile; print(zipfile.ZipFile('/etc/x.zip').namelist())"), 'zipfile.ZipFile read')
  .eq('/etc/x.tgz', hw('python3 -', "import tarfile; tarfile.open('/etc/x.tgz', 'w:gz')"), 'tarfile w:gz')
  .eq('/etc/x', hw('python3 -', "import subprocess; subprocess.run(['cp', 'a', '/etc/x'])"), 'subprocess.run list')
  .eq('/etc/x', hw('python3 -', "import subprocess; subprocess.run('cp a /etc/x', shell=True, check=True, env={'HOME': '/root'})"), 'subprocess.run shell string; env is ignored')
  .eq(U, hw('python3 -', 'import subprocess', "dst = '/etc/x'", "subprocess.check_call(['cp', 'a', dst])"), 'a variable argument fails closed')
  .eq('/etc/x', hw('python3 -', "import os; os.system('rm -rf /etc/x')"), 'os.system')
  .eq('/etc/x', hw('node -', "require('child_process').execSync('cp a /etc/x')"), 'node execSync')
  .eq('/etc/x', hw('node -', "const { spawnSync } = require('child_process'); spawnSync('cp', ['a', '/etc/x'])"), 'node spawnSync')
  .eq('/etc/x', hw('perl', 'system("cp", "a", "/etc/x");'), 'perl system')
  .eq('/etc/x', hw('ruby', 'system "cp a /etc/x"'), 'ruby system without parens')
  .eq('/etc/x', hw('ruby', 'out = `cp a /etc/x`'), 'ruby backticks');

s.group("tmb_cmd_write_paths: a process call's command is judged as a shell command (GH 1531)")
  .eq('/w', pyw('import subprocess', "subprocess.run(['rm', '-rf', '..'])"), 'a list argv climbing out')
  .eq('/w/x', pyw('import subprocess', "subprocess.run(['rm', '-rf', 'x'], cwd='..')"), 'cwd= is a leading cd')
  .eq(HOME, pyw('import os', "os.system('rm -rf ~')"), 'os.system with ~')
  .eq('/w/cg-task', pyw('import os', "os.system('cd .. && rm -rf cg-task')"), 'os.system with a leading cd')
  .eq('/w/q', pyw('import subprocess', "subprocess.run(['bash', '-c', 'cd .. && touch q'])"), 'bash -c in an argv')
  .eq('/etc/q', pyw('import subprocess', `subprocess.run(['python3', '-c', "open('/etc/q', 'w')"])`), 'an interpreter one-liner in an argv')
  .eq('/w/wt/a b', pyw('import subprocess', "subprocess.run(['touch', 'a b'])"), 'an argv element with a space stays one word')
  .eq('', pyw('import subprocess', "r = subprocess.run(['git', 'status'], stdout=subprocess.PIPE, check=True)", 'print(r.stdout)'), 'a command that writes nothing')
  .eq('', pyw('import subprocess, sys', "subprocess.run([sys.executable, '-m', 'pytest'])"), 'sys.executable is python')
  .eq('/w/x', nodew("require('child_process').spawnSync('touch', ['x'], { cwd: '..', stdio: 'inherit' })"), 'node {cwd: ...} is a leading cd')
  .eq('/w/x', nodew("require('child_process').spawn('touch ../x', { shell: true })"), 'node shell: true runs a shell string')
  .eq('/w/x', wt('ruby', 'system("touch", "x", chdir: "..")'), 'ruby chdir:')
  .eq(U, pyw('import subprocess', "d = '..'", "subprocess.run(['rm', '-rf', d])"), 'a variable argument is unresolvable')
  .eq(U, pyw('import subprocess', "subprocess.run(['rm', '-rf', 'x'], cwd=d)"), 'a variable cwd is unresolvable')
  .eq(U, pyw('import subprocess', "subprocess.run(' '.join(['rm', '-rf', '..']), shell=True)"), 'a computed command is unresolvable')
  .eq(U, nodew("require('child_process').execSync(`rm -rf ${d}`)"), 'a template literal command is unresolvable');

s.group('tmb_cmd_write_paths: renamed process imports are resolved, unresolvable ones fail closed (GH 1531)')
  .eq('/etc/x', pyw('import subprocess as sp', "sp.run(['rm', '-rf', '/etc/x'])"), 'import subprocess as sp')
  .eq('/etc/x', pyw('import os, subprocess as sp', "sp.check_output(['cp', 'a', '/etc/x'])"), 'import os, subprocess as sp')
  .eq('/etc/x', pyw('from subprocess import run as r', "r(['rm', '-rf', '/etc/x'])"), 'from subprocess import run as r')
  .eq('/etc/x', pyw('from subprocess import (', '    run,', '    PIPE,', ')', "run(['touch', '/etc/x'], stdout=PIPE)"), 'from subprocess import (run, PIPE)')
  .eq('/etc/x', pyw('from os import system', "system('rm -rf /etc/x')"), 'from os import system')
  .eq('/etc/x', nodew("const {execSync: x} = require('child_process'); x('rm -rf /etc/x')"), 'node const {execSync: x}')
  .eq('/etc/x', nodew("const cp = require('child_process'); cp.execSync('rm -rf /etc/x')"), 'node const cp = require')
  .eq('/etc/x', nodew("import { execSync as run } from 'child_process'; run('rm -rf /etc/x')"), 'node import { execSync as run }')
  .eq(U, pyw('import subprocess', 'f = subprocess.run', "f(['touch', 'x'])"), 'a process function held in a variable')
  .eq(U, pyw('import os', "getattr(os, 'system')('touch x')"), 'getattr(os, ...)')
  .eq(U, pyw("__import__('subprocess').run(['touch', 'x'])"), "__import__('subprocess')")
  .eq(U, nodew("const m = require('child_process'); const f = m.execSync; f('touch x')"), 'node: a process function held in a variable')
  .eq(`${U},/w/wt/x`, nodew("const cp = await import('child_process'); cp.execSync('touch x')"), 'node: a dynamic import')
  .eq('', pyw('import subprocess', 'try:', "    subprocess.check_call(['make', 'test'])", 'except subprocess.CalledProcessError as e:', '    print(e)'), 'subprocess exceptions and constants are not calls')
  .eq('', pyw('from os import path', "print(path.join('a', 'b'))"), 'other os names');

const PROG_CALLS = '. "$1"; _tmb_cmd_prog_calls node "$2" | paste -sd, -';
const progCallsBounded = (program: string): Probe => {
  let sh: ReturnType<typeof runBounded> | undefined;
  const run = () => (sh ??= runBounded(5, 'bash', ['-c', PROG_CALLS, '_', LIB, program]));
  return {
    call: { fn: 'true', args: [] },
    fromSh: () => `${run().status}|${run().stdout}`,
    ts: () => `0|${paste(progCalls('node', program).join('\n'), ',')}\n`,
  };
};
s.group('_tmb_cmd_prog_calls: every child_process import form finishes (GH 1531)');
for (const imp of [
  "import cp from 'child_process'",
  'import cp from "child_process"',
  "import cp from 'node:child_process'",
  'import cp from "node:child_process"',
  "import * as cp from 'child_process'",
  "import cp, { execSync } from 'child_process'",
  "import { execSync } from 'child_process'",
  "const cp = require('child_process')",
  'const { execSync: x } = require("node:child_process")',
]) {
  const p = progCallsBounded(`${imp}; cp.execSync('touch x')`);
  s.eq('0', p, `finishes within 5s: ${imp}`, (v) => v.split('|')[0]!).has(p, 'S\ttouch x', `resolves the import: ${imp}`);
}

s.group('tmb_cmd_write_paths: a process call is judged only when its parts are plain literals (GH 1531)')
  .eq(U, pyw('import os', "os.system('rm -rf %s' % '..')"), '% formatting')
  .eq(U, pyw('import subprocess', "subprocess.run('rm -rf %s' % '..', shell=True)"), '% formatting with shell=True')
  .eq(U, pyw('import os', "os.system('rm -rf {}'.format('..'))"), '.format()')
  .eq(U, pyw('import subprocess', "subprocess.run(['rm', '-rf', '..'.strip()])"), 'a method on a list element')
  .eq(U, pyw('import os', "os.system('rm -rf ' + '..')"), 'a concatenation')
  .eq(U, pyw('import os', "d = '..'", "os.system(f'rm -rf {d}')"), 'an f-string')
  .eq(U, pyw('import subprocess', "kw = {'cwd': '..'}", "subprocess.run(['rm', '-rf', 'x'], **kw)"), '**kw')
  .eq(U, pyw('import subprocess', "a = ['rm', '-rf', '..']", 'subprocess.run(*a)'), '*args')
  .eq(U, pyw('import subprocess', "subprocess.run(['ls', '..'], executable='/bin/rm')"), 'executable= swaps the program')
  .eq(U, pyw('import subprocess', "subprocess.run(['touch', 'x'], cwd=Path('..'))"), 'a cwd that is a call')
  .eq(U, nodew("const { execSync } = require('child_process'); const o = { cwd: '..' }; execSync('rm -rf x', o)"), 'a node options variable')
  .eq(U, nodew("const { execSync } = require('child_process'); execSync('rm -rf x', { ...{ cwd: '..' } })"), 'a node options spread')
  .eq(U, nodew("const { execSync } = require('child_process'); execSync('rm -rf x', { cwd })"), 'a node cwd shorthand')
  .eq(U, nodew("const cp = require('child_process'); cp.exec('ls', () => cp.execSync('rm -rf ..'))"), 'a process call inside a callback')
  .eq(U, wt('perl', 'my $d = ".."; system("rm", "-rf", $d);'), 'a perl variable')
  .eq(U, wt('ruby', 'system("rm", "-rf", "x", chdir: d)'), 'a ruby variable chdir:')
  .eq(U, wt('ruby', 'system("rm -rf x", :chdir => d)'), 'a ruby :chdir => variable')
  .eq('/w/x', wt('ruby', 'system("touch x", :chdir => "..")'), 'ruby :chdir => literal is a leading cd')
  .eq('/w/wt/sub/x', pyw('import subprocess', "subprocess.run(['touch', 'x'], cwd='sub', check=True, capture_output=True, text=True, env=dict(A='1'))"), 'plain literals with ordinary options')
  .eq('/w/wt/x', nodew("const cp = require('child_process'); cp.exec('touch x', { stdio: 'inherit', encoding: 'utf8' }, (err, out) => { console.log(out) })"), 'node options and a callback')
  .eq('/w/wt/x', wt('ruby', "system({'A' => '1'}, 'touch', 'x', out: :close)"), 'a ruby env hash and a redirect to a symbol')
  .eq('', pyw("print('%s/%s' % ('a', 'b'.strip()))"), 'a program without process calls is unaffected');

s.group('tmb_cmd_write_paths: a chdir makes process calls and relative writes unresolvable (GH 1531)')
  .eq(U, pyw('import os', "os.chdir('..')", "os.system('rm -rf cg-task')"), 'os.chdir then os.system')
  .eq(U, pyw('from os import chdir', 'import subprocess', "chdir('..')", "subprocess.run(['rm', '-rf', 'cg-task'])"), 'from os import chdir')
  .eq(U, nodew("process.chdir('..'); require('child_process').execSync('rm -rf cg-task')"), 'node process.chdir')
  .eq(U, wt('perl', "chdir '..'; system('rm', '-rf', 'cg-task');"), 'perl chdir')
  .eq(U, wt('ruby', "Dir.chdir('..')", "system('rm -rf cg-task')"), 'ruby Dir.chdir')
  .eq(`${U}/a.txt`, pyw('import os', "os.chdir('..')", "open('a.txt', 'w').write('x')"), 'a relative write after a chdir')
  .eq('/etc/x', pyw('import os', "os.chdir('..')", "open('/etc/x', 'w').write('x')"), 'an absolute write after a chdir is still judged');

s.group('tmb_cmd_write_paths: qx, %x and string evaluation (GH 1531)')
  .eq('/etc/x', wt('perl', 'my $o = qx(rm -rf /etc/x);'), 'perl qx()')
  .eq('/etc/y', wt('perl', "my $o = qx'rm /etc/y';"), "perl qx'' does not interpolate")
  .eq(U, wt('perl', 'my $o = qx{rm -rf $d};'), 'perl qx{} interpolating')
  .eq('/etc/x', wt('ruby', 'o = %x(rm -rf /etc/x)'), 'ruby %x()')
  .eq(U, wt('ruby', 'o = %x{rm -rf #{d}}'), 'ruby %x{} interpolating')
  .eq(U, pyw(`exec("import os; os.system('rm -rf ..')")`), 'python exec of a string')
  .eq(U, pyw("eval(compile('1', 'f', 'eval'))"), 'python eval')
  .eq(U, nodew(`eval("require('child_process').execSync('rm -rf ..')")`), 'node eval')
  .eq(U, nodew(`new Function("require('child_process').execSync('rm -rf ..')")()`), 'node new Function')
  .eq(U, wt('perl', 'eval "system(q(rm -rf ..))";'), 'perl eval of a string')
  .eq('', wt('perl', 'eval { print "x" };'), 'perl eval of a block');

const CONTENT = "const root = '/work/proj'; const branch = 'fix/sess-a';";
s.group('tmb_cmd_write_paths: data a program writes is content, not a target (GH 1531)')
  .eq('/w/a.ts', hw('python3 -', `open('/w/a.ts', 'w').write("${CONTENT}")`), 'open w with path-like text')
  .eq('/w/a.ts', hw('python3 -', 'from pathlib import Path', "p = Path('/w/a.ts')", `p.write_text("${CONTENT}")`), 'an unknown receiver judges only the literals outside the content')
  .eq('/w/a.ts', hw('python3 -', "p = '/w/a.ts'", "with open(p, 'w') as f:", `    f.write("${CONTENT}")`), 'a variable path: the written data is not a target')
  .eq('/w/a.ts', hw('python3 -', 'from pathlib import Path', "p = Path('/w/a.ts')", "p.write_text(p.read_text().replace('/work/proj', 'fix/sess-a'))"), 'replace literals inside the written data')
  .eq('/etc/x', hw('python3 -', "p = '/etc/x'", "with open(p, 'w') as f:", `    f.write("${CONTENT}")`), 'the same program with an outside path')
  .eq('/w/o.txt', hw('node -', `require('fs').writeFileSync('o.txt', "${CONTENT}")`), 'node writeFileSync data')
  .eq('/etc,/x', hw('python3 -', "d = '/etc'; open(d + '/x', 'w').write('hi')"), 'a computed path still fails closed');

s.group("GH 1602: an inline program's non-literal process call is $(proc), not $()")
  .eq(U, pyw('import subprocess', 'for n in range(3):', "    subprocess.run(['true', str(n)])"), "subprocess.run(['true', str(n)])")
  .eq('UNRESOLVED:X:$X/x', pyw('import os', 'os.system("cd $X && touch x")'), 'a literal shell string still names its variable');

runSuite('tmb_cmd_write_paths on inline programs (GH 1692)', s);
