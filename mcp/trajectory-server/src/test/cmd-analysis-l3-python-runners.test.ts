/**
 * tmb_cmd_write_paths on python code runners and held writers (GH 1692),
 * ported from the bash cmd-analysis l3 test: code-string runners and dynamic
 * builtins (GH 1569), paths that hide a write (GH 1571), and held or aliased
 * write callables (GH 1676, 1687). Each case is judged on the frozen answers
 * of the shell lib and on writePaths of the TS module, except a command
 * recorded in divergences.jsonl, which is judged on the frozen answer only.
 */
import { Suite, runSuite, wpaths, type Probe } from './cmd-analysis-l3.js';

const heredoc = (prefix: string, ...body: string[]): string => [`${prefix} <<'EOF'`, ...body, 'EOF'].join('\n');
const pyw = (...body: string[]): Probe => wpaths(heredoc('python3 -', ...body), '/w/wt');
/** A program written as its lines joined by `|`, as the bash suite's `IFS='|' read -a` splits it. */
const prog = (p: string): Probe => pyw(...p.split('|'));
/** The bash suite's pyq: <s> in single quotes, its backslashes and single quotes escaped. */
const pyq = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const U = 'UNRESOLVED:$(proc):$(proc)';
const AW = 'UNRESOLVED:$(alias-write):$(alias-write)';

const s = new Suite('python-runners');

s.group('tmb_cmd_write_paths: code-string runners and dynamic builtins (GH 1569)')
  .has(pyw('import cProfile', `cProfile.run('p = "/etc/evil"')`, "open(p, 'w')"), U, 'a code string can rebind a variable write path')
  .has(pyw('import cProfile', `cProfile.run('open("/etc/evil", "w")')`, "open('out.txt', 'w')"), '/etc/evil', 'a write inside the code string')
  .eq('/etc/evil', pyw('import cProfile', String.raw`cProfile.run('import os\nos.system("rm -rf /etc/evil")')`), 'a process call inside the code string')
  .eq(`${U}/a.txt`, pyw('import cProfile', `cProfile.run('import os; os.chdir("..")')`, "open('a.txt', 'w')"), 'a chdir inside the code string')
  .eq(U, pyw('import trace', `trace.Trace(count=0, trace=0).run('open("/etc/evil", "w")')`), 'trace.Trace().run chained on the constructor')
  .eq(U, pyw('import timeit', `timeit.Timer('x = 1', setup='open("/etc/evil", "w")')`), 'a literal timeit.Timer')
  .eq('/etc/evil', pyw('import timeit', `timeit.timeit('x = 1', setup='open("/etc/evil", "w")')`), 'timeit setup=')
  .eq('/etc/evil', pyw('from timeit import timeit', `timeit('open("/etc/evil", "w")')`), 'from timeit import timeit')
  .eq('/etc/evil', pyw('import cProfile as cp', `cp.run('open("/etc/evil", "w")')`), 'import cProfile as cp')
  .eq('/etc/evil', pyw('from cProfile import run', `run('open("/etc/evil", "w")')`), 'from cProfile import run')
  .eq('/etc/evil', pyw('import subprocess as q, pdb', `pdb.run("q.run(['rm', '-rf', '/etc/evil'])")`), "the program's import aliases hold inside the code string");
for (const p of [
  'import timeit|timeit.timeit(s)',
  "import timeit|timeit.timeit(stmt='x = 1', setup=s)",
  "import cProfile|cProfile.run('p=%r' % '/etc/evil')",
  "compile(s, 'f', 'exec')",
  'from timeit import timeit|timeit(s)',
  'import cProfile as cp|cp.run(s)',
  'import trace|t = trace.Trace()|t.run(s)',
  String.raw`import cProfile|cProfile.run('\x6fpen("/etc/evil", "w")')`,
  "import cProfile|cProfile.run('import subprocess as q')|q.run(['rm', '-rf', '..'])",
  'import cProfile|f = cProfile.run',
  "import builtins|getattr(builtins, 'ex' + 'ec')(s)",
  'getattr(__builtins__, name)(s)',
  "import builtins|vars(builtins)['exec'](s)",
  "import builtins|builtins.__dict__['exec'](s)",
  "globals()['__builtins__']['exec'](s)",
  "__import__('builtins')",
  'e = exec|e(s)',
  'from builtins import exec as e|e(s)',
  'import builtins as b|b.exec(s)',
])
  s.eq(U, prog(p), `unresolvable: ${p}`);
