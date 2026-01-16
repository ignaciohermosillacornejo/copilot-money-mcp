/**
 * Protocol Buffers wire format parser for Firestore documents.
 *
 * This module provides sequential parsing of protobuf-encoded data from byte 0 to end,
 * eliminating the need for brittle window-based pattern matching.
 *
 * Wire format reference: https://protobuf.dev/programming-guides/encoding/
 * Firestore Value proto: https://github.com/googleapis/googleapis/blob/master/google/firestore/v1/document.proto
 */

/* eslint-disable @typescript-eslint/no-unsafe-enum-comparison */
/* eslint-disable @typescript-eslint/restrict-template-expressions */

/**
 * Wire types in Protocol Buffers encoding.
 */
export const enum WireType {
  Varint = 0, // int32, int64, uint32, uint64, sint32, sint64, bool, enum
  Fixed64 = 1, // fixed64, sfixed64, double
  LengthDelimited = 2, // string, bytes, embedded messages, packed repeated fields
  StartGroup = 3, // deprecated
  EndGroup = 4, // deprecated
  Fixed32 = 5, // fixed32, sfixed32, float
}

/**
 * Firestore Value field numbers (from google/firestore/v1/document.proto).
 */
export const enum FirestoreValueField {
  BooleanValue = 1,
  IntegerValue = 2,
  DoubleValue = 3,
  // 4 is reserved
  ReferenceValue = 5,
  MapValue = 6,
  // 7 is reserved
  GeoPointValue = 8,
  ArrayValue = 9,
  TimestampValue = 10,
  NullValue = 11,
  // 12-16 reserved
  StringValue = 17,
  BytesValue = 18,
}

/**
 * Firestore MapValue.fields is field 1.
 * Firestore ArrayValue.values is field 1.
 */
const MAP_FIELDS_FIELD = 1;
const ARRAY_VALUES_FIELD = 1;

/**
 * Map entry structure: field 1 = key (string), field 2 = value (Value message).
 */
const MAP_ENTRY_KEY_FIELD = 1;
const MAP_ENTRY_VALUE_FIELD = 2;

/**
 * Represents a parsed Firestore value.
 */
export type FirestoreValue =
  | { type: 'string'; value: string }
  | { type: 'double'; value: number }
  | { type: 'integer'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'null'; value: null }
  | { type: 'timestamp'; value: { seconds: number; nanos: number } }
  | { type: 'geopoint'; value: { latitude: number; longitude: number } }
  | { type: 'reference'; value: string }
  | { type: 'bytes'; value: Buffer }
  | { type: 'map'; value: Map<string, FirestoreValue> }
  | { type: 'array'; value: FirestoreValue[] };

/**
 * Result of decoding a varint.
 */
interface VarintResult {
  value: number;
  bytesRead: number;
}

/**
 * Decode a varint from a buffer at the given position.
 *
 * Varints encode integers using 7 bits per byte, with the MSB indicating
 * whether more bytes follow. This handles up to 64-bit integers correctly
 * using BigInt to avoid JavaScript's 32-bit bitwise operation limitation.
 *
 * @param data - The buffer to read from
 * @param pos - Starting position in the buffer
 * @returns The decoded value and number of bytes consumed
 * @throws Error if the varint is malformed or truncated
 */
export function decodeVarint(data: Buffer, pos: number): VarintResult {
  let result = 0n; // Use BigInt for 64-bit precision
  let shift = 0n;
  let bytesRead = 0;

  while (pos + bytesRead < data.length) {
    const byte = data[pos + bytesRead];
    if (byte === undefined) {
      throw new Error(`Truncated varint at position ${pos + bytesRead}`);
    }

    // Add the lower 7 bits to our result using BigInt
    result |= BigInt(byte & 0x7f) << shift;
    bytesRead++;

    // If MSB is 0, this is the last byte
    if ((byte & 0x80) === 0) {
      // Convert BigInt to signed 64-bit number
      // If the high bit is set, it's a negative number in two's complement
      const maxInt64 = (1n << 63n) - 1n;
      if (result > maxInt64) {
        // Negative number: convert from unsigned to signed
        result = result - (1n << 64n);
      }
      return { value: Number(result), bytesRead };
    }

    shift += 7n;

    // Prevent overflow (varints can be at most 10 bytes for 64-bit values)
    if (shift >= 64n) {
      throw new Error(`Varint too long at position ${pos}`);
    }
  }

  throw new Error(`Truncated varint at position ${pos}`);
}

