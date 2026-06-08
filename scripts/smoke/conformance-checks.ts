/**
 * Per-enum conformance check definitions (issue #421).
 *
 * Each export bundles the three inputs `assertEnumConformance` needs for one
 * server enum: `enumName`, `ourValues` (the constant under test), `knownBad`
 * (a discriminating control the server MUST reject), and `buildQuery` (inlines
 * a candidate value into a VALIDATION-ONLY probe).
 *
 * Every `buildQuery` includes a deliberately MALFORMED sibling field so the
 * server rejects the request during query validation, BEFORE any resolver runs
 * — the fake ids ("x") are never used to mutate anything. The enum literal is
 * inlined (not a variable) so it is validated at parse time.
 *
 * Shared by the standalone scripts and the conformance runner so the query
 * shapes and known-bad controls live in exactly one place.
 */

import {
  RECURRING_FREQUENCIES,
  RECURRING_STATE_VALUES,
} from '../../src/core/graphql/recurrings.js';
import { TRANSACTION_TYPES } from '../../src/core/graphql/transactions.js';

export {
  assertEnumConformance,
  getIdToken,
  smokeLog,
  type EnumConformanceOptions,
  type EnumConformanceResult,
} from './_conformance.js';

export interface ConformanceCheck {
  enumName: string;
  ourValues: readonly string[];
  knownBad: string;
  buildQuery: (value: string) => string;
}

// --- RecurringFrequency -----------------------------------------------------
// Malformed `state: { z: 1 }` forces pre-execution validation failure.
// Control: 'YEARLY' is the intuitive-but-wrong value — it's the exact bug from
// issue #419 (the real enum uses 'ANNUALLY'), so it must be server-rejected.
export const KNOWN_BAD_RECURRING_FREQUENCY = 'YEARLY';

export const RECURRING_FREQUENCY_CHECK: ConformanceCheck = {
  enumName: 'RecurringFrequency',
  ourValues: RECURRING_FREQUENCIES,
  knownBad: KNOWN_BAD_RECURRING_FREQUENCY,
  buildQuery: (value) =>
    `mutation FrequencyProbe {
  editRecurring(id: "x", input: { frequency: ${value}, state: { z: 1 } }) {
    recurring {
      id
    }
  }
}`,
};

// --- RecurringState ---------------------------------------------------------
// Malformed `frequency: { z: 1 }` forces pre-execution validation failure.
// Control: 'ACTIVATED' is a plausible-looking but non-existent state (the real
// set is ACTIVE/PAUSED/ARCHIVED), so it must be server-rejected.
export const KNOWN_BAD_RECURRING_STATE = 'ACTIVATED';

export const RECURRING_STATE_CHECK: ConformanceCheck = {
  enumName: 'RecurringState',
  ourValues: RECURRING_STATE_VALUES,
  knownBad: KNOWN_BAD_RECURRING_STATE,
  buildQuery: (value) =>
    `mutation StateProbe {
  editRecurring(id: "x", input: { state: ${value}, frequency: { z: 1 } }) {
    recurring {
      id
    }
  }
}`,
};

// --- TransactionType --------------------------------------------------------
// Malformed `categoryId: { z: 1 }` forces pre-execution validation failure.
// Control: 'EXPENSE' is a plausible-but-invalid type — the real set is
// REGULAR/INCOME/INTERNAL_TRANSFER — so it must be server-rejected.
export const KNOWN_BAD_TRANSACTION_TYPE = 'EXPENSE';

// We probe `editTransaction` (not `createTransaction`) because the server
// validates `type` as a `TransactionType` enum there with the fewest required
// args, keeping the malformed-sibling setup simple. Note `EditTransactionInput`
// in transactions.ts doesn't expose `type` as a writable field even though the
// server accepts it — that latent capability is tracked in #415.
export const TRANSACTION_TYPE_CHECK: ConformanceCheck = {
  enumName: 'TransactionType',
  ourValues: TRANSACTION_TYPES,
  knownBad: KNOWN_BAD_TRANSACTION_TYPE,
  buildQuery: (value) =>
    `mutation TypeProbe {
  editTransaction(id: "x", accountId: "x", itemId: "x", input: { type: ${value}, categoryId: { z: 1 } }) {
    transaction {
      id
    }
  }
}`,
};

/** All conformance checks, in runner order. */
export const ALL_CONFORMANCE_CHECKS: readonly ConformanceCheck[] = [
  RECURRING_FREQUENCY_CHECK,
  RECURRING_STATE_CHECK,
  TRANSACTION_TYPE_CHECK,
];
