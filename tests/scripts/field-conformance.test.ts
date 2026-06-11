/**
 * Input-field conformance harness + check definitions (issue #436, Epic B #421).
 *
 * Plain unit tests — no auth, no network. The live HTTP probe is replaced by
 * an injected `probeFn`; the live gate itself (`bun run smoke`) runs locally
 * before merge per the per-PR smoke policy.
 *
 * Covers:
 *   - assertFieldConformance verdict logic (exists / not-defined / silent
 *     acceptance / control discrimination);
 *   - sendValidationProbe response handling (mocked fetch): JSON errors are
 *     joined with unescaped quotes; non-JSON bodies (expired session) throw
 *     instead of masquerading as a passing probe;
 *   - the check definitions: full coverage of the #436 input types, valid
 *     GraphQL probe shapes, fake-ids-only, malformed-element safety incl.
 *     ledger-derived siblings, the bulkEditTransactions ban, and
 *     bidirectional alignment with the conformance ledger's smoke-gated
 *     input-field surfaces.
 */

import { describe, expect, test } from 'bun:test';
import { parse } from 'graphql';
import { sendValidationProbe } from '../../scripts/smoke/_conformance.js';
import { assertFieldConformance } from '../../scripts/smoke/_field-conformance.js';
import {
  ALL_FIELD_CONFORMANCE_CHECKS,
  KNOWN_BAD_FIELD,
} from '../../scripts/smoke/field-conformance-checks.js';
import { CONFORMANCE_LEDGER } from '../../src/conformance/ledger.js';

// ---------------------------------------------------------------------------
// Harness verdict logic (stubbed probe)
// ---------------------------------------------------------------------------

const TYPE_MISMATCH = 'String cannot represent a non string value: {z: 1}';
const notDefined = (field: string, type = 'SomeInput'): string =>
  `Field "${field}" is not defined by type "${type}".`;

/** probeFn stub: answers per probed field (the field name is recoverable from
 * the query because buildQuery embeds it as `<field>: { z: 1 }`). */
function stubProbe(
  answers: Record<string, string>
): (idToken: string, query: string) => Promise<string> {
  return (_idToken, query) => {
    for (const [field, body] of Object.entries(answers)) {
      if (query.includes(`${field}: { z: 1 }`)) return Promise.resolve(body);
    }
    throw new Error(`stubProbe: no answer for query: ${query}`);
  };
}

const BASE_OPTS = {
  inputTypeName: 'ExampleInput',
  fields: ['name', 'colorName'] as const,
  knownBadField: KNOWN_BAD_FIELD,
  buildQuery: (field: string) =>
    `mutation FieldProbe { example(input: { ${field}: { z: 1 } }) { __typename } }`,
  idToken: 'unused-by-stub',
};