/**
 * Decode a signed varint (zigzag encoding).
 * Used for sint32, sint64 fields.
 */
export function decodeSignedVarint(data: Buffer, pos: number): VarintResult {
  const { value, bytesRead } = decodeVarint(data, pos);
  // Zigzag decode: (n >>> 1) ^ -(n & 1)
  const decoded = (value >>> 1) ^ -(value & 1);
  return { value: decoded, bytesRead };
}

/**
 * Encode a value as a varint.
 * Useful for creating test data.
 * Handles both positive and negative numbers using 64-bit signed representation.
 */
export function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];

  // Convert to BigInt for 64-bit precision
  // Negative numbers are converted to their two's complement representation
  let v = BigInt(value);
  if (v < 0n) {
    // Convert to unsigned 64-bit two's complement
    v = v + (1n << 64n);
  }

  // Encode as varint (up to 10 bytes for 64-bit values)
  while (v > 0x7fn) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));

  return Buffer.from(bytes);
}

/**
 * Parse a protobuf tag to extract field number and wire type.
 */
export function parseTag(tag: number): { fieldNumber: number; wireType: WireType } {
  return {
    fieldNumber: tag >>> 3,
    wireType: (tag & 0x07) as WireType,
  };
}

/**
 * Create a protobuf tag from field number and wire type.
 */
export function createTag(fieldNumber: number, wireType: WireType): number {
  return (fieldNumber << 3) | wireType;
}

/**
 * Skip a field value based on its wire type.
 * Returns the number of bytes to skip.
 */
export function skipField(data: Buffer, pos: number, wireType: WireType): number {
  switch (wireType) {
    case WireType.Varint: {
      const { bytesRead } = decodeVarint(data, pos);
      return bytesRead;
    }
    case WireType.Fixed64:
      return 8;
    case WireType.LengthDelimited: {
      const { value: length, bytesRead } = decodeVarint(data, pos);
      return bytesRead + length;
    }
    case WireType.Fixed32:
      return 4;
    case WireType.StartGroup:
    case WireType.EndGroup:
      throw new Error(`Deprecated wire type ${wireType} not supported`);
    default:
      throw new Error(`Unknown wire type ${wireType}`);
  }
}

/**
 * Parse a Firestore Value message from protobuf bytes.
 *
 * This handles the oneof value_type in Firestore's Value proto.
 */
