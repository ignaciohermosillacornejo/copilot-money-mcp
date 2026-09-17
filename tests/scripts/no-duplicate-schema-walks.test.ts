/**
 * Class detector: no script may hand-roll the JSON-Schema argument walk.
 *
 * THE CLASS
 *
 * A script needs a tool's argument names, reads `inputSchema.properties`, and
 * stops there. One level is not enough — `update_recurring` nests a `rule`
 * object whose `name_contains` is a real parameter, and `edits`, `splits` and
 * `rows` carry nested blocks — so the scan under-collects, and an
 * under-collecting scan is indistinguishable from a passing one.
 *
 * TWO COPIES, one defect. `check-tool-counts.ts` and `dump-tool-args.ts` each
 * had their own. The defect was found in the first and fixed there; the second
 * kept it through seven commits of review, because fixing an instance does
 * nothing about the copy nobody was looking at. `scripts/schema-args.ts` now
 * holds the walk once — and CONTRIBUTING's bug-response ritual is explicit
 * that removing the instances is not the class-level fix. Nothing stopped a
 * third copy. This test is the ratchet.
 *
 * WHAT IT REQUIRES
 *
 * Any file under `scripts/` that reads `inputSchema.properties` must import
 * `./schema-args.js`. That is a derived expectation, not a text match on the
 * walk's body: a fresh hand-rolled walk has to start somewhere, and reading
 * that field is where.
 *
 * THERE IS NO ALLOWLIST. `scripts/schema-args.ts` is excluded because it IS
 * the shared module; every other file under `scripts/` is in scope, and zero
 * need an exemption today. If a script ever legitimately reads the field
 * without walking it, the honest fix is to make this check narrower for a
 * stated reason, not to add a name to a list — that is the shape
 * `.gitignore`'s hand-maintained allowlist has, and #729 is what it cost.
 *
 * KNOWN LIMIT, deliberately not closed: this sweeps `scripts/`, not `tests/` or
 * `src/`. `tests/conformance/ledger.test.ts` holds a third walk of the same
 * shape, and it is legitimately a different function — it builds dotted
 * parameter paths and collects enum value sets, which the shared module does
 * not do. Folding it in would couple a coverage gate to a name-collection
 * helper. Its docblock carries the shared module's known limits instead.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tsFilesUnder } from '../helpers/ts-files.js';

const SCRIPTS_DIR = fileURLToPath(new URL('../../scripts', import.meta.url));

/** The shared module itself — it holds the walk, so it cannot import itself. */
const SHARED_MODULE = 'schema-args.ts';

describe('no hand-rolled JSON-Schema argument walks under scripts/', () => {
  const files = tsFilesUnder(SCRIPTS_DIR);

  // Non-vacuity: a sweep that found no files would satisfy the check below
  // without reading anything, which is the failure mode this repo keeps
  // finding in its own guards.
  test('the sweep reaches the scripts it is meant to cover', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith(SHARED_MODULE))).toBe(true);
  });

  test('every script reading inputSchema.properties imports the shared walk', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith(SHARED_MODULE)) continue;
      const source = readFileSync(file, 'utf-8');
      if (!source.includes('inputSchema.properties')) continue;
      if (source.includes("from './schema-args.js'")) continue;
      offenders.push(file.slice(SCRIPTS_DIR.length + 1));
    }
    expect(offenders).toEqual([]);
  });

  // The forward direction has nothing to compare against — a repo where no
  // script reads the field passes trivially — so pin that the consumers this
  // ratchet exists for are actually consumers.
  test('both known consumers go through the shared module', () => {
    for (const name of ['check-tool-counts.ts', 'dump-tool-args.ts']) {
      const source = readFileSync(`${SCRIPTS_DIR}/${name}`, 'utf-8');
      expect(source).toContain("from './schema-args.js'");
    }
  });
});
