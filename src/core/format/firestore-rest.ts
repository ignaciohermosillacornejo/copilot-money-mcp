/**
 * Firestore REST API value encoding/decoding.
 *
 * Converts between TypeScript values and the Firestore REST API's
 * typed-value envelope format (e.g., { stringValue: "hello" }).
 *
 * @see https://firebase.google.com/docs/firestore/reference/rest/v1/Value
 */

/** Firestore REST API value types. */
export type FirestoreRestValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { timestampValue: string }
  | { arrayValue: { values: FirestoreRestValue[] } }
  | { mapValue: { fields: Record<string, FirestoreRestValue> } };

/** A set of Firestore document fields. */
export type FirestoreFields = Record<string, FirestoreRestValue>;

/**
 * Convert a TypeScript value to Firestore REST API format.
 */
export function toFirestoreValue(value: unknown): FirestoreRestValue {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFirestoreValue) } };
  }
  if (typeof value === 'object') {
    return { mapValue: { fields: toFirestoreFields(value as Record<string, unknown>) } };
  }
  throw new Error(`Unsupported value type: ${typeof value}`);
}

/**
 * Decode a Firestore REST API value back to a TypeScript value.
 */
export function fromFirestoreValue(val: FirestoreRestValue): unknown {
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return val.doubleValue;
  if ('booleanValue' in val) return val.booleanValue;
  if ('nullValue' in val) return null;
  if ('timestampValue' in val) return val.timestampValue;
  if ('arrayValue' in val) return val.arrayValue.values.map(fromFirestoreValue);
  if ('mapValue' in val) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val.mapValue.fields)) {
      result[k] = fromFirestoreValue(v);
    }
    return result;
  }
  throw new Error(`Unknown Firestore value type: ${JSON.stringify(val)}`);
}

/**
 * Convert Firestore REST document fields back to a plain TypeScript object.
 */
export function fromFirestoreFields(fields: FirestoreFields): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = fromFirestoreValue(value);
  }
  return result;
}

/**
 * Convert a flat TypeScript object to Firestore REST document fields.
 * Skips undefined values.
 */
export function toFirestoreFields(obj: Record<string, unknown>): FirestoreFields {
  const fields: FirestoreFields = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      fields[key] = toFirestoreValue(value);
    }
  }
  return fields;
}