export function parseFirestoreValue(data: Buffer, start: number = 0, end?: number): FirestoreValue {
  const dataEnd = end ?? data.length;
  let pos = start;

  // A Value message contains exactly one field (the oneof value_type)
  while (pos < dataEnd) {
    const tagResult = decodeVarint(data, pos);
    pos += tagResult.bytesRead;

    const { fieldNumber, wireType } = parseTag(tagResult.value);

    switch (fieldNumber) {
      case FirestoreValueField.BooleanValue: {
        if (wireType !== WireType.Varint) {
          throw new Error(`Expected varint for boolean, got wire type ${wireType}`);
        }
        const { value, bytesRead } = decodeVarint(data, pos);
        pos += bytesRead;
        return { type: 'boolean', value: value !== 0 };
      }

      case FirestoreValueField.IntegerValue: {
        if (wireType !== WireType.Varint) {
          throw new Error(`Expected varint for integer, got wire type ${wireType}`);
        }
        const { value, bytesRead } = decodeVarint(data, pos);
        pos += bytesRead;
        return { type: 'integer', value };
      }

      case FirestoreValueField.DoubleValue: {
        if (wireType !== WireType.Fixed64) {
          throw new Error(`Expected fixed64 for double, got wire type ${wireType}`);
        }
        const value = data.readDoubleLE(pos);
        pos += 8;
        return { type: 'double', value };
      }

      case FirestoreValueField.ReferenceValue: {
        if (wireType !== WireType.LengthDelimited) {
          throw new Error(`Expected length-delimited for reference, got wire type ${wireType}`);
        }
        const { value: length, bytesRead } = decodeVarint(data, pos);
        pos += bytesRead;
        const value = data.subarray(pos, pos + length).toString('utf-8');
        pos += length;
        return { type: 'reference', value };
      }

      case FirestoreValueField.StringValue: {
        if (wireType !== WireType.LengthDelimited) {
          throw new Error(`Expected length-delimited for string, got wire type ${wireType}`);
        }
        const { value: length, bytesRead } = decodeVarint(data, pos);
        pos += bytesRead;
        const value = data.subarray(pos, pos + length).toString('utf-8');
        pos += length;
        return { type: 'string', value };
      }

      case FirestoreValueField.BytesValue: {
        if (wireType !== WireType.LengthDelimited) {
          throw new Error(`Expected length-delimited for bytes, got wire type ${wireType}`);
        }
        const { value: length, bytesRead } = decodeVarint(data, pos);
        pos += bytesRead;
        const value = Buffer.from(data.subarray(pos, pos + length));
        pos += length;
        return { type: 'bytes', value };
      }

      case FirestoreValueField.NullValue: {
        if (wireType !== WireType.Varint) {
          throw new Error(`Expected varint for null, got wire type ${wireType}`);
        }
        const { bytesRead } = decodeVarint(data, pos);
        pos += bytesRead;
        return { type: 'null', value: null };
      }

      case FirestoreValueField.TimestampValue: {
        if (wireType !== WireType.LengthDelimited) {
          throw new Error(`Expected length-delimited for timestamp, got wire type ${wireType}`);
        }
        const { value: length, bytesRead } = decodeVarint(data, pos);
        pos += bytesRead;
        const timestamp = parseTimestamp(data, pos, pos + length);
        pos += length;
        return { type: 'timestamp', value: timestamp };
      }

      case FirestoreValueField.GeoPointValue: {
        if (wireType !== WireType.LengthDelimited) {
          throw new Error(`Expected length-delimited for geopoint, got wire type ${wireType}`);
        }
        const { value: length, bytesRead } = decodeVarint(data, pos);
        pos += bytesRead;
        const geopoint = parseGeoPoint(data, pos, pos + length);
        pos += length;
        return { type: 'geopoint', value: geopoint };
      }

      case FirestoreValueField.MapValue: {
        if (wireType !== WireType.LengthDelimited) {
          throw new Error(`Expected length-delimited for map, got wire type ${wireType}`);
        }
        const { value: length, bytesRead } = decodeVarint(data, pos);
        pos += bytesRead;
        const map = parseMapValue(data, pos, pos + length);
        pos += length;
        return { type: 'map', value: map };
      }

      case FirestoreValueField.ArrayValue: {
        if (wireType !== WireType.LengthDelimited) {
          throw new Error(`Expected length-delimited for array, got wire type ${wireType}`);
        }
        const { value: length, bytesRead } = decodeVarint(data, pos);
        pos += bytesRead;
        const array = parseArrayValue(data, pos, pos + length);
        pos += length;
        return { type: 'array', value: array };
      }

      default: {
        // Unknown field - skip it
        const skipped = skipField(data, pos, wireType);
        pos += skipped;
      }
    }
  }

  // If we get here without finding a value, return null
  return { type: 'null', value: null };
}

/**
 * Parse a Timestamp message (seconds: int64, nanos: int32).
 */
function parseTimestamp(
  data: Buffer,
  start: number,
  end: number
): { seconds: number; nanos: number } {
  let pos = start;
  let seconds = 0;
  let nanos = 0;

  while (pos < end) {
    const tagResult = decodeVarint(data, pos);
    pos += tagResult.bytesRead;

    const { fieldNumber, wireType } = parseTag(tagResult.value);

    if (fieldNumber === 1 && wireType === WireType.Varint) {
      // seconds field
      const { value, bytesRead } = decodeVarint(data, pos);
      pos += bytesRead;
      seconds = value;
    } else if (fieldNumber === 2 && wireType === WireType.Varint) {
      // nanos field
      const { value, bytesRead } = decodeVarint(data, pos);
      pos += bytesRead;
      nanos = value;
    } else {
      // Skip unknown fields
      const skipped = skipField(data, pos, wireType);
      pos += skipped;
    }
  }

  return { seconds, nanos };
}

/**
 * Parse a LatLng message (latitude: double, longitude: double).
 */