let deep = "open('/etc/evil', 'w')";
for (let i = 0; i < 3; i++) deep = `compile(${pyq(deep)}, 'f', 'exec')`;
s.eq('/etc/evil', pyw(deep), 'code strings nest to depth 3').eq(U, pyw(`compile(${pyq(deep)}, 'f', 'exec')`), 'deeper is unresolvable');
s.eq('', pyw('import cProfile', "cProfile.run('sum(range(9))')"), 'benign cProfile.run')
  .eq('', pyw('import timeit', "timeit.timeit('sum(range(9))', number=10)"), 'benign timeit.timeit')
  .eq('', pyw('import timeit', 'timeit.timeit(lambda: 1)'), 'a timeit lambda is not a code string')
  .eq('', pyw('import timeit', 'def f(): pass', 'timeit.timeit(lambda: f(), number=10)'), 'a timeit lambda calling a defined function')
  .eq('/w/wt/out.txt', pyw('import cProfile', "cProfile.run('main()')", "open('out.txt', 'w')"), 'cProfile.run beside a literal write')
  .eq('', pyw('import timeit', "timeit.repeat('sum(range(9))', repeat=3, number=10)"), 'benign timeit.repeat')
  .eq('', pyw('import pdb', "pdb.run('sum(range(9))')"), 'benign pdb.run');
for (const p of [
  "import cProfile, sys|s = sys.argv[1]|cProfile.Profile().run('pass').run(s)",
  `import cProfile|cProfile.Profile().run('pass').run('o' + 'pen("/et" + "c/x", "w")')`,
  "import cProfile, sys|pr = cProfile.Profile().run('pass')|pr.runctx(sys.argv[1], globals(), None)",
  "import profile, sys|s = sys.argv[1]|profile.Profile().run('pass').run(s)",
  "import profile, sys|pr = profile.Profile().run('pass')|pr.runctx(sys.argv[1], globals(), None)",
  "import cProfile|cProfile.Profile().run('pass')",
  "import pdb|pdb.Pdb().run('pass')",
  "import bdb|bdb.Bdb().run('pass')",
  "import timeit, sys|t = timeit.Timer('pass'); type(t)(sys.argv[1]).timeit(1)",
  "import timeit|type(timeit.Timer('pass'))(s).timeit()",
  "import timeit|t = timeit.Timer('pass'); t.__class__(s)",
  "from timeit import Timer as T|T('pass').timeit()",
  "from timeit import *|Timer('pass')",
])
  s.eq(U, prog(p), `a runner object is unresolvable: ${p}`);
