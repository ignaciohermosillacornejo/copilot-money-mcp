/**
 * Fieldless documents must never become rows (#627).
 *
 * Firestore materializes an empty "parent pointer" document at any path that
 * has subcollections. A real cache holds thousands of them — roughly 150 per
 * real item — and they carry no data at all: they exist only so the path
 * resolves.
 *
 * A processor that builds a row from one manufactures a record that does not
 * exist. `processItem` did exactly that: it fell back to `item_id: docId` and
 * so always returned at least a stub, while a comment at the call site asserted
 * the opposite ("parent-pointer docs have empty fields and processItem returns
 * null"). The code trusted its own documentation.
 *
 * These pin the invariant at the processor, so it holds for every caller rather
 * than only the one call site that was fixed.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  decodeItems,
  decodeAllCollections,
  routeCollection,
  COLLECTION_ROUTES,
} from '../../src/core/decoder.js';
import type { AllCollectionsResult, CollectionRoute } from '../../src/core/decoder.js';
import { ROUTE_ROWS } from '../../scripts/smoke/cache.js';
import { createDeepTestDb } from '../helpers/test-db.js';
import { stripComments } from '../helpers/strip-comments.js';
import {
  NO_PROCESSOR,
  ROUTE_PATHS,
  ROUTE_SHAPES,
  type SweptRoute,
} from '../helpers/route-fixtures.js';
import { createTestDatabase } from '../../src/core/leveldb-reader.js';

const FIXTURES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-pointer-'));

afterAll(() => {
  fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
});

const REAL_ITEM = 'itm_5pQw8ZnRvL3MxK7cHt2J';
const POINTER_ONLY = 'itm_9wKe4RnTpB2XvL7mQd3F';

describe('fieldless documents never become rows (#627)', () => {
  test('a fieldless items document is not decoded as an item', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'items-pointer');
    await createTestDatabase(dbPath, [
      { collection: 'items', id: REAL_ITEM, fields: { institution_name: 'Synthetic Bank' } },
      { collection: 'items', id: POINTER_ONLY, fields: {} },
    ]);

    const items = await decodeItems(dbPath);

    expect(items.map((i) => i.item_id)).toEqual([REAL_ITEM]);
  });

  test('the aggregate path agrees — no phantom row from the fieldless document', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'items-pointer-aggregate');
    await createTestDatabase(dbPath, [
      { collection: 'items', id: REAL_ITEM, fields: { institution_name: 'Synthetic Bank' } },
      { collection: 'items', id: POINTER_ONLY, fields: {} },
    ]);

    const all = await decodeAllCollections(dbPath);

    expect(all.items.map((i) => i.item_id)).toEqual([REAL_ITEM]);
  });

  test('a phantom would otherwise carry an id and nothing else', async () => {
    // Documents what the bug actually looked like, so the assertions above
    // cannot be mistaken for a count check. The phantom was not malformed —
    // it was a structurally valid Item whose every field but the id was absent,
    // which is why no schema validation objected.
    const dbPath = path.join(FIXTURES_DIR, 'items-pointer-shape');
    await createTestDatabase(dbPath, [{ collection: 'items', id: POINTER_ONLY, fields: {} }]);

    const items = await decodeItems(dbPath);

    expect(items).toEqual([]);
  });
});

describe('no dispatch clause matches a parent-pointer path (#627, #915)', () => {
  // routeCollection once carried `/^name\/[^/]+$/` clauses (items, users,
  // amazon) written for Firestore's parent-pointer entries. #627 removed the
  // items one for manufacturing phantom rows. The other two were dead: a
  // 2-segment collection is a 3-segment document path, which the key parser
  // rejects since #807, so they could only read as defenses that do nothing
  // (#915). A source scan ran over them, checking each led to a guarded
  // processor; with none left that scan would be vacuous, so this pins their
  // absence instead. Every processor's fieldless guard is pinned behaviourally
  // by the sweep below.
  test('the decoder source has no parent-pointer clause', () => {
    const src = fs.readFileSync(path.join(import.meta.dir, '../../src/core/decoder.ts'), 'utf8');
    // Stripped, so the history comments quoting the retired regexes do not count.
    const text = stripComments(src, 'decoder.ts');
    expect(text.match(/\/\^[-\w]+\\\/\[\^\/\]\+\$\//g) ?? []).toEqual([]);
  });

  // Every root segment of every route's real shape, derived from the
  // route-ratcheted table, so a new route brings its root along. The scan
  // above only knows one spelling of such a clause; this is the guard.
  const ROOTS = [
    ...new Set(Object.values(ROUTE_SHAPES).map((shape) => shape.split('/')[0]!)),
  ].sort();

  test('the root list is not vacuous', () => {
    expect(ROOTS).toContain('users');
    expect(ROOTS).toContain('amazon');
    expect(ROOTS).toContain('items');
  });

  test.each(ROOTS)('a %s/{id} path routes nowhere', (root) => {
    expect(routeCollection(`${root}/doc_2vLq9XmT4kRz7PwN3cHb`)).toBeNull();
  });
});

describe('no route builds a row from a fieldless document, every route from a populated one (#627, #778, #797, #808)', () => {
  // The behavioural form of the source scan above, over EVERY route the smoke
  // compares rather than the clauses a regex can find. One fieldless document
  // is written at a real path for each route, and the decoder must produce
  // nothing from it; one minimally populated document at the same path must
  // produce exactly one row. `smoke:cache` check 1b fails on the real-cache
  // shape of the first half (rows with no non-empty document behind them);
  // this catches it with no cache at all. A route with no path in ROUTE_PATHS is a type
  // error under `bun run check` (tests/helpers/route-fixtures.ts), and also
  // fails the coverage test below, which is what catches it under a bare
  // `bun test`.
  // Invariant pinned here (#797): the smoke excludes a route from checks 1 and
  // 2 ONLY for lacking a processor, so its accessor table covers exactly the
  // swept routes, and the coverage test below fails if a processor-bearing
  // route is ever excluded. If one must be excluded for another reason (as
  // the since-retired plaid_accounts route was before #797), restore an
  // explicit accessor for it here rather than dropping it from the sweep.
  const ROWS: Record<SweptRoute, (all: AllCollectionsResult) => number> = ROUTE_ROWS;
  // `populated` is the other side of each case (#808): the smallest field set
  // the route's processor turns into a row. Fieldless-yields-nothing alone
  // cannot see an over-broad guard (`fields.size < 2`, a guard that rejects a
  // real field shape, a guard moved in front of the real path), all of which
  // pass the fieldless side while dropping real documents. The property is
  // required, so a route without one is a type error under `bun run check`,
  // and the populated case below also fails at runtime if it is empty. Where a
  // processor passes every field through (holdings_history_meta and the
  // app-metadata routes) the field name is arbitrary; elsewhere it is a field
  // the processor reads.
  const PATHS = ROUTE_PATHS;

  test('the sweep covers every route that has a processor', () => {
    const swept = COLLECTION_ROUTES.filter(
      (r) => !(NO_PROCESSOR as readonly string[]).includes(r)
    ).sort();
    expect(Object.keys(PATHS).sort()).toEqual(swept);
    expect(Object.keys(ROWS).sort()).toEqual(swept);
  });

  test.each(Object.entries(PATHS))('%s: fieldless', async (route, { collection, id }) => {
    // The table must say what it means: a path that routes elsewhere would
    // make this pass for the wrong processor.
    expect(routeCollection(collection)).toBe(route as CollectionRoute);

    const dbPath = path.join(FIXTURES_DIR, `fieldless-${route}`);
    await createDeepTestDb(dbPath, [{ collection, id, fields: {} }]);
    const all = await decodeAllCollections(dbPath);
    const rows = ROWS[route as SweptRoute](all);

    expect(rows).toBe(0);
    // Every accessor, not only the route's own: a guard removed together with
    // a dispatch change that pushes the row into a different array would pass
    // the line above and fail here. The line above is subsumed by this one and
    // stays only for its clearer failure: it names the route's own count.
    const everywhere = Object.entries(ROWS)
      .filter(([, count]) => count(all) !== 0)
      .map(([other]) => other);
    expect(everywhere).toEqual([]);
  });

  test.each(Object.entries(PATHS))(
    '%s: populated',
    async (route, { collection, id, populated }) => {
      // No silent skip: an empty fixture would make this a second copy of the
      // fieldless case and pin nothing.
      expect(Object.keys(populated).length).toBeGreaterThan(0);
      expect(routeCollection(collection)).toBe(route as CollectionRoute);

      const dbPath = path.join(FIXTURES_DIR, `populated-${route}`);
      await createDeepTestDb(dbPath, [{ collection, id, fields: populated }]);
      const all = await decodeAllCollections(dbPath);

      expect(ROWS[route as SweptRoute](all)).toBe(1);
      // Exactly one row overall: a dispatch change that also pushes the
      // document into another array would pass the line above.
      const everywhere = Object.entries(ROWS)
        .filter(([, count]) => count(all) !== 0)
        .map(([other, count]) => `${other}=${count(all)}`);
      expect(everywhere).toEqual([`${route}=1`]);

      // And the fixture is minimal: dropping any one field loses the row.
      // Slack in a fixture is what lets an over-broad guard through — a
      // three-field document still decodes under `fields.size < 2`. Only
      // multi-field fixtures run this: dropping the sole field of a one-field
      // fixture writes the same empty document at the same path that the
      // `: fieldless` case already decodes, so it would add a database and
      // pin nothing. The count is read per run, so a fixture that later gains
      // a second field is covered with no other edit.
      const keys = Object.keys(populated);
      if (keys.length < 2) return;
      for (const dropped of keys) {
        const fields = Object.fromEntries(
          Object.entries(populated).filter(([key]) => key !== dropped)
        );
        const lessPath = path.join(FIXTURES_DIR, `populated-${route}-without-${dropped}`);
        await createDeepTestDb(lessPath, [{ collection, id, fields }]);
        const less = await decodeAllCollections(lessPath);
        expect({ dropped, rows: ROWS[route as SweptRoute](less) }).toEqual({ dropped, rows: 0 });
      }
    }
  );
});
