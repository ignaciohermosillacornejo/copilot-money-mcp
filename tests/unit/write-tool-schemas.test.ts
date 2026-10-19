import { describe, test, expect } from 'bun:test';
import { createWriteToolSchemas } from '../../src/tools/index.js';

describe('createWriteToolSchemas', () => {
  test('returns exactly 19 write tool schemas', () => {
    // Exact count: if a write tool is added or removed, this assertion
    // forces an explicit update, and the server-protocol.test.ts
    // annotation + rejection tables must be extended in lockstep.
    // Post-GraphQL migration: goals and createBudget/updateBudget/deleteBudget
    // tools were removed; set_budget replaces the three budget tools.
    // 2026-04: create_transaction added (14 total).
    // 2026-04: delete_transaction added (15 total).
    // 2026-04: add_transaction_to_recurring added (16 total).
    // 2026-04: split_transaction added (17 total).
    // 2026-08: bulk_edit_transactions added (18 total).
    // 2026-08: update_transactions (per-row bulk fan-out) added (19 total).
    expect(createWriteToolSchemas().length).toBe(19);
  });

  test('split_transaction has required shape and annotations', () => {
    const split = createWriteToolSchemas().find((s) => s.name === 'split_transaction');
    expect(split).toBeDefined();
    expect(split!.annotations?.readOnlyHint).toBe(false);
    // Destructive: the parent is permanently hidden post-split and there is
    // no reversal mutation. "Undo" requires per-child delete + parent edit.
    expect(split!.annotations?.destructiveHint).toBe(true);
    // Not idempotent: replaying a split would fail (the parent is already
    // hidden and its children already exist) but the intent-semantics of
    // a retry differ from, say, setting a flag.
    expect(split!.annotations?.idempotentHint).toBe(false);
    expect(split!.inputSchema.additionalProperties).toBe(false);
    expect(split!.inputSchema.required).toEqual([
      'transaction_id',
      'account_id',
      'item_id',
      'splits',
    ]);
    expect(split!.inputSchema.properties.splits.type).toBe('array');
    // minItems:2 — a split-into-one is meaningless; caller should use update_transaction.
    expect(split!.inputSchema.properties.splits.minItems).toBe(2);
    const itemSchema = split!.inputSchema.properties.splits.items as {
      type: string;
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(itemSchema.type).toBe('object');
    expect(itemSchema.additionalProperties).toBe(false);
    // Only amount + category_id are required per-entry — name/date default
    // to parent values when omitted.
    expect(itemSchema.required).toEqual(['amount', 'category_id']);
    expect(itemSchema.properties).toHaveProperty('name');
    expect(itemSchema.properties).toHaveProperty('date');
    expect(itemSchema.properties).toHaveProperty('amount');
    expect(itemSchema.properties).toHaveProperty('category_id');
    // Must not advertise tags/notes/reviewed — the server's
    // SplitTransactionInput rejects all three ("not defined by type").
    expect(itemSchema.properties).not.toHaveProperty('tag_ids');
    expect(itemSchema.properties).not.toHaveProperty('note');
    expect(itemSchema.properties).not.toHaveProperty('is_reviewed');
  });

  test('create_transaction has required shape and annotations', () => {
    const createTxn = createWriteToolSchemas().find((s) => s.name === 'create_transaction');
    expect(createTxn).toBeDefined();
    expect(createTxn!.annotations?.readOnlyHint).toBe(false);
    expect(createTxn!.annotations?.destructiveHint).toBe(false);
    expect(createTxn!.annotations?.idempotentHint).toBe(false);
    expect(createTxn!.inputSchema.additionalProperties).toBe(false);
    // category_id is conditional (#825): required for REGULAR, refused for
    // INCOME/INTERNAL_TRANSFER — enforced at runtime, so not schema-required.
    expect(createTxn!.inputSchema.required).toEqual([
      'account_id',
      'item_id',
      'name',
      'date',
      'amount',
      'type',
    ]);
    expect(createTxn!.inputSchema.properties.type.enum).toEqual([
      'REGULAR',
      'INCOME',
      'INTERNAL_TRANSFER',
    ]);
  });

  test('delete_transaction has required shape and annotations', () => {
    const deleteTxn = createWriteToolSchemas().find((s) => s.name === 'delete_transaction');
    expect(deleteTxn).toBeDefined();
    expect(deleteTxn!.annotations?.readOnlyHint).toBe(false);
    expect(deleteTxn!.annotations?.destructiveHint).toBe(true);
    expect(deleteTxn!.annotations?.idempotentHint).toBe(true);
    expect(deleteTxn!.inputSchema.additionalProperties).toBe(false);
    // All three IDs required — no lookup fallback, so the caller must be
    // explicit and a typo can only match "Transaction not found" at the
    // server rather than silently resolving to a different tx.
    expect(deleteTxn!.inputSchema.required).toEqual(['transaction_id', 'account_id', 'item_id']);
    expect(deleteTxn!.inputSchema.properties).toHaveProperty('transaction_id');
    expect(deleteTxn!.inputSchema.properties).toHaveProperty('account_id');
    expect(deleteTxn!.inputSchema.properties).toHaveProperty('item_id');
    // Description must warn about destructive + Plaid re-sync metadata loss.
    expect(deleteTxn!.description).toMatch(/DESTRUCTIVE/);
    expect(deleteTxn!.description).toMatch(/no.*undo|no.*soft-delete/i);
  });

  // Two bulk-edit tools now coexist and do genuinely different things:
  // update_transactions fans out per-row heterogeneous edits over
  // editTransaction (all 8 fields); bulk_edit_transactions issues ONE native
  // request applying ONE edit to many rows (5 fields, tags add/remove only).
  // An agent has to pick correctly, and the only thing steering it is these
  // description strings — so pin the cross-references and the one hazard that
  // silently destroys data if the wrong tool is chosen.
  test('the two bulk-edit tools cross-reference each other and warn about tag semantics', () => {
    const schemas = createWriteToolSchemas();
    const plural = schemas.find((s) => s.name === 'update_transactions');
    const bulk = schemas.find((s) => s.name === 'bulk_edit_transactions');
    expect(plural).toBeDefined();
    expect(bulk).toBeDefined();

    // Each must name the other, or an agent never learns the alternative exists.
    expect(plural!.description).toMatch(/bulk_edit_transactions/);
    expect(bulk!.description).toMatch(/update_transactions/);

    // The data-loss hazard: update_transactions.tag_ids REPLACES a row's tag
    // list, so using it to "add a trip tag" silently drops existing tags.
    // bulk_edit_transactions.add_tag_ids is additive. If this warning is ever
    // dropped, the wrong-tool choice becomes silent data loss.
    expect(plural!.description).toMatch(/REPLACES/);
    expect(plural!.description).toMatch(/add_tag_ids/);

    // The other half of the split: four fields have no bulk form at all.
    // Anchored on the STEERING sentence, not on any mention of those field
    // names — the description also enumerates them as accepted fields
    // ("transaction_id plus any of name, category_id, note, ..."), so a loose
    // regex matches that enumeration and detects nothing.
    expect(plural!.description).toMatch(/Copilot cannot bulk-edit/);
  });

  test('add_transaction_to_recurring has required shape and annotations', () => {
    const atr = createWriteToolSchemas().find((s) => s.name === 'add_transaction_to_recurring');
    expect(atr).toBeDefined();
    expect(atr!.annotations?.readOnlyHint).toBe(false);
    expect(atr!.annotations?.destructiveHint).toBe(false);
    expect(atr!.annotations?.idempotentHint).toBe(true);
    expect(atr!.inputSchema.additionalProperties).toBe(false);
    // All four IDs required — same defensive "no cache lookup" contract as
    // delete_transaction; a typo must fail at the server boundary rather
    // than silently attach a different transaction.
    expect(atr!.inputSchema.required).toEqual([
      'transaction_id',
      'account_id',
      'item_id',
      'recurring_id',
    ]);
    expect(atr!.inputSchema.properties).toHaveProperty('transaction_id');
    expect(atr!.inputSchema.properties).toHaveProperty('account_id');
    expect(atr!.inputSchema.properties).toHaveProperty('item_id');
    expect(atr!.inputSchema.properties).toHaveProperty('recurring_id');
  });

  test('update_transaction has required shape and annotations', () => {
    const updateTxn = createWriteToolSchemas().find((s) => s.name === 'update_transaction');
    expect(updateTxn).toBeDefined();
    expect(updateTxn!.annotations?.readOnlyHint).toBe(false);
    expect(updateTxn!.annotations?.idempotentHint).toBe(true);
    expect(updateTxn!.inputSchema.required).toEqual(['transaction_id']);
    expect(updateTxn!.inputSchema.additionalProperties).toBe(false);
  });

  test('create_tag schema requires name and exposes color_name only (no hex_color)', () => {
    // The implementation only reads color_name — hex_color was previously
    // advertised in the schema but silently ignored by createTag, so it was
    // removed during the 2.0.1 tool-description audit.
    const createTag = createWriteToolSchemas().find((s) => s.name === 'create_tag');
    expect(createTag).toBeDefined();
    expect(createTag!.inputSchema.required).toEqual(['name']);
    expect(createTag!.inputSchema.properties).toHaveProperty('name');
    expect(createTag!.inputSchema.properties).toHaveProperty('color_name');
    expect(createTag!.inputSchema.properties).not.toHaveProperty('hex_color');
  });

  test('delete_tag schema requires tag_id', () => {
    const deleteTag = createWriteToolSchemas().find((s) => s.name === 'delete_tag');
    expect(deleteTag).toBeDefined();
    expect(deleteTag!.inputSchema.required).toEqual(['tag_id']);
    expect(deleteTag!.inputSchema.properties).toHaveProperty('tag_id');
  });

  test('update_tag schema exposes color_name only (no hex_color)', () => {
    // Symmetric guard with create_tag — updateTag also only reads color_name,
    // and a schema edit could silently re-add hex_color without this assertion.
    const updateTag = createWriteToolSchemas().find((s) => s.name === 'update_tag');
    expect(updateTag).toBeDefined();
    expect(updateTag!.inputSchema.required).toEqual(['tag_id']);
    expect(updateTag!.inputSchema.properties).toHaveProperty('color_name');
    expect(updateTag!.inputSchema.properties).not.toHaveProperty('hex_color');
  });

  test('create_category schema requires name and is non-idempotent', () => {
    const createCat = createWriteToolSchemas().find((s) => s.name === 'create_category');
    expect(createCat).toBeDefined();
    expect(createCat!.annotations?.readOnlyHint).toBe(false);
    expect(createCat!.annotations?.idempotentHint).toBe(false);
    expect(createCat!.inputSchema.required).toEqual(['name', 'color_name', 'emoji']);
  });
});