function parseGeoPoint(
  data: Buffer,
  start: number,
  end: number
): { latitude: number; longitude: number } {
  let pos = start;
  let latitude = 0;
  let longitude = 0;

  while (pos < end) {
    const tagResult = decodeVarint(data, pos);
    pos += tagResult.bytesRead;

    const { fieldNumber, wireType } = parseTag(tagResult.value);

    if (fieldNumber === 1 && wireType === WireType.Fixed64) {
      // latitude field
      latitude = data.readDoubleLE(pos);
      pos += 8;
    } else if (fieldNumber === 2 && wireType === WireType.Fixed64) {
      // longitude field
      longitude = data.readDoubleLE(pos);
      pos += 8;
    } else {
      // Skip unknown fields
      const skipped = skipField(data, pos, wireType);
      pos += skipped;
    }
  }

  return { latitude, longitude };
}

/**
 * Parse a MapValue message.
 * MapValue has a single field: repeated MapValue.FieldsEntry fields = 1;
 * Each FieldsEntry has: string key = 1; Value value = 2;
 */
function parseMapValue(data: Buffer, start: number, end: number): Map<string, FirestoreValue> {
  const result = new Map<string, FirestoreValue>();
  let pos = start;

  while (pos < end) {
    const tagResult = decodeVarint(data, pos);
    pos += tagResult.bytesRead;

    const { fieldNumber, wireType } = parseTag(tagResult.value);

    if (fieldNumber === MAP_FIELDS_FIELD && wireType === WireType.LengthDelimited) {
      // This is a map entry
      const { value: entryLength, bytesRead } = decodeVarint(data, pos);
      pos += bytesRead;

      const entry = parseMapEntry(data, pos, pos + entryLength);
      if (entry.key !== null) {
        result.set(entry.key, entry.value);
      }

      pos += entryLength;
    } else {
      // Skip unknown fields
      const skipped = skipField(data, pos, wireType);
      pos += skipped;
    }
  }

  return result;
}

/**
 * Parse a single map entry (key-value pair).
 */
function parseMapEntry(
  data: Buffer,
  start: number,
  end: number
): { key: string | null; value: FirestoreValue } {
  let pos = start;
  let key: string | null = null;
  let value: FirestoreValue = { type: 'null', value: null };

  while (pos < end) {
    const tagResult = decodeVarint(data, pos);
    pos += tagResult.bytesRead;

    const { fieldNumber, wireType } = parseTag(tagResult.value);

    if (fieldNumber === MAP_ENTRY_KEY_FIELD && wireType === WireType.LengthDelimited) {
      // Key field (string)
      const { value: length, bytesRead } = decodeVarint(data, pos);
      pos += bytesRead;
      key = data.subarray(pos, pos + length).toString('utf-8');
      pos += length;
    } else if (fieldNumber === MAP_ENTRY_VALUE_FIELD && wireType === WireType.LengthDelimited) {
      // Value field (Value message)
      const { value: length, bytesRead } = decodeVarint(data, pos);
      pos += bytesRead;
      value = parseFirestoreValue(data, pos, pos + length);
      pos += length;
    } else {
      // Skip unknown fields
      const skipped = skipField(data, pos, wireType);
      pos += skipped;
    }
  }

  return { key, value };
}

/**
 * Parse an ArrayValue message.
 * ArrayValue has: repeated Value values = 1;
 */
function parseArrayValue(data: Buffer, start: number, end: number): FirestoreValue[] {
  const result: FirestoreValue[] = [];
  let pos = start;

  while (pos < end) {
    const tagResult = decodeVarint(data, pos);
    pos += tagResult.bytesRead;

    const { fieldNumber, wireType } = parseTag(tagResult.value);

    if (fieldNumber === ARRAY_VALUES_FIELD && wireType === WireType.LengthDelimited) {
      // This is an array element
      const { value: length, bytesRead } = decodeVarint(data, pos);
      pos += bytesRead;

      const element = parseFirestoreValue(data, pos, pos + length);
      result.push(element);

      pos += length;
    } else {
      // Skip unknown fields
      const skipped = skipField(data, pos, wireType);
      pos += skipped;
    }
  }

  return result;
}

/**
 * Parse the inner Document proto structure.
 * The document structure is:
 * - string name = 1 (document path)
 * - map<string, Value> fields = 2 (repeated map entries)
 * - Timestamp create_time = 3
 * - Timestamp update_time = 4
 *
 * Note: In Firestore's encoding, field 2 contains repeated map entries directly
 * (not wrapped in a MapValue). Each entry has: string key = 1; Value value = 2;
 */
