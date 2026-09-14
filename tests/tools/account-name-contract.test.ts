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

/**
 * The two surfaces that return an editable account label, and their real key.
 *
 * `name` is in the table rather than read off the schema so the gate below can
 * detect the two rows resolving to the SAME tool — the failure the gate exists
 * to catch. No casts on `tool.schema`: `ToolSchema` already declares `name` and
 * `description` as required, and a cast would re-assert that if either ever
 * became optional, turning a compile error into a runtime throw. In a file
 * whose thesis is "don't let a guard go vacuous", suppressing the compiler is
 * the wrong line to write.
 */
const SURFACES = [
  { tool: getAccountsTool, name: 'get_accounts', stableKey: 'account_id', otherKey: 'id' },
  { tool: getAccountsLiveTool, name: 'get_accounts_live', stableKey: 'id', otherKey: 'account_id' },
] as const;

describe('both account tools state the `name` contract (#665)', () => {
  test('guards the gate: both descriptions were actually found, and they are different tools', () => {
    // Without this, a renamed export or an empty description would make every
    // assertion below pass over nothing. Asserting each name EXACTLY (rather
    // than matching a pattern both satisfy) is what makes the gate notice the
    // two rows pointing at one tool.
    for (const { tool, name } of SURFACES) {
      expect(tool.schema.name).toBe(name);
      expect(tool.schema.description.length).toBeGreaterThan(200);
    }
    expect(new Set(SURFACES.map((s) => s.tool.schema.name)).size).toBe(SURFACES.length);
  });

  for (const { tool, stableKey, otherKey } of SURFACES) {
    const schema = tool.schema;

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
      // Word-boundary, not substring: `key on id` is a prefix of `key on ids`
      // and `key on identifier`. The short word is the ONE that differs
      // between the two copies, so it is where exactness earns its keep.
      //
      // The optional backtick matters more for the paste-detector below than
      // here: these sentences backtick other field names two clauses earlier,
      // so a "make the field names consistent" edit is plausible — and it
      // would slip a pasted `key on \`account_id\`` PAST a bare-form check.
      expect(
        schema.description,
        `${schema.name} must tell callers to key on \`${stableKey}\` — the field its own rows ` +
          `actually carry.`
      ).toMatch(new RegExp(`key on \`?${stableKey}\\b`));
    });
  }

  test("neither description tells a caller to key on the OTHER mode's field", () => {
    // Catches the paste: `get_accounts_live` advising `account_id` would name
    // a field absent from every row it returns, and the caller would have no
    // warning because the advice reads plausibly.
    for (const { tool, otherKey } of SURFACES) {
      const schema = tool.schema;
      // Same boundary, for the same reason in reverse: a cache sentence that
      // legitimately said `key on ids` must not trip the paste-detector.
      expect(
        new RegExp(`key on \`?${otherKey}\\b`).test(schema.description),
        `${schema.name} tells callers to key on \`${otherKey}\`, which is the other mode's ` +
          `field name — its own rows do not carry it.`
      ).toBe(false);
    }
  });
});
