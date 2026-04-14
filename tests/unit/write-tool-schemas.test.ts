import { describe, test, expect } from 'bun:test';
import { createWriteToolSchemas } from '../../src/tools/index.js';

describe('createWriteToolSchemas', () => {
  test('returns all write tool schemas with required annotations', () => {
    const schemas = createWriteToolSchemas();
    expect(schemas.length).toBeGreaterThanOrEqual(17);

    const updateTxn = schemas.find((s) => s.name === 'update_transaction');
    expect(updateTxn).toBeDefined();
    expect(updateTxn!.annotations?.readOnlyHint).toBe(false);
    expect(updateTxn!.annotations?.idempotentHint).toBe(true);
    expect(updateTxn!.inputSchema.required).toEqual(['transaction_id']);
    expect(updateTxn!.inputSchema.additionalProperties).toBe(false);
  });

  test('create_tag schema requires name and exposes color fields', () => {
    const createTag = createWriteToolSchemas().find((s) => s.name === 'create_tag');
    expect(createTag).toBeDefined();
    expect(createTag!.inputSchema.required).toEqual(['name']);
    expect(createTag!.inputSchema.properties).toHaveProperty('name');
    expect(createTag!.inputSchema.properties).toHaveProperty('color_name');
    expect(createTag!.inputSchema.properties).toHaveProperty('hex_color');
  });

  test('delete_tag schema requires tag_id', () => {
    const deleteTag = createWriteToolSchemas().find((s) => s.name === 'delete_tag');
    expect(deleteTag).toBeDefined();
    expect(deleteTag!.inputSchema.required).toEqual(['tag_id']);
    expect(deleteTag!.inputSchema.properties).toHaveProperty('tag_id');
  });

  test('create_category schema requires name and is non-idempotent', () => {
    const createCat = createWriteToolSchemas().find((s) => s.name === 'create_category');
    expect(createCat).toBeDefined();
    expect(createCat!.annotations?.readOnlyHint).toBe(false);
    expect(createCat!.annotations?.idempotentHint).toBe(false);
    expect(createCat!.inputSchema.required).toEqual(['name']);
  });
});
