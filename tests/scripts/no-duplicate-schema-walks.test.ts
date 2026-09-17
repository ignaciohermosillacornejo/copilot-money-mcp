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
 * No file under `scripts/` except the shared module may read
 * `inputSchema.properties` at all. That is a derived expectation, not a text
 * match on the walk's body: a walk has to start somewhere, and reading that
 * field is where. Consumers satisfy it by going through `schemaArgNames()`,
 * which is why neither of them contains the literal today.
 *
 * THERE IS NO ALLOWLIST, and exactly one exclusion: `scripts/schema-args.ts`,
 * by absolute-path identity, because it IS the shared module. Not by name, so
 * a `scripts/smoke/schema-args.ts` cannot exempt itself; and not by "imports
 * the shared module", because that would excuse an inline walk sitting beside
 * a legitimate import — see `isOffender`. Every other file under `scripts/` is in
 * scope INCLUDING SUBDIRECTORIES (`scripts/smoke/`, `scripts/graphql-capture/`),
 * which the sweep test asserts by measurement rather than by a stated count.
 * Zero files need an exemption today.
 *
 * Sources are comment-stripped before testing (`tests/helpers/strip-comments.ts`,
 * the #691 helper). A walk cannot hide inside a comment, so stripping can only
 * reduce false positives — and the single realized hit this sweep has ever had
 * is one: `scripts/schema-args.ts` names the literal in its own docblock, not
 * in its code, which the walk never writes. That makes the identity exclusion a
 * statement of intent rather than load-bearing suppression, and it is why a new
 * script documenting "uses schemaArgNames() rather than reading
 * inputSchema.properties" is not reported for saying so. If a script ever legitimately reads the field
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
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripComments } from '../helpers/strip-comments.js';
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

/**
 * Exported shape of the offender test, so its trigger can be exercised directly.
 *
 * Deliberately NOT exempting a file that imports the shared module. That
 * exemption was file-scoped rather than use-scoped, and it protected nothing:
 * going through the shared module is precisely what stops a consumer containing
 * the literal, so no consumer was ever being excused. What it bought was two
 * holes — an inline walk re-added to `dump-tool-args.ts` ALONGSIDE its existing
 * import would have been invisible, and that is the file which carried this
 * exact defect through seven commits of review. The class as this repo has
 * actually experienced it is not "a third copy in a new file", it is "a copy in
 * a file that also legitimately touches schemas".
 *
 * Dropping it also closes the comment hole: `IMPORTS_SHARED` matched inside a
 * comment, so `// unlike ../schema-args.js, this walks it inline` was an
 * allowlist entry in a file whose docblock says there is none. Reading raw
 * source is now safe in that direction, because nothing exempts.
 */
export function isOffender(source: string): boolean {
  return source.includes(READS_SCHEMA_PROPERTIES);
}

describe('no hand-rolled JSON-Schema argument walks under scripts/', () => {
  const files = tsFilesUnder(SCRIPTS_DIR);

  // Non-vacuity: a sweep that found no files would satisfy the check below
  // without reading anything, which is the failure mode this repo keeps
  // finding in its own guards.
  test('the sweep reaches the scripts it is meant to cover', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain(SHARED_MODULE);
    // Descent specifically: a floor of `length > 0` plus the module itself is
    // satisfied by the top-level files alone, so everything under
    // scripts/smoke/ and scripts/graphql-capture/ could silently leave scope.
    // tests/helpers/ts-files.test.ts covers extensions and ScriptKind, not
    // whether a caller's tree is actually descended.
    //
    // Measured by separator, not by name prefix. The first version of this line
    // was `startsWith(join(SCRIPTS_DIR, 'smoke'))`, which the TOP-LEVEL
    // scripts/smoke-graphql.ts satisfies — an assertion written to close a
    // vacuity, vacuous.
    const inSubdirectories = files.filter((f) => f.slice(SCRIPTS_DIR.length + 1).includes(sep));
    expect(inSubdirectories.length).toBeGreaterThan(0);
  });

  // A scan that parsed nothing and a scan that found nothing both report zero
  // offenders. Today NO file enters the offender branch — both consumers reach
  // the schema through `schemaArgNames()` and never write the literal — so
  // mistyping it to `inputSchema.propertys` would switch the ratchet off
  // permanently with all tests green. This exercises the predicate directly.
  test('the offender predicate fires on a hand-rolled walk', () => {
    const handRolled = 'const props = def.schema.inputSchema.properties ?? {};';
    expect(isOffender(handRolled)).toBe(true);
    // Importing the shared module does NOT excuse an inline walk beside it —
    // the realized-instance case, and the one this repo actually shipped.
    expect(isOffender(`import { schemaArgNames } from './schema-args.js';\n${handRolled}`)).toBe(
      true
    );
    // A consumer that routes through the module never writes the literal.
    expect(isOffender("import { schemaArgNames } from '../schema-args.js';")).toBe(false);
    // And a file that never touches the schema is not an offender.
    expect(isOffender('export const unrelated = 1;')).toBe(false);
  });

  test('no script but the shared module reads inputSchema.properties', () => {
    const offenders = files
      .filter((file) => file !== SHARED_MODULE)
      .filter((file) => isOffender(stripComments(readFileSync(file, 'utf-8'), file)))
      .map((file) => file.slice(SCRIPTS_DIR.length + 1));
    expect(
      offenders,
      'A script here reads `inputSchema.properties` directly instead of going ' +
        'through scripts/schema-args.ts. Use schemaArgNames() (or ' +
        'collectSchemaArgNames() for a caller-supplied set): a one-level read ' +
        'under-collects nested parameters such as update_recurring.rule.name_contains, ' +
        'and an under-collecting scan is indistinguishable from a passing one — ' +
        'which is how the same defect survived in two copies of this walk. ' +
        'If this is a false positive, argue the exception in this file: there is ' +
        'deliberately no allowlist to append to, and narrowing the check is the ' +
        'mechanism, with the reason recorded.'
    ).toEqual([]);
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