describe('assertFieldConformance', () => {
  test('passes when every field draws a type error and the control is undefined', async () => {
    const result = await assertFieldConformance({
      ...BASE_OPTS,
      probeFn: stubProbe({
        name: TYPE_MISMATCH,
        colorName: TYPE_MISMATCH,
        [KNOWN_BAD_FIELD]: notDefined(KNOWN_BAD_FIELD),
      }),
    });
    expect(result.label).toBe('ExampleInput');
    expect(result.failures).toEqual([]);
  });

  test('fails when a declared field comes back "is not defined" (drift)', async () => {
    const result = await assertFieldConformance({
      ...BASE_OPTS,
      probeFn: stubProbe({
        name: TYPE_MISMATCH,
        colorName: notDefined('colorName'),
        [KNOWN_BAD_FIELD]: notDefined(KNOWN_BAD_FIELD),
      }),
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('colorName');
    expect(result.failures[0]).toContain('not defined');
  });

  test('fails when a probe produces no errors at all (validation-only violated)', async () => {
    const result = await assertFieldConformance({
      ...BASE_OPTS,
      probeFn: stubProbe({
        name: '',
        colorName: TYPE_MISMATCH,
        [KNOWN_BAD_FIELD]: notDefined(KNOWN_BAD_FIELD),
      }),
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('name');
    expect(result.failures[0]).toContain('NO validation errors');
  });

  test('fails when the control field is NOT rejected (probe not discriminating)', async () => {
    const result = await assertFieldConformance({
      ...BASE_OPTS,
      probeFn: stubProbe({
        name: TYPE_MISMATCH,
        colorName: TYPE_MISMATCH,
        [KNOWN_BAD_FIELD]: TYPE_MISMATCH, // server "accepted" the bogus field name
      }),
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain(KNOWN_BAD_FIELD);
    expect(result.failures[0]).toContain('not discriminating');
  });

  test('a not-defined error about a DIFFERENT name does not fail the probed field', async () => {
    // Probing an input-object field with { z: 1 } legitimately yields
    // `Field "z" is not defined by type "<NestedType>"` — that must not be
    // mistaken for the probed field being undefined.
    const result = await assertFieldConformance({
      ...BASE_OPTS,
      fields: ['rule'],
      probeFn: stubProbe({
        rule: notDefined('z', 'NestedRuleInput'),
        [KNOWN_BAD_FIELD]: notDefined(KNOWN_BAD_FIELD),
      }),
    });
    expect(result.failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sendValidationProbe response handling (mocked fetch — no network)
// ---------------------------------------------------------------------------

describe('sendValidationProbe', () => {
  async function withMockedFetch(response: Response, run: () => Promise<void>): Promise<void> {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(response)) as unknown as typeof fetch;
    try {
      await run();
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  test('joins JSON errors[].message with unescaped quotes', async () => {
    const body = JSON.stringify({
      errors: [{ message: 'Field "zz" is not defined by type "SomeInput".' }],
    });
    await withMockedFetch(new Response(body, { status: 400 }), async () => {
      const result = await sendValidationProbe('token', 'mutation { x }');
      expect(result).toBe('Field "zz" is not defined by type "SomeInput".');
    });
  });

  test('throws on a non-JSON body — an expired session must not look like a pass', async () => {
    // An HTML error page contains no rejection fragment; if it were returned
    // as text, every field probe built on it would read as serverDefined:
    // true (a silent false negative for drift). It must throw instead.
    await withMockedFetch(new Response('<html>session expired</html>', { status: 401 }), () =>
      expect(sendValidationProbe('token', 'mutation { x }')).rejects.toThrow(
        'non-JSON response (HTTP 401)'
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Check definitions
// ---------------------------------------------------------------------------

/** The 11 input types #436 requires, plus the nested rule object. */
const REQUIRED_COVERAGE = [
  'CreateTransactionInput',
  'EditTransactionInput',
  'SplitTransactionInput',
  'AddTransactionToRecurringInput',
  'CreateRecurringInput',
  'EditRecurringInput',
  'EditRecurringInput.rule',
  'CreateCategoryInput',
  'EditCategoryInput',
  'CreateTagInput',
  'EditTagInput',
  'EditAccountInput',
];

describe('field conformance checks', () => {
  test('covers exactly the #436 input types (plus the nested rule object)', () => {
    const covered = ALL_FIELD_CONFORMANCE_CHECKS.map((c) => c.inputTypeName).sort();
    expect(covered).toEqual([...REQUIRED_COVERAGE].sort());
  });

  test('every check has at least one field and the shared control', () => {
    for (const check of ALL_FIELD_CONFORMANCE_CHECKS) {
      expect(check.fields.length).toBeGreaterThan(0);
      expect(check.knownBadField).toBe(KNOWN_BAD_FIELD);
    }
  });

  test('every probe (fields + control) is syntactically valid GraphQL', () => {
    for (const check of ALL_FIELD_CONFORMANCE_CHECKS) {
      for (const field of [...check.fields, check.knownBadField]) {
        expect(() => parse(check.buildQuery(field))).not.toThrow();
      }
    }
  });

  test('every probe embeds the probed field with the bogus value', () => {
    for (const check of ALL_FIELD_CONFORMANCE_CHECKS) {
      for (const field of [...check.fields, check.knownBadField]) {
        expect(check.buildQuery(field)).toContain(`${field}: { z: 1 }`);
      }
    }
  });

  test('every string literal in every probe is the fake id "x" (nothing real addressed)', () => {
    for (const check of ALL_FIELD_CONFORMANCE_CHECKS) {
      for (const field of [...check.fields, check.knownBadField]) {
        const literals = [...check.buildQuery(field).matchAll(/"([^"]*)"/g)].map((m) => m[1]);
        expect(literals.every((value) => value === 'x')).toBe(true);
      }
    }
  });

  test('every probe carries a malformed sibling whenever a distinct field exists', () => {
    for (const check of ALL_FIELD_CONFORMANCE_CHECKS) {
      // The nested-rule check carries its malformed sibling OUTSIDE the rule
      // object (covered by its dedicated test below).
      if (check.inputTypeName === 'EditRecurringInput.rule') continue;
      for (const field of [...check.fields, check.knownBadField]) {
        const bogusAssignments = [...check.buildQuery(field).matchAll(/(\w+): \{ z: 1 \}/g)].map(
          (m) => m[1]
        );
        expect(bogusAssignments).toContain(field);
        // A distinct sibling must appear exactly when the type has another
        // field to draw it from (single-field types probing their own field
        // legitimately have none).
        const expectSibling = check.fields.some((name) => name !== field);
        expect(bogusAssignments.some((name) => name !== field)).toBe(expectSibling);
      }
    }
  });

  test('malformed siblings are drawn from the ledger-derived field list (never stale)', () => {
    for (const check of ALL_FIELD_CONFORMANCE_CHECKS) {
      if (check.inputTypeName === 'EditRecurringInput.rule') continue;
      for (const field of [...check.fields, check.knownBadField]) {
        const bogusAssignments = [...check.buildQuery(field).matchAll(/(\w+): \{ z: 1 \}/g)].map(
          (m) => m[1]
        );
        for (const sibling of bogusAssignments.filter((name) => name !== field)) {
          expect(check.fields).toContain(sibling);
        }
      }
    }
  });

  test('the nested rule probe keeps its malformed sibling OUTSIDE the rule object', () => {
    const rule = ALL_FIELD_CONFORMANCE_CHECKS.find(
      (c) => c.inputTypeName === 'EditRecurringInput.rule'
    );
    expect(rule).toBeDefined();
    for (const field of [...(rule?.fields ?? []), KNOWN_BAD_FIELD]) {
      const query = rule?.buildQuery(field) ?? '';
      expect(query).toContain(`rule: { ${field}: { z: 1 } }`);
      expect(query).toContain('frequency: { z: 1 }');
    }
    // The outer sibling must itself be a real (ledger-derived) field of the
    // enclosing EditRecurringInput type.
    const outer = ALL_FIELD_CONFORMANCE_CHECKS.find(
      (c) => c.inputTypeName === 'EditRecurringInput'
    );
    expect(outer?.fields).toContain('frequency');
  });

  test('NEVER probes bulkEditTransactions (rules of engagement)', () => {
    for (const check of ALL_FIELD_CONFORMANCE_CHECKS) {
      for (const field of [...check.fields, check.knownBadField]) {
        expect(check.buildQuery(field)).not.toContain('bulkEditTransactions');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Ledger alignment — gated input-field surfaces ⟷ probed fields, both ways
// ---------------------------------------------------------------------------

describe('ledger alignment', () => {
  const probedSurfaces = new Set(
    ALL_FIELD_CONFORMANCE_CHECKS.flatMap((check) =>
      check.fields.map((field) => `${check.inputTypeName}.${field}`)
    )
  );
  const gatedInputFieldSurfaces = CONFORMANCE_LEDGER.filter(
    (entry) => entry.kind === 'input-field' && entry.oracle === 'smoke:conformance'
  ).map((entry) => entry.surface);

  test('every smoke-gated input-field ledger surface is probed', () => {
    const unprobed = gatedInputFieldSurfaces.filter((surface) => !probedSurfaces.has(surface));
    expect(
      unprobed,
      `Ledger claims these input-field surfaces are gated by smoke:conformance but no ` +
        `field probe covers them: ${unprobed.join(', ')}`
    ).toEqual([]);
  });

  test('every probed field maps to a gated smoke:conformance ledger entry', () => {
    const gated = new Set(gatedInputFieldSurfaces);
    const unledgered = [...probedSurfaces].filter((surface) => !gated.has(surface));
    expect(
      unledgered,
      `These probed fields have no gated input-field ledger entry — upgrade the ledger ` +
        `(class 'gated', oracle 'smoke:conformance') or drop the probe: ${unledgered.join(', ')}`
    ).toEqual([]);
    const notGatedClass = CONFORMANCE_LEDGER.filter(
      (entry) => entry.kind === 'input-field' && probedSurfaces.has(entry.surface)
    ).filter((entry) => entry.class !== 'gated');
    expect(notGatedClass.map((entry) => entry.surface)).toEqual([]);
  });

  test('budget input fields stay verified-once (not covered by B2 probes)', () => {
    const budgetEntries = CONFORMANCE_LEDGER.filter(
      (entry) => entry.kind === 'input-field' && entry.surface.startsWith('EditCategoryBudget')
    );
    expect(budgetEntries.length).toBeGreaterThan(0);
    for (const entry of budgetEntries) {
      expect(entry.class).toBe('verified-once');
      expect(probedSurfaces.has(entry.surface)).toBe(false);
    }
  });
});
