import type { Transaction } from '../../src/models/index.js';

/**
 * The declared fields of a model, without its `.passthrough()` catchall.
 *
 * TransactionSchema ends in `.passthrough()`, so `Transaction` carries a
 * `[k: string]: unknown` index signature. That signature absorbs any key, so
 * `{ transction_id: 'x' } satisfies Partial<Transaction>` compiles: excess-
 * property checking never fires. It also makes `keyof Transaction` collapse to
 * `string | number`, so `Omit<Partial<Transaction>, K>` erases every declared
 * field. Mapping the index signatures away restores both checks (#919, #929
 * review).
 */
export type Declared<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

/**
 * A partial transaction row for seeding a fixture: every key must be a real
 * Transaction field, spelled right, with the declared type. Use as
 * `[...] satisfies TxFixture[] as Transaction[]` for rows that omit required
 * fields the code under test never reads.
 */
export type TxFixture = Partial<Declared<Transaction>>;

// Probes: these lines fail to compile if the catchall stripping ever stops
// working, because the @ts-expect-error then has no error to expect. The file
// is typechecked through its importers on tsconfig.tests.json's include list.
// @ts-expect-error a misspelled field name is not a Transaction field
const _misspelled = [{ transction_id: 'x' }] satisfies TxFixture[];
// @ts-expect-error a declared field keeps its declared type
const _mistyped = [{ amount: 'x' }] satisfies TxFixture[];
const _correct = [{ transaction_id: 'x', amount: 1 }] satisfies TxFixture[];
export const FIXTURE_TYPE_PROBES = [_misspelled, _mistyped, _correct];