s.eq('', pyw('import re', "re.compile(r'x')"), 're.compile is not a runner')
  .eq('', pyw('import builtins', 'builtins.print(1)'), 'builtins.<other name>')
  .eq(U, pyw('import cProfile', 'with cProfile.Profile() as pr:', '    sum(range(9))', 'pr.print_stats()'), 'with cProfile.Profile() as pr: no unchained constructor is exempt')
  .eq(U, pyw('import cProfile', 'pr = cProfile.Profile(); pr.enable(); sum(range(9)); pr.disable()'), 'Profile enable / disable')
  .eq(U, pyw('import timeit', 'def f(): pass', 'timeit.timeit(f, number=10)'), 'a timeit function the program defines is a bare name')
  .eq(U, pyw('import timeit', 'timeit.timeit(f, number=10)'), 'a timeit name the program does not define')
  .eq(U, pyw('import cProfile', 'pr = cProfile.Profile(); pr.run(s)'), 'an unchained constructor beside a .run call')
  .eq(U, pyw('import cProfile', 'pr = cProfile.Profile()', "getattr(pr, 'run')(code)"), 'an unchained constructor beside getattr')
  .eq(U, pyw('import cProfile', 'pr = cProfile.Profile()', 'm = pr.run', 'm(code)'), 'an unchained constructor beside a .run reference')
  .eq(U, pyw('import cProfile, inspect', 'pr = cProfile.Profile()', "inspect.getattr_static(pr, 'run')(pr, code)"), 'an unchained constructor beside inspect.getattr_static')
  .eq(U, pyw('import cProfile, inspect', 'pr = cProfile.Profile()', "dict(inspect.getmembers(pr))['run'](code)"), 'an unchained constructor beside inspect.getmembers')
  .eq(U, pyw('import cProfile', 'pr = cProfile.Profile()', '(pr.', ' run)(code)'), 'a .run split across lines in parens')
  .eq(U, pyw('import cProfile', 'pr = cProfile.Profile()', 'pr.\\', 'run(code)'), 'a .run split by a backslash continuation')
  .eq(U, pyw('import cProfile, inspect', "dict(inspect.getmembers(cProfile.Profile()))['run'](code)"), 'a constructor not bound to a name')
  .eq(U, pyw('import cProfile', 'pr = cProfile.Profile()', 'pr.enable()', 'print(pr)'), 'a bound constructor passed to print')
  .has(pyw('import cProfile', "cProfile.run('sum(range(9))', '/etc/evil')"), '/etc/evil', 'cProfile.run filename')
  .eq('/w/wt/out.prof', pyw('import cProfile', "cProfile.run('main()', 'out.prof')"), 'cProfile.run filename relative')
  .has(pyw('import profile', "profile.run('main()', filename='/etc/evil')"), '/etc/evil', 'profile.run filename=')
  .has(pyw('import cProfile', "cProfile.runctx('main()', {}, {}, '/etc/evil')"), '/etc/evil', 'cProfile.runctx 4th positional filename')
  .has(pyw('import cProfile', "cProfile.run('main()', fn)"), U, 'a non-literal cProfile.run filename');
for (const [imp, cls] of [
  ['import cProfile', 'cProfile.Profile'],
  ['from cProfile import Profile', 'Profile'],
  ['from cProfile import Profile as P', 'P'],
  ['import cProfile as c', 'c.Profile'],
])
  s.has(pyw(imp!, "p = 'out.txt'", `${cls}.runctx(o, 'p = "/etc/evil"', globals(), None)`, "open(p, 'w')"), U, `a runner method reached through the class: ${imp}`);
