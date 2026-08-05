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
import { decodeItems, decodeAllCollections } from '../../src/core/decoder.js';
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

describe('every parent-pointer dispatch clause guards its processor (#627)', () => {
  // The class-level ratchet. Three dispatch clauses in decodeAllCollections
  // deliberately match Firestore's parent-pointer paths with a
  // `/^name\/[^/]+$/` regex. Each is only safe because the processor it calls
  // returns null for a fieldless document — an invariant that lived nowhere
  // enforceable, which is how `items` shipped without it.
  //
  // This pins the pairing: add a parent-pointer clause, and the processor it
  // dispatches to must carry the guard.
  test('each processor reachable from a parent-pointer clause checks fields.size === 0', () => {
    const src = fs.readFileSync(path.join(import.meta.dir, '../../src/core/decoder.ts'), 'utf8');

    const clause = /\/\^(\w+)\\\/\[\^\/\]\+\$\/\.test\(collection\)\)\s*\{([\s\S]{0,400}?)\n\s*\}/g;
    const checked: string[] = [];
    const unguarded: string[] = [];

    let m: RegExpExecArray | null;
    while ((m = clause.exec(src)) !== null) {
      const body = m[2] ?? '';
      const call = /\b(process\w+)\(/.exec(body);
      if (!call) continue;
      const processor = call[1]!;
      checked.push(processor);

      // Pull the processor's own body and look for the guard.
      const declIdx = src.indexOf(`function ${processor}(`);
      expect(declIdx).toBeGreaterThan(-1);
      const decl = src.slice(declIdx, declIdx + 900);
      if (!/fields\.size === 0/.test(decl)) unguarded.push(processor);
    }

    // Vacuity guard: if the clause pattern stops matching (a refactor, a
    // rename), this test would silently pass while checking nothing.
    expect(checked.length).toBeGreaterThanOrEqual(2);
    expect(unguarded).toEqual([]);
  });
});
