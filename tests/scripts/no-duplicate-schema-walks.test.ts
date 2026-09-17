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
 * the shared module — by absolute path, so a `scripts/smoke/schema-args.ts`
 * could not exempt itself by name. Every other file under `scripts/` is in
 * scope INCLUDING SUBDIRECTORIES (`scripts/smoke/`, `scripts/graphql-capture/`),
 * which is why the import check tolerates any `../` depth. Zero files need an
 * exemption today. If a script ever legitimately reads the field
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
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tsFilesUnder } from '../helpers/ts-files.js';

const SCRIPTS_DIR = fileURLToPath(new URL('../../scripts', import.meta.url));

/**
 * The shared module itself — it holds the walk, so it cannot import itself.
 *
 * An absolute path compared with `===`, not a suffix. `endsWith('schema-args.ts')`
 * silently exempts `scripts/smoke/schema-args.ts` or `scripts/tool-schema-args.ts`
 * — a self-service allowlist in a file whose docblock says there is none — and
 * lets the non-vacuity check below be satisfied by a file that is not this one.
 */
const SHARED_MODULE = join(SCRIPTS_DIR, 'schema-args.ts');

/**
 * Depth-tolerant: `scripts/` has 26 TS files in subdirectories, and one of those
 * importing the shared module correctly writes `'../schema-args.js'`. A
 * `'./schema-args.js'` substring check would report it as an offender FOR DOING
 * THE RIGHT THING — and with no allowlist, its only ways out would be an
 * exemption or hand-rolling the walk, i.e. the guard pushing toward the thing it
 * exists to prevent.
 */
const IMPORTS_SHARED = /from '(?:\.\.?\/)+schema-args\.js'/;

/** The literal a fresh hand-rolled walk has to start from. */
const READS_SCHEMA_PROPERTIES = 'inputSchema.properties';

/** Exported shape of the offender test, so its trigger can be exercised directly. */
export function isOffender(source: string): boolean {
  return source.includes(READS_SCHEMA_PROPERTIES) && !IMPORTS_SHARED.test(source);
}

describe('no hand-rolled JSON-Schema argument walks under scripts/', () => {
  const files = tsFilesUnder(SCRIPTS_DIR);

  // Non-vacuity: a sweep that found no files would satisfy the check below
  // without reading anything, which is the failure mode this repo keeps
  // finding in its own guards.
  test('the sweep reaches the scripts it is meant to cover', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain(SHARED_MODULE);
  });

  // A scan that parsed nothing and a scan that found nothing both report zero
  // offenders. Today NO file enters the offender branch — both consumers reach
  // the schema through `schemaArgNames()` and never write the literal — so
  // mistyping it to `inputSchema.propertys` would switch the ratchet off
  // permanently with all tests green. This exercises the predicate directly.
  test('the offender predicate fires on a hand-rolled walk', () => {
    const handRolled = 'const props = def.schema.inputSchema.properties ?? {};';
    expect(isOffender(handRolled)).toBe(true);
    expect(isOffender(`import { schemaArgNames } from './schema-args.js';\n${handRolled}`)).toBe(
      false
    );
    // …at any depth, which is the finding this predicate was rewritten for.
    expect(isOffender(`import { schemaArgNames } from '../schema-args.js';\n${handRolled}`)).toBe(
      false
    );
    // And a file that never touches the schema is not an offender.
    expect(isOffender('export const unrelated = 1;')).toBe(false);
  });

  test('every script reading inputSchema.properties imports the shared walk', () => {
    const offenders = files
      .filter((file) => file !== SHARED_MODULE)
      .filter((file) => isOffender(readFileSync(file, 'utf-8')))
      .map((file) => file.slice(SCRIPTS_DIR.length + 1));
    expect(offenders).toEqual([]);
  });

  // The forward direction has nothing to compare against — a repo where no
  // script reads the field passes trivially — so pin that the consumers this
  // ratchet exists for are actually consumers.
  test('both known consumers go through the shared module', () => {
    for (const name of ['check-tool-counts.ts', 'dump-tool-args.ts']) {
      const source = readFileSync(join(SCRIPTS_DIR, name), 'utf-8');
      expect(IMPORTS_SHARED.test(source)).toBe(true);
    }
  });
});