s.eq(U, pyw('import pdb', 'pdb.Pdb.run(o, s)'), 'pdb.Pdb.run through the class')
  .eq(U, pyw('import timeit', 'timeit.Timer.timeit(o)'), 'timeit.Timer.timeit through the class')
  .eq(U, pyw('import cProfile', 'f = cProfile.Profile.run'), 'a class method referenced without a call')
  .has(pyw('import cProfile', 'pr = cProfile.Profile()', `globals()['p' + 'r'].run('p = "/etc/evil"')`, "open(p, 'w')"), U, 'a bound constructor beside globals()')
  .has(
    pyw('import cProfile, sys', 'pr = cProfile.Profile()', `getattr(sys, 'mod' + 'ules')['__ma' + 'in__'].pr.run('p = "/etc/evil"')`, "open(p, 'w')"),
    U,
    'a bound constructor reached through a computed sys.modules',
  )
  .has(
    pyw('import cProfile, sys', 'pr = cProfile.Profile()', `getattr(getattr(sys, 'mod' + 'ules')['__ma' + 'in__'], 'p' + 'r').run('p = "/etc/evil"')`, "open(p, 'w')"),
    U,
    'a bound constructor reached by a computed getattr name',
  )
  .eq(U, pyw('import cProfile', 'def main(): pass', 'if __name__ == "__main__":', '    with cProfile.Profile() as pr:', '        main()', '    pr.print_stats()'), 'a with-bound profiler under the __main__ guard')
  .eq(U, pyw('import sys', "sys.modules.get('builtins')"), "sys.modules.get('builtins')")
  .eq(U, pyw('import sys', "b = sys.modules['builtins']"), "sys.modules['builtins']")
  .eq(U, pyw("getattr(len.__self__, 'ex' + 'ec')(s)"), '.__self__ of a builtin')
  .eq(U, pyw('import timeit', 'def f(): pass', `f = 'open(p, "w")'`, 'timeit.timeit(f)'), 'a timeit name rebound after its def')
  .eq(U, pyw('import timeit', 'def f(): pass', "for f in ['x = 1']:", '    timeit.timeit(f)'), 'a timeit name bound by for')
  .eq(U, pyw('import timeit', `def d(fn): return 'open(p, "w")'`, '@d', 'def f(): pass', 'timeit.timeit(f)'), 'a decorated timeit function')
  .eq(U, pyw('import timeit', 'def f(): pass', 'f()', 'timeit.timeit(f)', 'timeit.repeat(f)'), 'a defined timeit function called and timed twice')
  .has(pyw('import cProfile', 'pr = cProfile.Profile()', "pr.dump_stats('/etc/evil')"), '/etc/evil', 'dump_stats writes its path')
  .has(pyw('import cProfile', "open('out.txt', 'w')", 'pr = cProfile.Profile()', "pr.dump_stats('/etc/evil')"), '/etc/evil', 'dump_stats beside a literal write')
  .eq(`${U},/w/wt/out.prof`, pyw('import cProfile', 'pr = cProfile.Profile()', "pr.dump_stats('out.prof')"), 'dump_stats of a relative path');

s.group('tmb_cmd_write_paths: python paths that hide a write are unresolvable when referenced at all (GH 1571)');
for (const p of [
  'import runpy|runpy.run_path(sys.argv[1])',
  'import code|code.interact(local=globals())',
  'import doctest|doctest.run_docstring_examples(f, {})',
  'import codeop, types|c = codeop.compile_command(s)|types.FunctionType(c, {})()',
  'import pickle|pickle.loads(b)',
  'import marshal|marshal.loads(b)',
  "import shelve|shelve.open('x')",
  'breakpoint()',
  'import pdb|pdb.main()',
  'import timeit|timeit.main()',
  'import cProfile|cProfile.main()',
  "import sys|sys.modules['built' + 'ins'].exec(s)",
  'import sys|sys.modules.get(n).run(s)',
  "globals()['__buil' + 'tins__']['exec'](s)",
  'import pydoc|pydoc.locate(n)(s)',
  'import importlib|importlib.import_module(n).run(s)',
  "i = __import__|i('os').system(c)",
  '().__class__.__bases__[0].__subclasses__()',
  "f.__globals__['open'](p, 'w')",
  "getattr(obj, n)(p, 'w')",
  'vars(obj)[n](s)',
  String.raw`open('\x2fetc\x2fevil', 'w')`,
  'import inspect|inspect.getattr_static(o, n)',
  'if 1: import runpy; runpy.run_path(p)',
  '__import__(n).run(s)',
  'from sys import *|modules[n].run(s)',
  'from pdb import main as m|m()',
  'import pdb|pdb.set_trace()',
  "getattr(o, '__globals__')",
  String.raw`open('\057etc', 'w')`,
])
  s.eq(U, prog(p), `unresolvable: ${p}`);
s.eq('', pyw('import json', 'json.dumps({})'), 'an ordinary module')
  .eq('/w/wt/out.txt', pyw(String.raw`open('out.txt', 'w').write('a\\n')`), 'an escaped backslash is no hex escape')
  .eq('', pyw('class A: pass', "getattr(A(), 'x', None)"), 'getattr with a literal name')
  .eq('', pyw('import re', String.raw`re.compile(r'\x41')`), "a raw string's backslash is no escape");
