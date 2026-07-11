/**
 * Unit tests for warn-mode mutation response-shape validation (issue #437).
 *
 * Contract under test:
 * - happy path: a response matching the registered schema produces zero
 *   warnings and zero drift counts (covered for ALL registered operations);
 * - drift (missing/renamed/retyped field we read): one structured
 *   `console.warn` on first occurrence, deduped per (operation, path, code)
 *   per process, with the per-surface counter counting EVERY occurrence;
 * - never throws, never alters the payload — warn-mode only;
 * - new/unknown server fields pass through silently (loose schemas).
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  MUTATION_RESPONSE_SCHEMAS,
  validateMutationResponse,
  getResponseDriftStats,
  __resetResponseDriftState,
} from '../../../src/core/graphql/response-validation.js';

// ---------------------------------------------------------------------------
// Synthetic fixtures — one valid payload per registered operation.
// Opaque Firestore-shaped IDs, synthetic amounts.
// ---------------------------------------------------------------------------

function makeTransaction(): Record<string, unknown> {
  return {
    __typename: 'Transaction',
    id: 'AbC123dEf456GhI789jK',
    name: 'Synthetic Coffee Shop',
    date: '2026-06-01',
    amount: 4.5,
    categoryId: 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d',
    type: 'REGULAR',
    accountId: 'XyZ987wVu654TsR321qP',
    itemId: 'MnO456pQr789StU012vW',
    isPending: false,
    isReviewed: true,
    createdAt: 1_750_000_000,
    recurringId: null,
    userNotes: null,
    tipAmount: null,
    suggestedCategoryIds: [],
    tags: [{ __typename: 'Tag', id: 'tAg111BbB222CcC333Dd', name: 'synthetic', colorName: 'blue' }],
    goal: null,
  };
}

const VALID_RESPONSES: Record<string, unknown> = {
  CreateTransaction: { createTransaction: makeTransaction() },
  EditTransaction: {
    editTransaction: {
      __typename: 'EditTransactionOutput',
      transaction: makeTransaction(),
    },
  },
  DeleteTransaction: { deleteTransaction: true },
  AddTransactionToRecurring: {
    addTransactionToRecurring: { transaction: makeTransaction() },
  },
  SplitTransaction: {
    splitTransaction: {
      parentTransaction: makeTransaction(),
      splitTransactions: [makeTransaction(), makeTransaction()],
    },
  },
  CreateTag: {
    createTag: { __typename: 'Tag', id: 'tAg111BbB222CcC333Dd', name: 'trip', colorName: 'green' },
  },
  EditTag: { editTag: { id: 'tAg111BbB222CcC333Dd', name: 'trip', colorName: 'red' } },
  DeleteTag: { deleteTag: true },
  CreateCategory: {
    createCategory: {
      id: 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d',
      name: 'Synthetic Category',
      colorName: 'orange',
    },
  },
  EditCategory: {
    editCategory: {
      category: {
        id: 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d',
        name: 'Synthetic Category',
        colorName: 'purple',
      },
    },
  },
  DeleteCategory: { deleteCategory: true },
  EditBudget: { editCategoryBudget: true },
  EditBudgetMonthly: { editCategoryBudgetMonthly: true },
  CreateRecurring: {
    createRecurring: {
      id: 'rEc555FfF666GgG777Hh',
      name: 'Synthetic Streaming',
      state: 'ACTIVE',
      frequency: 'MONTHLY',
    },
  },
  EditRecurring: {
    editRecurring: {
      recurring: {
        id: 'rEc555FfF666GgG777Hh',
        name: 'Synthetic Streaming',
        categoryId: 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d',
        frequency: 'MONTHLY',
        state: 'PAUSED',
      },
    },
  },
  DeleteRecurring: { deleteRecurring: true },
  EditAccount: {
    editAccount: {
      account: { id: 'XyZ987wVu654TsR321qP', name: 'Synthetic Checking', isUserHidden: false },
    },
  },
};

describe('validateMutationResponse', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    __resetResponseDriftState();
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('every registered operation has a valid fixture that passes silently', () => {
    const operations = Object.keys(MUTATION_RESPONSE_SCHEMAS);
    expect(operations.sort()).toEqual(Object.keys(VALID_RESPONSES).sort());
    for (const op of operations) {
      validateMutationResponse(op, VALID_RESPONSES[op]);
    }
    expect(warnSpy).not.toHaveBeenCalled();
    expect(getResponseDriftStats()).toEqual({});
  });

  test('unknown extra fields (new server fields) pass through without warning', () => {
    const tx = makeTransaction();
    tx.brandNewServerField = 'whatever';
    validateMutationResponse('CreateTransaction', {
      createTransaction: tx,
      anotherTopLevelExtra: 42,
    });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(getResponseDriftStats()).toEqual({});
  });

  test('a removed/renamed field warns once with a structured message and counts the drift', () => {
    const tx = makeTransaction();
    delete (tx as Record<string, unknown>).categoryId; // simulate server rename
    validateMutationResponse('CreateTransaction', { createTransaction: tx });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toContain('[copilot-money-mcp] response shape drift:');
    expect(message).toContain('operation=CreateTransaction');
    expect(message).toContain('surface=Mutation.createTransaction:response');
    expect(message).toContain('path=createTransaction.categoryId');
    expect(message).toContain('code=');
    expect(getResponseDriftStats()).toEqual({ 'Mutation.createTransaction:response': 1 });
  });

  test('dedupes the warning per (operation, path, code) but counts every drifted response', () => {
    const drifted = () => {
      const tx = makeTransaction();
      delete (tx as Record<string, unknown>).categoryId;
      return { createTransaction: tx };
    };
    validateMutationResponse('CreateTransaction', drifted());
    validateMutationResponse('CreateTransaction', drifted());
    validateMutationResponse('CreateTransaction', drifted());

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(getResponseDriftStats()).toEqual({ 'Mutation.createTransaction:response': 3 });
  });

  test('multi-field drift in one response warns per field (each deduped), counted once', () => {
    const drifted = () => {
      const tx = makeTransaction();
      delete (tx as Record<string, unknown>).categoryId;
      delete (tx as Record<string, unknown>).date;
      return { createTransaction: tx };
    };
    validateMutationResponse('CreateTransaction', drifted());
    expect(warnSpy).toHaveBeenCalledTimes(2); // both missing fields named
    const messages = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(messages).toContain('path=createTransaction.categoryId');
    expect(messages).toContain('path=createTransaction.date');
    expect(getResponseDriftStats()).toEqual({ 'Mutation.createTransaction:response': 1 });

    validateMutationResponse('CreateTransaction', drifted());
    expect(warnSpy).toHaveBeenCalledTimes(2); // repeats stay silent
    expect(getResponseDriftStats()).toEqual({ 'Mutation.createTransaction:response': 2 });
  });

  test('a different drift path on the same operation warns again', () => {
    const missingCategory = makeTransaction();
    delete (missingCategory as Record<string, unknown>).categoryId;
    validateMutationResponse('CreateTransaction', { createTransaction: missingCategory });

    const retypedAmount = makeTransaction();
    retypedAmount.amount = '4.50'; // simulate Float → String type change
    validateMutationResponse('CreateTransaction', { createTransaction: retypedAmount });

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(getResponseDriftStats()).toEqual({ 'Mutation.createTransaction:response': 2 });
  });

  test('drift counters are tracked per surface', () => {
    validateMutationResponse('DeleteTag', { deleteTag: 'yes' }); // not a boolean
    validateMutationResponse('EditBudget', { editCategoryBudget: 1 }); // not a boolean
    validateMutationResponse('EditBudget', { editCategoryBudget: 1 });
    expect(getResponseDriftStats()).toEqual({
      'Mutation.deleteTag:response': 1,
      'Mutation.editCategoryBudget:response': 2,
    });
  });

  test('never throws on garbage payloads (warn-mode)', () => {
    expect(() => validateMutationResponse('CreateTransaction', null)).not.toThrow();
    expect(() => validateMutationResponse('CreateTransaction', 'not-an-object')).not.toThrow();
    expect(() =>
      validateMutationResponse('SplitTransaction', { splitTransaction: null })
    ).not.toThrow();
    expect(Object.keys(getResponseDriftStats()).length).toBeGreaterThan(0);
  });

  test('does not alter the payload', () => {
    const tx = makeTransaction();
    delete (tx as Record<string, unknown>).categoryId;
    const payload = { createTransaction: tx };
    const snapshot = structuredClone(payload);
    validateMutationResponse('CreateTransaction', payload);
    expect(payload).toEqual(snapshot);
  });

  test('an unregistered mutation operation warns once (and is not counted as drift)', () => {
    validateMutationResponse('SomeFutureMutation', { someFutureMutation: true });
    validateMutationResponse('SomeFutureMutation', { someFutureMutation: true });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toContain('operation=SomeFutureMutation');
    expect(message).toContain('no registered response schema');
    expect(getResponseDriftStats()).toEqual({});
  });

  describe('empty-string write-critical id drift (#526)', () => {
    // These three ids are write-critical: accountId/itemId feed the meta
    // index (routing for EditTransaction/CreateRecurring); id keys it. An
    // empty string is drift, symmetric with read-validation.ts's .min(1).
    for (const field of ['id', 'accountId', 'itemId'] as const) {
      test(`empty ${field} in a createTransaction response warns + counts`, () => {
        const tx = makeTransaction();
        tx[field] = '';
        validateMutationResponse('CreateTransaction', { createTransaction: tx });

        expect(getResponseDriftStats()).toEqual({
          'Mutation.createTransaction:response': 1,
        });
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const message = warnSpy.mock.calls[0][0] as string;
        expect(message).toContain('operation=CreateTransaction');
        expect(message).toContain(`path=createTransaction.${field}`);
        expect(message).toContain('code=too_small');
      });
    }

    test('empty itemId inside a splitTransaction child warns + counts', () => {
      const parent = makeTransaction();
      const child = makeTransaction();
      child.itemId = '';
      validateMutationResponse('SplitTransaction', {
        splitTransaction: { parentTransaction: parent, splitTransactions: [child] },
      });
      expect(getResponseDriftStats()).toEqual({
        'Mutation.splitTransaction:response': 1,
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    test('non-empty ids still pass clean (no false positives)', () => {
      validateMutationResponse('CreateTransaction', VALID_RESPONSES.CreateTransaction);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(getResponseDriftStats()).toEqual({});
    });
  });
});
