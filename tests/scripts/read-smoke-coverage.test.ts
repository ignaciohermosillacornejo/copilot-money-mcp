/**
 * Read-surface coverage ratchet (issues #439/#460, Epic B #421).
 *
 * Plain unit test — no auth, no network. Enforces that the read side of the
 * external GraphQL surface stays fully inventoried and smoke-covered:
 *
 * (a) every QUERY operation in `operations.generated.ts` has exactly one
 *     Tier-0 read smoke check (scripts/smoke/read-checks.ts) whose
 *     `operation`/`rootField` match the generated document;
 * (b) every QUERY operation has a `Query.<rootField>` operation entry AND a
 *     `Query.<rootField>:response` response-shape entry in the conformance
 *     ledger;
 * (c) no stale smoke checks: every check maps back to a generated query.
 *
 * Together with `tests/conformance/ledger.test.ts` (which verifies the
 * `smoke:reads` oracle script exists), this makes "new query without a smoke
 * + ledger entry" a red build — the class-level fix for boundary-audit
 * finding F1 (#460).
 */

import { describe, test, expect } from 'bun:test';
import * as generated from '../../src/core/graphql/operations.generated.js';
import { READ_SMOKE_CHECKS } from '../../scripts/smoke/read-checks.js';
import { CONFORMANCE_LEDGER } from '../../src/conformance/ledger.js';

interface ParsedQuery {
  /** Operation name, e.g. 'Accounts'. */
  name: string;
  /** First root-level field the document selects, e.g. 'accounts'. */
  rootField: string;
}

/** Parse `query <Name>(...) { <rootField> ... }` out of a generated document. */
function parseQueries(): ParsedQuery[] {
  const parsed: ParsedQuery[] = [];
  for (const value of Object.values(generated)) {
    if (typeof value !== 'string' || !value.startsWith('query ')) continue;
    const match = /^query\s+(\w+)[^{]*\{\s*(\w+)/.exec(value);
    expect(match, `could not parse a generated query document: ${value.slice(0, 80)}`).not.toBe(
      null
    );
    parsed.push({ name: match![1]!, rootField: match![2]! });
  }
  return parsed;
}

const queries = parseQueries();
const ledgerSurfaces = new Set(CONFORMANCE_LEDGER.map((entry) => entry.surface));

describe('read-smoke coverage ratchet', () => {
  test('sanity: the generated-operations walk finds the full query surface', () => {
    // 19 query operations as of #460; grows as new captures land.
    expect(queries.length).toBeGreaterThanOrEqual(19);
    const names = queries.map((q) => q.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('(a) every generated query has exactly one read smoke check with a matching root field', () => {
    for (const query of queries) {
      const checks = READ_SMOKE_CHECKS.filter((check) => check.operation === query.name);
      expect(
        checks.length,
        `Query operation '${query.name}' must have exactly one Tier-0 check in ` +
          `scripts/smoke/read-checks.ts (found ${checks.length})`
      ).toBe(1);
      expect(
        checks[0]!.rootField,
        `Check for '${query.name}' declares rootField '${checks[0]!.rootField}' but the ` +
          `generated document selects '${query.rootField}'`
      ).toBe(query.rootField);
    }
  });

  test('(b) every generated query has ledger operation + response-shape entries', () => {
    for (const query of queries) {
      expect(
        ledgerSurfaces.has(`Query.${query.rootField}`),
        `Missing ledger entry 'Query.${query.rootField}' for operation '${query.name}' ` +
          '(src/conformance/ledger.ts)'
      ).toBe(true);
      expect(
        ledgerSurfaces.has(`Query.${query.rootField}:response`),
        `Missing ledger entry 'Query.${query.rootField}:response' for operation '${query.name}'`
      ).toBe(true);
    }
  });

  test('(c) no stale smoke checks: every check maps to a generated query', () => {
    const queryNames = new Set(queries.map((q) => q.name));
    const stale = READ_SMOKE_CHECKS.filter((check) => !queryNames.has(check.operation)).map(
      (check) => check.operation
    );
    expect(
      stale,
      `Read smoke checks without a generated query operation: ${stale.join(', ')}`
    ).toEqual([]);
  });

  test('(c) no stale ledger entries: every Query.* surface maps to a generated root field', () => {
    const rootFields = new Set(queries.map((q) => q.rootField));
    const stale = CONFORMANCE_LEDGER.map((entry) => entry.surface)
      .filter((surface) => surface.startsWith('Query.'))
      .filter((surface) => {
        const field = surface.slice('Query.'.length).replace(/:response$/, '');
        return !rootFields.has(field);
      });
    expect(
      stale,
      `Ledger Query.* surfaces without a generated query operation: ${stale.join(', ')}`
    ).toEqual([]);
  });
});