for (const cmd of [`python3 -m timeit -s "open('/etc/evil','w')" pass`, 'python3 -m cProfile -o out.prof x.py', 'python3 -m pdb x.py', 'python3 -Im runpy x', 'python3 -mpickle x.pkl'])
  s.eq(U, wpaths(cmd, '/w/wt'), `python -m runner: ${cmd}`);
for (const cmd of ['python3 -m json.tool x.json', 'python3 -m pytest -q', 'python3 -m pytest -m pdb', 'python3 x.py -m pdb'])
  s.eq('', wpaths(cmd, '/w/wt'), `python -m other: ${cmd}`);

s.group('GH 1676: a held or aliased write builtin is $(alias-write), not $(proc)');
for (const p of [
  "o = open|o(p, 'w')",
  "import pdb|pdb.runeval('open')(p, 'w')",
  "from builtins import open as o|o('/etc/x', 'w')",
  "import builtins|o = builtins.open|o('/etc/x', 'w')",
  "x = [open]|x[0]('/etc/x', 'w')",
  "f = open.__call__|f('/etc/x', 'w')",
])
  s.eq(AW, prog(p), `alias-write: ${p}`);
for (const p of ['e = eval|e(s)', "g = getattr|g(o, 'x')", 'import subprocess|f = subprocess.run|f(c)']) s.eq(U, prog(p), `still a process-call class: ${p}`);
s.eq('/w/wt/a.txt', pyw("open('a.txt', 'w')"), 'a direct open() with a literal path resolves');

s.group('GH 1687: a held or aliased module-qualified write callable is $(alias-write)');
for (const p of [
  "import io|f = io.open|f('/etc/x', 'w')",
  "import os|o = os.open|o('/etc/x', 1)",
  "import shutil|m = shutil.move|m('a', '/etc/x')",
  "import shutil|m = shutil.copy|m('a', '/etc/x')",
  "import shutil as s|m = s.move|m('a', '/etc/x')",
  "from shutil import move as mv|m = mv|m('a', '/etc/x')",
  "from shutil import move|m = move|m('a', '/etc/x')",
  "from io import open as op|f = op|f('/etc/x', 'w')",
  "import os|ops = [os.remove]|ops[0]('/etc/x')",
  "import shutil|shutil.move.__call__('a', '/etc/x')",
  "import pathlib|w = pathlib.Path.write_text|w(pathlib.Path('/etc/x'), 's')",
  "from pathlib import Path|w = Path.write_text|w(Path('/etc/x'), 's')",
  "import os|r = os.rename|r('a', '/etc/x')",
  "import os|r = os.replace|r('a', '/etc/x')",
  "import os|r = os.unlink|r('/etc/x')",
  "import os|r = os.makedirs|r('/etc/x')",
  "import shutil|r = shutil.rmtree|r('/etc/x')",
  "import shutil|r = shutil.copyfile|r('a', '/etc/x')",
  "import shutil|r = shutil.copy2|r('a', '/etc/x')",
  "import shutil as sh|m = sh.move|m('a', '/etc/x')",
  "import shutil|m = (shutil.move)|m('a', '/etc/x')",
  'import shutil|f(shutil.move)',
  "import shutil|d = {'m': shutil.move}|d['m']('a', '/etc/x')",
  "import shutil, functools|p = functools.partial(shutil.move, 'a')|p('/etc/x')",
  "import zipfile|z = zipfile.ZipFile|z('/etc/x', 'w')",
  "from shutil import *|m = move|m('a', '/etc/x')",
  "from os import *|r = remove|r('/etc/x')",
  "import shutil|m = shutil . move|m('a', '/etc/x')",
  "import shutil as sh|m = sh . move|m('a', '/etc/x')",
  "import shutil|m = getattr(shutil, 'move')|m('a', '/etc/x')",
  "import io|f = getattr(io, 'open')|f('/etc/x', 'w')",
])
  s.eq(AW, prog(p), `alias-write: ${p}`);
