/**
 * Wire-shape parity pins for the live row types (PR B review, Important 2).
 *
 * The row types in `src/tools/live/` hand-duplicate their GraphQL node's
 * fields — a flat object-literal `type` alias rather than an extension of the
 * node interface, because only a literal alias carries the implicit index
 * signature the field-selection engine's `Record<string, unknown>` constraint
 * needs. That design stays, but on its own it is safe in ONE direction only:
 *
 *   - a field REMOVED upstream is a compile error (the mapper's `...spread`
 *     no longer supplies a declared key), and
 *   - a field ADDED upstream rides through `cached.map((x) => ({ ...x }))`
 *     untouched — a spread-only object literal is exempt from excess-property
 *     checking — so it reaches the caller under `fields: ["all"]` while being
 *     ABSENT from the tool's `*_KNOWN_FIELDS` set. Asking for it by name then
 *     returns the data AND a false `Unknown field name(s) ignored` warning,
 *     and the tool description never lists it among its exclusions.
 *
 * `latestBalanceUpdate` drifted exactly this way once (#537). These tests
 * close the add direction by pinning each known-field set against the zod
 * mirror of its wire node.
 *
 * The mirror is one link short of the thing the row actually copies, so the
 * chain needs a second pin. A row spreads the TS INTERFACE (`AccountNode`),
 * while these tests compare against the zod MIRROR (`AccountNodeSchema`), and
 * the two are hand-maintained twins with nothing linking them. Read validation
 * cannot supply the link either: `src/core/graphql/read-response-validation.ts`
 * uses `z.looseObject` precisely so NEW server fields flow through without
 * warnings, so the read smokes keep the mirror honest in the remove and
 * type-change directions but not in the add direction these tests exist for.
 * The realistic drift is therefore: extend the operation document, add the
 * field to the interface (the natural place — it is what `fetchAccounts`
 * returns), forget the separate mirror edit, and every assertion below still
 * passes. The `MIRROR_IS_EXACT` pins in the two query modules close that hop
 * at compile time — they live in src/ because THIS FILE IS NOT TYPECHECKED:
 * tsconfig.tests.json is an explicit 17-file allowlist and this is not on it,
 * so a type-level pin placed here would compile-check nothing.
 *
 * Scope: the three row types PR B touches. The other live tools' known-field
 * sets are module-private and shaped by per-tool derivation/renaming, so they
 * are not covered here — extend the table below when one of them is next
 * touched.
 */

import { describe, expect, test } from 'bun:test';
import { AccountNodeSchema } from '../../../src/core/graphql/queries/accounts.js';
import { RecurringNodeSchema } from '../../../src/core/graphql/queries/recurrings.js';
import { ACCOUNT_LIVE_KNOWN_FIELDS } from '../../../src/tools/live/accounts.js';
import { RECURRING_LIVE_KNOWN_FIELDS } from '../../../src/tools/live/recurring.js';
import { UPCOMING_RECURRING_LIVE_KNOWN_FIELDS } from '../../../src/tools/live/upcoming-recurrings.js';

interface ParityCase {
  /** Tool whose row type is under test. */
  tool: string;
  /** The tool's selectable-field set. */
  known: ReadonlySet<string>;
  /** Zod mirror of the wire node the row copies. */
  wireFields: string[];
  /** Row keys that are deliberately NOT on the wire (joined/derived). */
  derived: string[];
}

// UpcomingRecurringNode IS RecurringNode (see
// src/core/graphql/queries/upcoming-recurrings.ts), so both recurring rows
// pin against the same mirror.
const CASES: ParityCase[] = [
  {
    tool: 'get_accounts_live',
    known: ACCOUNT_LIVE_KNOWN_FIELDS,
    wireFields: Object.keys(AccountNodeSchema.shape),
    derived: [],
  },
  {
    tool: 'get_recurring_live',
    known: RECURRING_LIVE_KNOWN_FIELDS,
    wireFields: Object.keys(RecurringNodeSchema.shape),
    derived: ['category_name'],
  },
  {
    tool: 'get_upcoming_recurrings_live',
    known: UPCOMING_RECURRING_LIVE_KNOWN_FIELDS,
    wireFields: Object.keys(RecurringNodeSchema.shape),
    derived: ['category_name'],
  },
];

const RECURRING_NODE_MIRROR_IS_EXACT: ExactKeys<
  keyof RecurringNode,
  keyof typeof RecurringNodeSchema.shape
> = true;

describe('live known-field sets stay in parity with their wire node (PR B review, I2)', () => {
  test('guards the gate: every case has a non-empty wire shape to compare against', () => {
    expect(CASES.length).toBeGreaterThan(0);
    for (const { tool, wireFields } of CASES) {
      expect(`${tool}:${wireFields.length > 0}`).toBe(`${tool}:true`);
    }
  });

  for (const { tool, known, wireFields, derived } of CASES) {
    // THE DIRECTION THAT MATTERS: a field added to the wire node (and so to
    // the spread-copied row) but never added to the row type / known set.
    test(`${tool}: every wire field is selectable by name`, () => {
      const missing = wireFields.filter((name) => !known.has(name));
      expect(missing).toEqual([]);
    });

    // The other direction: a known-field entry that no longer exists on the
    // wire and is not one of the row's declared derived keys — a stale name
    // the tool advertises as selectable while nothing can ever populate it.
    test(`${tool}: known fields beyond the wire are exactly its derived keys`, () => {
      const wire = new Set(wireFields);
      const extra = [...known].filter((name) => !wire.has(name)).sort();
      expect(extra).toEqual([...derived].sort());
    });
  }
});
