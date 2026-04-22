import { describe, test, expect } from 'bun:test';
import { createWriteToolSchemas } from '../../src/tools/index.js';

describe('createWriteToolSchemas', () => {
  test('returns exactly 14 write tool schemas', () => {
    // Exact count: if a write tool is added or removed, this assertion
    // forces an explicit update, and the server-protocol.test.ts
    // annotation + rejection tables must be extended in lockstep.
    // Post-GraphQL migration: goals and createBudget/updateBudget/deleteBudget
    // tools were removed; set_budget replaces the three budget tools.
    // 2026-04: create_transaction added (14 total).
    expect(createWriteToolSchemas().length).toBe(14);
  });

  test('create_transaction has required shape and annotations', () => {
    const createTxn = createWriteToolSchemas().find((s) => s.name === 'create_transaction');
    expect(createTxn).toBeDefined();
    expect(createTxn!.annotations?.readOnlyHint).toBe(false);
    expect(createTxn!.annotations?.destructiveHint).toBe(false);
    expect(createTxn!.annotations?.idempotentHint).toBe(false);
    expect(createTxn!.inputSchema.additionalProperties).toBe(false);
    expect(createTxn!.inputSchema.required).toEqual([
      'account_id',
      'item_id',
      'name',
      'date',
      'amount',
      'category_id',
      'type',
    ]);
    expect(createTxn!.inputSchema.properties.type.enum).toEqual([
      'REGULAR',
      'INCOME',
      'INTERNAL_TRANSFER',
    ]);
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
