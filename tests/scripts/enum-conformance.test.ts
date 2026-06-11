/**
 * assertEnumConformance verdict logic (mocked fetch — no network).
 *
 * The silent-acceptance guard mirrors the field harness: a probe that
 * produces NO validation errors reached execution, which a validation-only
 * probe must never do (rules of engagement) — it must be a failure, not a
 * silent `serverValid: true`.
 */
import { describe, expect, test } from 'bun:test';
import { assertEnumConformance } from '../../scripts/smoke/_conformance.js';

const FRAGMENT_ENUM = 'TestEnum';

function buildQuery(value: string): string {
  return `mutation { probe(input: { state: ${value}, sibling: { z: 1 } }) { id } }`;
}

/** Mock fetch routing by probed value: empty-errors JSON vs enum rejection. */
async function withRoutedFetch(
  route: (query: string) => { errors?: Array<{ message: string }> },
  run: () => Promise<void>
): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_url: unknown, init?: { body?: string }) => {
    const query = (JSON.parse(init?.body ?? '{}') as { query?: string }).query ?? '';
    return Promise.resolve(new Response(JSON.stringify(route(query)), { status: 400 }));
  }) as unknown as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe('assertEnumConformance — silent-acceptance guard', () => {
  test('a value probe with NO validation errors is a failure, not serverValid', async () => {
    await withRoutedFetch(
      (query) =>
        query.includes('known_bad')
          ? {
              errors: [{ message: `Value "known_bad" does not exist in "${FRAGMENT_ENUM}" enum.` }],
            }
          : {}, // empty errors → probe reached execution
      async () => {
        const { failures } = await assertEnumConformance({
          enumName: FRAGMENT_ENUM,
          ourValues: ['monthly'],
          knownBad: 'known_bad',
          buildQuery,
          idToken: 'test-token',
        });
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('monthly: probe produced NO validation errors');
      }
    );
  });

  test('a value rejected only as part of an unrelated error is still server-valid', async () => {
    await withRoutedFetch(
      (query) => ({
        errors: [
          query.includes('known_bad')
            ? { message: `Value "known_bad" does not exist in "${FRAGMENT_ENUM}" enum.` }
            : { message: 'Field "z" is not defined by type "SiblingInput".' },
        ],
      }),
      async () => {
        const { failures } = await assertEnumConformance({
          enumName: FRAGMENT_ENUM,
          ourValues: ['monthly'],
          knownBad: 'known_bad',
          buildQuery,
          idToken: 'test-token',
        });
        expect(failures).toHaveLength(0);
      }
    );
  });

  test('one silent value among valid siblings fails alone (per-value independence)', async () => {
    await withRoutedFetch(
      (query) => {
        if (query.includes('known_bad')) {
          return {
            errors: [{ message: `Value "known_bad" does not exist in "${FRAGMENT_ENUM}" enum.` }],
          };
        }
        if (query.includes('weekly')) return {}; // silent acceptance for this value only
        return { errors: [{ message: 'Field "z" is not defined by type "SiblingInput".' }] };
      },
      async () => {
        const { failures } = await assertEnumConformance({
          enumName: FRAGMENT_ENUM,
          ourValues: ['monthly', 'weekly', 'yearly'],
          knownBad: 'known_bad',
          buildQuery,
          idToken: 'test-token',
        });
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('weekly: probe produced NO validation errors');
      }
    );
  });
});
