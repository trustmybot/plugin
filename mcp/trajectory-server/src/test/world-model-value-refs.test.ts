// Value-reference, static-receiver, extends and JSX caller edges (GH 1988
// part E): each shape gives its target a resolved world-model caller, and
// locals, parameters and intrinsic JSX elements give none.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDB } from './helpers.js';
import { indexValueRefFixture } from './value-refs-fixture.js';

interface EdgeRow {
  src: string;
  dst: string | null;
  dst_name: string;
  kind: string;
  resolution: string;
}

describe('value-reference, static-receiver, extends and JSX caller edges (GH 1988)', () => {
  const root = mkdtempSync(join(tmpdir(), 'wm-value-refs-'));
  const db = tempDB();
  let edges: EdgeRow[] = [];
  const from = (src: string) => edges.filter((e) => e.src === src && e.kind !== 'imports');

  before(async () => {
    await indexValueRefFixture(db, 'app', root);
    edges = db.all<EdgeRow>(
      `SELECT s.qualified_name AS src, d.path || ':' || d.qualified_name AS dst, e.dst_name, e.kind, e.resolution
         FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id LEFT JOIN wm_symbols d ON d.id = e.dst_id
        WHERE s.repo = 'app' ORDER BY e.rowid`,
    );
  });

  after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('SC1: an imported function passed as an argument and a shorthand value gets one caller edge; a parameter or local of its name gets none', () => {
    const passes = from('passesAlpha').filter((e) => e.dst_name === 'alpha');
    assert.deepEqual(passes.map((e) => [e.kind, e.dst, e.resolution]), [['calls', 'src/a.ts:alpha', 'exact']]);
    assert.deepEqual(from('shadowsAlpha').filter((e) => e.dst_name === 'alpha'), []);
    assert.deepEqual(from('localAlpha').filter((e) => e.dst_name === 'alpha'), []);
  });

  it('SC2: Klass.staticFn() gives Klass a caller and keeps the edge to Klass.staticFn', () => {
    assert.deepEqual(
      from('usesKlass').map((e) => [e.kind, e.dst_name, e.dst]),
      [
        ['calls', 'Klass', 'src/a.ts:Klass'],
        ['calls', 'staticFn', 'src/a.ts:Klass.staticFn'],
      ],
    );
  });

  it('SC3: extends Base and extends an import alias of Base both resolve an instantiates edge to Base', () => {
    for (const sub of ['Sub', 'AliasSub']) {
      assert.deepEqual(
        from(sub).map((e) => [e.kind, e.dst_name, e.dst, e.resolution]),
        [['instantiates', 'Base', 'src/a.ts:Base', 'exact']],
        sub,
      );
    }
  });

  it('SC4: <Button /> and <TreeView> give the components callers and <div> emits nothing', () => {
    assert.deepEqual(
      from('Page').map((e) => [e.kind, e.dst_name, e.dst]),
      [
        ['instantiates', 'TreeView', 'src/ui.tsx:TreeView'],
        ['instantiates', 'Button', 'src/ui.tsx:Button'],
      ],
    );
  });

  it('an alias of an external import or of a name the file declares keeps its own name, so it never lands on a same-named symbol', () => {
    assert.deepEqual(from('waits').map((e) => [e.dst_name, e.dst]), [['sleep', null]]);
    assert.deepEqual(
      edges.filter((e) => e.src === 'Gamma' && e.kind === 'instantiates').map((e) => [e.dst_name, e.dst]),
      [['BaseGamma', null]],
    );
  });

  it('no edge names an intrinsic JSX element or a parameter', () => {
    assert.deepEqual(edges.filter((e) => ['div', 'props', 'f', 'o'].includes(e.dst_name)), []);
  });
});