function parseDocumentProto(data: Buffer, start: number, end: number): Map<string, FirestoreValue> {
  let pos = start;
  const result = new Map<string, FirestoreValue>();

  while (pos < end) {
    const tagResult = decodeVarint(data, pos);
    pos += tagResult.bytesRead;

    const { fieldNumber, wireType } = parseTag(tagResult.value);

    // Field 2 is a map entry (key-value pair) - repeated for each field
    if (fieldNumber === 2 && wireType === WireType.LengthDelimited) {
      const { value: length, bytesRead } = decodeVarint(data, pos);
      pos += bytesRead;

      // Parse this map entry directly
      const { key, value } = parseMapEntry(data, pos, pos + length);
      if (key !== null) {
        result.set(key, value);
      }

      pos += length;
    } else {
      // Skip other fields (name, create_time, update_time, etc.)
      const skipped = skipField(data, pos, wireType);
      pos += skipped;
    }
  }

  return result;
}

/**
 * Parse a complete Firestore document from LevelDB storage.
 *
 * The Firestore SDK stores documents in a MaybeDocument wrapper:
 * message MaybeDocument {
 *   oneof document_type {
 *     NoDocument no_document = 1;
 *     Document document = 2;
 *   }
 *   ...
 * }
 *
 * The Document proto contains:
 * - string name = 1 (document path)
 * - MapValue fields = 2 (the actual field data)
 * - Timestamp create_time = 3
 * - Timestamp update_time = 4
 *
 * @param data - The complete protobuf-encoded MaybeDocument
 * @returns A map of field names to their values
 */
export function parseFirestoreDocument(data: Buffer): Map<string, FirestoreValue> {
  let pos = 0;

  while (pos < data.length) {
    const tagResult = decodeVarint(data, pos);
    pos += tagResult.bytesRead;

    const { fieldNumber, wireType } = parseTag(tagResult.value);

    // Field 2 in MaybeDocument is the Document
    if (fieldNumber === 2 && wireType === WireType.LengthDelimited) {
      const { value: length, bytesRead } = decodeVarint(data, pos);
      pos += bytesRead;

      // Parse the inner Document proto
      return parseDocumentProto(data, pos, pos + length);
    } else {
      // Skip other fields (no_document, etc.)
      const skipped = skipField(data, pos, wireType);
      pos += skipped;
    }
  }

  // No document found - return empty map
  return new Map<string, FirestoreValue>();
}

/**
 * Extract a simple JavaScript object from parsed Firestore fields.
 * Converts FirestoreValue types to their primitive JS equivalents.
 */
export function toPlainObject(fields: Map<string, FirestoreValue>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of fields) {
    result[key] = firestoreValueToJS(value);
  }

  return result;
}

/**
 * Convert a FirestoreValue to its JavaScript equivalent.
 */
function firestoreValueToJS(value: FirestoreValue): unknown {
  switch (value.type) {
    case 'string':
    case 'integer':
    case 'double':
    case 'boolean':
    case 'reference':
      return value.value;

    case 'null':
      return null;

    case 'bytes':
      return value.value;

    case 'timestamp': {
      // Convert to ISO string or keep as object
      const date = new Date(value.value.seconds * 1000 + value.value.nanos / 1_000_000);
      return date.toISOString();
    }

    case 'geopoint':
      return { lat: value.value.latitude, lon: value.value.longitude };

    case 'map': {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of value.value) {
        obj[k] = firestoreValueToJS(v);
      }
      return obj;
    }

    case 'array':
      return value.value.map(firestoreValueToJS);

    default:
      return null;
  }
}

/**
 * Encode a simple JavaScript value as Firestore protobuf bytes.
 * Useful for creating test data.
 */
