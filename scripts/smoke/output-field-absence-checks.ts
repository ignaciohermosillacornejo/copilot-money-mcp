/**
 * Output-field ABSENCE conformance (PR C, #604).
 *
 * `get_transactions_live` SYNTHESIZES `excluded` and `internal_transfer`
 * because the GraphQL `Transaction` type exposes neither — the app writes the
 * per-transaction exclusion flag straight to Firestore, and transfers are
 * modelled only as `type === 'INTERNAL_TRANSFER'`. Both are recorded in the
 * conformance ledger as `Transaction.*:synthesized`.
 *
 * That is an assumption about someone else's schema, and it is the kind that
 * rots silently in the GOOD direction: if Copilot ever adds a real `excluded`
 * field, our category-level approximation becomes both unnecessary and
 * possibly wrong, and nothing in the repo would notice. Every other
 * conformance check here asks "is what we send still accepted?"; this one asks
 * "is what we assume missing still missing?".
 *
 * Probe safety: read-only queries with `first: 1`. The absent-field and
 * known-bad probes are rejected during VALIDATION, before any resolver runs.
 * The `presentField` control is valid GraphQL by design, so it is the one
 * probe in the suite that EXECUTES — a read of a single transaction, selecting
 * one field. Nothing mutates.
 *
 * Non-vacuous by construction — each check asserts three things:
 *   1. every `absentFields` name is REJECTED (the assumption still holds);
 *   2. `presentField` is ACCEPTED (we are not merely seeing blanket
 *      rejection — e.g. the whole query being malformed would "pass" a
 *      rejection-only check while proving nothing);
 *   3. `knownBadField` is REJECTED (the probe discriminates at all).
 */

import { CONFORMANCE_LEDGER } from '../../src/conformance/ledger.js';

/** Control name — must not exist on any Copilot output type. */
export const KNOWN_BAD_OUTPUT_FIELD = 'zzNotARealOutputField';

export interface OutputFieldAbsenceCheck {
  /** GraphQL output type under test, as the server names it. */
  typeName: string;
  /** Ledger surfaces this check gates, e.g. `Transaction.excluded:synthesized`. */
  ledgerSurfaces: readonly string[];
  /** Field names our synthesis assumes the server does NOT expose. */
  absentFields: readonly string[];
  /** A field that MUST exist — proves the probe isn't rejecting everything. */
  presentField: string;
  knownBadField: string;
  /** Builds a read-only probe selecting one field on the type. */
  buildQuery: (fieldName: string) => string;
}

export const TRANSACTION_ABSENCE_CHECK: OutputFieldAbsenceCheck = {
  typeName: 'Transaction',
  ledgerSurfaces: ['Transaction.excluded:synthesized', 'Transaction.internalTransfer:synthesized'],
  // Probed 2026-09-11: all rejected with `Cannot query field "<name>" on type
  // "Transaction"`, and Apollo offered no "did you mean" suggestion for any of
  // them, so nothing near these names exists either.
  absentFields: [
    'excluded',
    'isExcluded',
    'userExcluded',
    'isUserExcluded',
    'excludeFromSpending',
    'internalTransfer',
    'isInternalTransfer',
    'isTransfer',
  ],
  // `type` is the input to the internal_transfer synthesis. If it ever stops
  // being selectable, that synthesis loses its source and this check must fail
  // for that reason rather than silently keep passing on absences alone.
  presentField: 'type',
  knownBadField: KNOWN_BAD_OUTPUT_FIELD,
  buildQuery: (fieldName) =>
    `query AbsenceProbe {
  transactions(first: 1) {
    edges {
      node {
        ${fieldName}
      }
    }
  }
}`,
};

export const ALL_OUTPUT_FIELD_ABSENCE_CHECKS: readonly OutputFieldAbsenceCheck[] = [
  TRANSACTION_ABSENCE_CHECK,
];

/**
 * Every ledger surface whose class is a synthesis, derived from the ledger
 * rather than re-typed, so `tests/scripts/synthesized-field-coverage.test.ts`
 * can require a check for each one. A new synthesized field therefore cannot
 * ship without a smoke that watches for the real field arriving.
 */
export function synthesizedLedgerSurfaces(): string[] {
  return CONFORMANCE_LEDGER.filter((e) => e.surface.endsWith(':synthesized')).map((e) => e.surface);
}
