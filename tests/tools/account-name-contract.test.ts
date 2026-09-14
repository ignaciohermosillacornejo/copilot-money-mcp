/**
 * The `name` is-a-nickname contract, pinned in both modes (#665).
 *
 * `get_accounts` and `get_accounts_live` both return a USER-EDITABLE label in
 * `name`: the Copilot nickname when one is set, the provider's label
 * otherwise. A client that keys on it will break the first time someone
 * renames an account in the app. Both tool descriptions say so — and until
 * this file, nothing checked that they did.
 *
 * WHY IT NEEDS A TEST RATHER THAN A CONVENTION
 *
 * The contract is prose inside a schema that a context-diet release is
 * actively shrinking, and `get_accounts` sits 17 chars under its budget
 * (`tests/context-budget.test.ts`). The next person who needs room will find
 * this clause is the newest and most droppable thing in that description, and
 * deleting it makes CI *greener*. An incentive gradient pointing at a
 * caller-facing guarantee is exactly the situation a ratchet is for.
 *
 * It also keeps the two copies from drifting. They are one sentence differing
 * in a single word — the stable key is `account_id` on the cache row and `id`
 * on the live one — which is the shape that rots quietly.
 *
 * WHAT THIS DOES NOT PIN: that the values actually behave as promised. Cache
 * mode earns it by mapping `nickname` -> `name` (guarded in tools.test.ts);
 * live mode relies on the server resolving it, which was probed once and is
 * recorded as `AccountNode.name:resolvesNickname` (class `verified-once`) in
 * the conformance ledger. This file pins the DOCUMENTED contract, not the
 * data.
 */

import { describe, test, expect } from 'bun:test';
import { getAccountsTool } from '../../src/tools/registry/accounts-system.js';
import { getAccountsLiveTool } from '../../src/tools/registry/live.js';

/** The two surfaces that return an editable account label, and their real key. */
const SURFACES = [
  { tool: getAccountsTool, stableKey: 'account_id', otherKey: 'id' },
  { tool: getAccountsLiveTool, stableKey: 'id', otherKey: 'account_id' },
] as const;

describe('both account tools state the `name` contract (#665)', () => {
  test('guards the gate: both descriptions were actually found', () => {
    // Without this, a renamed export or an empty description would make every
    // assertion below pass over nothing.
    for (const { tool } of SURFACES) {
      const schema = tool.schema as { name: string; description: string };
      expect(schema.name).toMatch(/^get_accounts(_live)?$/);
      expect(schema.description.length).toBeGreaterThan(200);
    }
  });

  for (const { tool, stableKey, otherKey } of SURFACES) {
    const schema = tool.schema as { name: string; description: string };

    test(`${schema.name} says \`name\` is the nickname and is editable`, () => {
      expect(
        schema.description,
        `${schema.name}'s description must say \`name\` carries the Copilot nickname. ` +
          `A caller cannot otherwise tell the value is user-controlled.`
      ).toContain('nickname');
      expect(
        schema.description,
        `${schema.name}'s description must say \`name\` is user-editable — that is the half ` +
          `that tells a client not to store it.`
      ).toContain('user-editable');
    });

    test(`${schema.name} names ${stableKey} as the stable key, not ${otherKey}`, () => {
      // The one word that differs between the two copies, and the one that is
      // wrong if either is pasted into the other: the cache row's key is
      // `account_id`, the live row's is `id`.
      expect(
        schema.description,
        `${schema.name} must tell callers to key on \`${stableKey}\` — the field its own rows ` +
          `actually carry.`
      ).toContain(`key on ${stableKey}`);
    });
  }

  test("neither description tells a caller to key on the OTHER mode's field", () => {
    // Catches the paste: `get_accounts_live` advising `account_id` would name
    // a field absent from every row it returns, and the caller would have no
    // warning because the advice reads plausibly.
    for (const { tool, otherKey } of SURFACES) {
      const schema = tool.schema as { name: string; description: string };
      expect(
        schema.description.includes(`key on ${otherKey}`),
        `${schema.name} tells callers to key on \`${otherKey}\`, which is the other mode's ` +
          `field name — its own rows do not carry it.`
      ).toBe(false);
    }
  });
});