s.eq('/w/wt/a,/etc/x', pyw('from shutil import *', "move('a', '/etc/x')"), 'a star-imported writer called directly resolves its paths')
  .eq('/w/wt/a,/w/wt/b', pyw('import shutil', "shutil.move('a', 'b')"), 'a direct shutil.move resolves its paths')
  .eq('/w/wt/out', pyw('import shutil', "shutil.copy('a', 'out')"), 'a direct shutil.copy resolves its dst')
  .eq('/w/wt/a,/etc/x', pyw('import shutil as s', "s.move('a', '/etc/x')"), 'a call through an import alias resolves its paths')
  .eq('/etc/x', pyw('from os import remove', "remove('/etc/x')"), 'a from-imported writer called directly resolves its path')
  .eq('/w/wt/b', pyw('import shutil', "shutil.copytree('a', 'b', copy_function=shutil.copy2)"), 'a copy function passed to copytree writes under its dst')
  .has(pyw('import shutil', "shutil.copytree('/etc', 'b', copy_function=shutil.rmtree)"), '$(alias-write)', 'a non-copy writer as copy_function is held');
for (const p of [
  'import sys|w = sys.stdout.write|w(s)',
  'import copy|c = copy.copy|c(x)',
  'd = {}|c = d.copy|c()',
  'import os|j = os.path.join',
  'import shutil|shutil.move = f',
  'import csv|for row in rows: print(row.open, row.close)',
  "import feedparser|for e in feedparser.parse('feed.xml').entries: print(e.link)",
  'import argparse|args = argparse.ArgumentParser().parse_args()|print(args.rm)',
  "import pandas as pd|df = pd.read_csv('prices.csv')|print(df.open.mean())",
  'from pathlib import Path|print(isinstance(p, Path))',
  'm = shutil.move',
])
  s.eq('', prog(p), `not a held writer: ${p}`);
for (const p of [
  "m = __import__('shutil').move|m('a', '/etc/x')",
  "o = __import__('io').open|o('/etc/x', 'w')",
  "s = __import__('shutil')|m = s.move|m('a', '/etc/x')",
  "m = __import__('shutil', fromlist=['move']).move|m('a', '/etc/x')",
  "getattr(__import__('shutil'), 'move')('a', '/etc/x')",
  "m = __import__('shutil') . move|m('a', '/etc/x')",
  "__import__('shutil').move.__call__('a', '/etc/x')",
  "z = __import__('zipfile').ZipFile|z('/etc/x', 'w')",
])
  s.eq(AW, prog(p), `alias-write through a literal __import__: ${p}`);
s.has(pyw('import importlib', "m = importlib.import_module('shutil').move", "m('a', '/etc/x')"), '$(alias-write)', 'a writer held off importlib.import_module is alias-write')
  .eq('/w/wt/a,/etc/x', pyw("__import__('shutil').move('a', '/etc/x')"), "a direct __import__('shutil').move resolves its paths")
  .eq('/w/wt/a,/w/wt/b', pyw("__import__('shutil').move('a', 'b')"), "a direct __import__('shutil').move inside the worktree resolves its paths")
  .eq('/w/wt/o.txt', pyw("__import__('io').open('o.txt', 'w')"), "a direct __import__('io').open resolves its path")
  .eq('/etc/x', pyw("__import__('pathlib').Path('/etc/x').write_text('s')"), "a Path off __import__('pathlib') is a Path receiver");
for (const p of ["__import__('io').StringIO('x')", "j = __import__('json')|j.dumps(1)"]) s.eq('', prog(p), `not a held writer: ${p}`);

runSuite('tmb_cmd_write_paths on python code runners and held writers (GH 1692)', s);
