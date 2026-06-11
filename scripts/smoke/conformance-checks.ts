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
import { COLOR_NAMES } from '../../src/core/graphql/colors.js';
import { ALL_TIME_FRAMES } from '../../src/core/graphql/queries/_shared.js';

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

// --- ColorName ----------------------------------------------------------------
// Malformed `name: { z: 1 }` (CreateTagInput.name is String!) forces
// pre-execution validation failure. Control: 'GREEN2' is the plausible-but-wrong
// value — five palette bases (ORANGE/PINK/PURPLE/RED/YELLOW) have a *2 variant
// but GREEN does not, so it must be server-rejected.
export const KNOWN_BAD_COLOR_NAME = 'GREEN2';

export const COLOR_NAME_CHECK: ConformanceCheck = {
  enumName: 'ColorName',
  ourValues: COLOR_NAMES,
  knownBad: KNOWN_BAD_COLOR_NAME,
  buildQuery: (value) =>
    `mutation ColorNameProbe {
  createTag(input: { name: { z: 1 }, colorName: ${value} }) {
    id
  }
}`,
};

// --- TimeFrame ----------------------------------------------------------------
// Read-side enum (live-reads query wrappers, src/core/graphql/queries/_shared.ts).
// Probed through BalanceHistory's `timeFrame` arg; the malformed `itemId: { z: 1 }`
// (ID!) forces pre-execution validation failure so the probe never reaches a
// resolver. Control: 'YEAR' is the intuitive-but-wrong value (the real enum uses
// 'ONE_YEAR'), so it must be server-rejected.
//
// Scope note: this gates enum MEMBERSHIP at the schema level. Per-operation
// value restrictions (e.g. the high-frequency prices endpoint only honoring
// ONE_DAY/ONE_WEEK) are resolver behavior and not covered here.
export const KNOWN_BAD_TIME_FRAME = 'YEAR';

export const TIME_FRAME_CHECK: ConformanceCheck = {
  enumName: 'TimeFrame',
  ourValues: ALL_TIME_FRAMES,
  knownBad: KNOWN_BAD_TIME_FRAME,
  buildQuery: (value) =>
    `query TimeFrameProbe {
  accountBalanceHistory(itemId: { z: 1 }, accountId: "x", timeFrame: ${value}) {
    date
  }
}`,
};

/** All conformance checks, in runner order. */
export const ALL_CONFORMANCE_CHECKS: readonly ConformanceCheck[] = [
  RECURRING_FREQUENCY_CHECK,
  RECURRING_STATE_CHECK,
  TRANSACTION_TYPE_CHECK,
  COLOR_NAME_CHECK,
  TIME_FRAME_CHECK,
];
