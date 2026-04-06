import { describe, test, expect } from 'bun:test';
import {
  toFirestoreValue,
  fromFirestoreValue,
  toFirestoreFields,
  type FirestoreRestValue,
} from '../../../src/core/format/firestore-rest.js';

describe('toFirestoreValue', () => {
  test('encodes string', () => {
    expect(toFirestoreValue('hello')).toEqual({ stringValue: 'hello' });
  });

  test('encodes integer number', () => {
    expect(toFirestoreValue(42)).toEqual({ integerValue: '42' });
  });

  test('encodes float number', () => {
    expect(toFirestoreValue(3.14)).toEqual({ doubleValue: 3.14 });
  });

  test('encodes boolean', () => {
    expect(toFirestoreValue(true)).toEqual({ booleanValue: true });
    expect(toFirestoreValue(false)).toEqual({ booleanValue: false });
  });

  test('encodes null', () => {
    expect(toFirestoreValue(null)).toEqual({ nullValue: null });
  });

  test('encodes string array', () => {
    expect(toFirestoreValue(['a', 'b'])).toEqual({
      arrayValue: {
        values: [{ stringValue: 'a' }, { stringValue: 'b' }],
      },
    });
  });

  test('encodes empty array', () => {
    expect(toFirestoreValue([])).toEqual({
      arrayValue: { values: [] },
    });
  });

  test('encodes nested map', () => {
    expect(toFirestoreValue({ key: 'val' })).toEqual({
      mapValue: {
        fields: { key: { stringValue: 'val' } },
      },
    });
  });
});

describe('fromFirestoreValue', () => {
  test('decodes string', () => {
    expect(fromFirestoreValue({ stringValue: 'hello' })).toBe('hello');
  });

  test('decodes integerValue', () => {
    expect(fromFirestoreValue({ integerValue: '42' })).toBe(42);
  });

  test('decodes doubleValue', () => {
    expect(fromFirestoreValue({ doubleValue: 3.14 })).toBe(3.14);
  });

  test('decodes boolean', () => {
    expect(fromFirestoreValue({ booleanValue: true })).toBe(true);
  });

  test('decodes null', () => {
    expect(fromFirestoreValue({ nullValue: null })).toBeNull();
  });

  test('decodes array', () => {
    const val: FirestoreRestValue = {
      arrayValue: { values: [{ stringValue: 'a' }, { integerValue: '1' }] },
    };
    expect(fromFirestoreValue(val)).toEqual(['a', 1]);
  });

  test('decodes map', () => {
    const val: FirestoreRestValue = {
      mapValue: { fields: { name: { stringValue: 'test' } } },
    };
    expect(fromFirestoreValue(val)).toEqual({ name: 'test' });
  });
});

describe('toFirestoreFields', () => {
  test('converts flat object to Firestore fields', () => {
    const result = toFirestoreFields({ category_id: 'food', amount: 42.5 });
    expect(result).toEqual({
      category_id: { stringValue: 'food' },
      amount: { doubleValue: 42.5 },
    });
  });

  test('skips undefined values', () => {
    const result = toFirestoreFields({ a: 'yes', b: undefined });
    expect(result).toEqual({ a: { stringValue: 'yes' } });
  });
});
