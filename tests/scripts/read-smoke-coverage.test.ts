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
import { QUERY_RESPONSE_SCHEMAS } from '../../src/core/graphql/read-response-validation.js';

interface ParsedQuery {
  /** Operation name, e.g. 'Accounts'. */
  name: string;
  /** First root-level field the document selects, e.g. 'accounts'. */
  rootField: string;
}

/**
 * Parse `query <Name>(...) { <rootField> ... }` out of every generated document.
 *
 * Returns the documents it could not parse rather than asserting on them. This
 * runs at module scope, so an `expect()` here fires while bun is still
 * collecting: the failure arrives as an unnamed load error and every test below
 * is dropped from the run instead of reporting (#714). The gate test asserts on
 * `unparseable`, which matters more than it looks — a document silently skipped
 * here would silently leave the coverage ratchet.
 */
function parseQueries(): { parsed: ParsedQuery[]; unparseable: string[] } {
  const parsed: ParsedQuery[] = [];
  const unparseable: string[] = [];
  for (const value of Object.values(generated)) {
    if (typeof value !== 'string' || !value.startsWith('query ')) continue;
    const match = /^query\s+(\w+)[^{]*\{\s*(\w+)/.exec(value);
    if (match === null) {
      unparseable.push(value.slice(0, 80));
      continue;
    }
    parsed.push({ name: match[1]!, rootField: match[2]! });
  }
  return { parsed, unparseable };
}

const { parsed: queries, unparseable } = parseQueries();
const ledgerSurfaces = new Set(CONFORMANCE_LEDGER.map((entry) => entry.surface));

describe('read-smoke coverage ratchet', () => {
  test('sanity: the generated-operations walk finds the full query surface', () => {
    // 19 query operations as of #460; grows as new captures land.
    expect(queries.length).toBeGreaterThanOrEqual(19);
    const names = queries.map((q) => q.name);
    expect(new Set(names).size).toBe(names.length);
    expect(
      unparseable,
      `Generated documents that start with \`query \` but do not match the ` +
        `\`query <Name> ... { <rootField>\` shape this file parses. Nothing below can see ` +
        `them, so an unparsed document would drop out of the ratchet without a red:\n  ` +
        `${unparseable.join('\n  ')}`
    ).toEqual([]);
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

  test('(b) every QUERY_RESPONSE_SCHEMAS key is a real generated operation name whose surface matches its root field', () => {
    // The client dispatches read validation by the registry KEY (the operation
    // name passed to client.query). A mistyped key would satisfy the ledger
    // bijection + fixture ratchet yet never fire at runtime — a silent paper
    // gate. This asserts registration is genuinely activation.
    const rootFieldByOp = new Map(queries.map((q) => [q.name, q.rootField]));
    for (const [opName, entry] of Object.entries(QUERY_RESPONSE_SCHEMAS)) {
      const rootField = rootFieldByOp.get(opName);
      expect(
        rootField,
        `QUERY_RESPONSE_SCHEMAS key '${opName}' is not a generated GraphQL operation name — ` +
          `client.query('${opName}', …) would never dispatch to it (silent paper gate)`
      ).toBeDefined();
      expect(
        entry.surface,
        `QUERY_RESPONSE_SCHEMAS['${opName}'].surface must be Query.<rootField>:response for its operation`
      ).toBe(`Query.${rootField}:response`);
    }
  });
});