export function encodeFirestoreValue(value: unknown): Buffer {
  if (value === null || value === undefined) {
    // Null value: field 11, varint 0
    return Buffer.from([0x58, 0x00]);
  }

  if (typeof value === 'boolean') {
    // Boolean: field 1, varint 0 or 1
    return Buffer.from([0x08, value ? 0x01 : 0x00]);
  }

  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      // Integer: field 2, varint
      const tag = Buffer.from([0x10]);
      const encoded = encodeVarint(value);
      return Buffer.concat([tag, encoded]);
    } else {
      // Double: field 3, fixed64
      const buf = Buffer.alloc(9);
      buf[0] = 0x19;
      buf.writeDoubleLE(value, 1);
      return buf;
    }
  }

  if (typeof value === 'string') {
    // String: field 17, length-delimited
    const strBytes = Buffer.from(value, 'utf-8');
    const tag = Buffer.from([0x8a, 0x01]); // Field 17, wire type 2
    const length = encodeVarint(strBytes.length);
    return Buffer.concat([tag, length, strBytes]);
  }

  if (Array.isArray(value)) {
    // Array: field 9, length-delimited
    const elements = value.map((v) => {
      const encoded = encodeFirestoreValue(v);
      const length = encodeVarint(encoded.length);
      // Wrap each element: field 1 (values), length-delimited
      return Buffer.concat([Buffer.from([0x0a]), length, encoded]);
    });
    const arrayContent = Buffer.concat(elements);
    const tag = Buffer.from([0x4a]); // Field 9, wire type 2
    const length = encodeVarint(arrayContent.length);
    return Buffer.concat([tag, length, arrayContent]);
  }

  if (typeof value === 'object') {
    // Map: field 6, length-delimited
    const entries: Buffer[] = [];
    for (const [k, v] of Object.entries(value)) {
      // Key: field 1 (string)
      const keyBytes = Buffer.from(k, 'utf-8');
      const keyTag = Buffer.from([0x0a]);
      const keyLength = encodeVarint(keyBytes.length);
      const keyPart = Buffer.concat([keyTag, keyLength, keyBytes]);

      // Value: field 2 (Value message)
      const valueEncoded = encodeFirestoreValue(v);
      const valueTag = Buffer.from([0x12]);
      const valueLength = encodeVarint(valueEncoded.length);
      const valuePart = Buffer.concat([valueTag, valueLength, valueEncoded]);

      // Entry: field 1 of MapValue
      const entryContent = Buffer.concat([keyPart, valuePart]);
      const entryTag = Buffer.from([0x0a]);
      const entryLength = encodeVarint(entryContent.length);
      entries.push(Buffer.concat([entryTag, entryLength, entryContent]));
    }

    const mapContent = Buffer.concat(entries);
    const tag = Buffer.from([0x32]); // Field 6, wire type 2
    const length = encodeVarint(mapContent.length);
    return Buffer.concat([tag, length, mapContent]);
  }

  // Fallback to null
  return Buffer.from([0x58, 0x00]);
}

/**
 * Encode a complete Firestore document with fields.
 *
 * Creates a MaybeDocument wrapper containing a Document with map entries.
 * The format matches what parseFirestoreDocument expects:
 * MaybeDocument {
 *   field 2: Document {
 *     field 1: name (optional, we skip for tests)
 *     field 2: map entries (repeated, each entry has key=1, value=2)
 *   }
 * }
 */
export function encodeFirestoreDocument(fields: Record<string, unknown>): Buffer {
  // Encode all fields as map entries (field 2 of Document, repeated)
  const docFields: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    // Key: field 1 of map entry (string)
    const keyBytes = Buffer.from(k, 'utf-8');
    const keyTag = Buffer.from([0x0a]); // Field 1, wire type 2
    const keyLength = encodeVarint(keyBytes.length);
    const keyPart = Buffer.concat([keyTag, keyLength, keyBytes]);

    // Value: field 2 of map entry (Value message)
    const valueEncoded = encodeFirestoreValue(v);
    const valueTag = Buffer.from([0x12]); // Field 2, wire type 2
    const valueLength = encodeVarint(valueEncoded.length);
    const valuePart = Buffer.concat([valueTag, valueLength, valueEncoded]);

    // Map entry content (key + value)
    const entryContent = Buffer.concat([keyPart, valuePart]);

    // Wrap as field 2 of Document (repeated map entries)
    const entryTag = Buffer.from([0x12]); // Field 2, wire type 2
    const entryLength = encodeVarint(entryContent.length);
    docFields.push(Buffer.concat([entryTag, entryLength, entryContent]));
  }

  // Document content (all map entries)
  const documentContent = Buffer.concat(docFields);

  // Wrap in MaybeDocument: field 2 is Document
  const maybeDocTag = Buffer.from([0x12]); // Field 2, wire type 2
  const maybeDocLength = encodeVarint(documentContent.length);

  return Buffer.concat([maybeDocTag, maybeDocLength, documentContent]);
}
