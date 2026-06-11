/**
 * Structural checks for the conformance check definitions (issues #421/#439).
 *
 * No network — validates that each ConformanceCheck is internally consistent:
 * the known-bad control is genuinely outside our value set, every value set is
 * non-empty, and buildQuery produces a parseable GraphQL document that inlines
 * the candidate value (so the server validates it at parse time).
 */

import { describe, expect, test } from 'bun:test';
import { parse } from 'graphql';
import {
  ALL_CONFORMANCE_CHECKS,
  COLOR_NAME_CHECK,
  TIME_FRAME_CHECK,
} from '../../scripts/smoke/conformance-checks.js';

describe('ALL_CONFORMANCE_CHECKS', () => {
  test('includes the B5 ColorName and TimeFrame enum probes', () => {
    expect(ALL_CONFORMANCE_CHECKS).toContain(COLOR_NAME_CHECK);
    expect(ALL_CONFORMANCE_CHECKS).toContain(TIME_FRAME_CHECK);
  });

  test.each(ALL_CONFORMANCE_CHECKS.map((c) => [c.enumName, c] as const))(
    '%s: control is outside our values, set is non-empty, and the value inlines into a parseable probe',
    (_name, check) => {
      expect(check.ourValues.length).toBeGreaterThan(0);
      expect(check.ourValues).not.toContain(check.knownBad);

      const query = check.buildQuery(check.ourValues[0]!);
      // Inlined (not a $variable) so the server validates it at parse time.
      expect(query).toContain(check.ourValues[0]!);
      expect(query).not.toContain('$');
      // Parses as a valid GraphQL document (validation-only probe shape).
      expect(() => parse(query)).not.toThrow();

      // The known-bad control must also produce a parseable probe.
      expect(() => parse(check.buildQuery(check.knownBad))).not.toThrow();
    }
  );

  test('TimeFrame probe is a read query; ColorName probe is a mutation', () => {
    expect(TIME_FRAME_CHECK.buildQuery('ALL').trimStart().startsWith('query')).toBe(true);
    expect(COLOR_NAME_CHECK.buildQuery('RED1').trimStart().startsWith('mutation')).toBe(true);
  });
});
