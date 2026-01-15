/**
 * Tests for protobuf-parser.ts to achieve 100% code coverage.
 */

import { describe, test, expect } from 'bun:test';
import {
  decodeVarint,
  decodeSignedVarint,
  encodeVarint,
  parseTag,
  createTag,
  skipField,
  WireType,
  parseFirestoreValue,
  parseFirestoreDocument,
  toPlainObject,
  encodeFirestoreValue,
  encodeFirestoreDocument,
  type FirestoreValue,
} from '../../src/core/protobuf-parser.js';

describe('protobuf-parser', () => {
  describe('decodeVarint', () => {
    test('decodes single byte varint', () => {
      const buf = Buffer.from([0x05]);
      const { value, bytesRead } = decodeVarint(buf, 0);
      expect(value).toBe(5);
      expect(bytesRead).toBe(1);
    });

    test('decodes multi-byte varint', () => {
      // 300 = 0x012C = 10101100 00000010 in varint
      const buf = Buffer.from([0xac, 0x02]);
      const { value, bytesRead } = decodeVarint(buf, 0);
      expect(value).toBe(300);
      expect(bytesRead).toBe(2);
    });

    test('decodes varint at offset', () => {
      const buf = Buffer.from([0x00, 0x00, 0x0a]);
      const { value, bytesRead } = decodeVarint(buf, 2);
      expect(value).toBe(10);
      expect(bytesRead).toBe(1);
    });

    test('throws for truncated varint', () => {
      // MSB is set but no more bytes
      const buf = Buffer.from([0x80]);
      expect(() => decodeVarint(buf, 0)).toThrow('Truncated varint');
    });

    test('throws for empty buffer', () => {
      const buf = Buffer.from([]);
      expect(() => decodeVarint(buf, 0)).toThrow('Truncated varint');
    });

    test('throws for varint that is too long', () => {
      // Create a varint with 10+ continuation bytes
      const buf = Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]);
      expect(() => decodeVarint(buf, 0)).toThrow('Varint too long');
    });
  });

  describe('decodeSignedVarint', () => {
    test('decodes positive zigzag encoded value', () => {
      // 1 is encoded as 2 in zigzag
      const buf = Buffer.from([0x02]);
      const { value, bytesRead } = decodeSignedVarint(buf, 0);
      expect(value).toBe(1);
      expect(bytesRead).toBe(1);
    });

    test('decodes negative zigzag encoded value', () => {
      // -1 is encoded as 1 in zigzag
      const buf = Buffer.from([0x01]);
      const { value, bytesRead } = decodeSignedVarint(buf, 0);
      expect(value).toBe(-1);
      expect(bytesRead).toBe(1);
    });

    test('decodes zero', () => {
      const buf = Buffer.from([0x00]);
      const { value, bytesRead } = decodeSignedVarint(buf, 0);
      expect(value).toBe(0);
      expect(bytesRead).toBe(1);
    });
  });

  describe('encodeVarint', () => {
    test('encodes single byte value', () => {
      const buf = encodeVarint(5);
      expect(buf).toEqual(Buffer.from([0x05]));
    });

    test('encodes multi-byte value', () => {
      const buf = encodeVarint(300);
      expect(buf).toEqual(Buffer.from([0xac, 0x02]));
    });

    test('encodes zero', () => {
      const buf = encodeVarint(0);
      expect(buf).toEqual(Buffer.from([0x00]));
    });
  });

  describe('parseTag / createTag', () => {
    test('parses tag correctly', () => {
      // Field 1, wire type 0 (Varint)
      const { fieldNumber, wireType } = parseTag(0x08);
      expect(fieldNumber).toBe(1);
      expect(wireType).toBe(WireType.Varint);
    });

    test('parses tag with field 17', () => {
      // Field 17, wire type 2 (LengthDelimited)
      const { fieldNumber, wireType } = parseTag(0x8a);
      expect(fieldNumber).toBe(17);
      expect(wireType).toBe(WireType.LengthDelimited);
    });

    test('creates tag correctly', () => {
      const tag = createTag(1, WireType.Varint);
      expect(tag).toBe(0x08);
    });

    test('creates tag for higher field number', () => {
      const tag = createTag(17, WireType.LengthDelimited);
      expect(tag).toBe(0x8a);
    });
  });

  describe('skipField', () => {
    test('skips varint field', () => {
      const buf = Buffer.from([0x96, 0x01]); // varint 150
      const bytesSkipped = skipField(buf, 0, WireType.Varint);
      expect(bytesSkipped).toBe(2);
    });

    test('skips fixed64 field', () => {
      const buf = Buffer.alloc(10);
      const bytesSkipped = skipField(buf, 0, WireType.Fixed64);
      expect(bytesSkipped).toBe(8);
    });

    test('skips fixed32 field', () => {
      const buf = Buffer.alloc(6);
      const bytesSkipped = skipField(buf, 0, WireType.Fixed32);
      expect(bytesSkipped).toBe(4);
    });

    test('skips length-delimited field', () => {
      // Length of 5, followed by 5 bytes
      const buf = Buffer.from([0x05, 0x01, 0x02, 0x03, 0x04, 0x05]);
      const bytesSkipped = skipField(buf, 0, WireType.LengthDelimited);
      expect(bytesSkipped).toBe(6); // 1 for length + 5 for data
    });

    test('throws for StartGroup wire type', () => {
      const buf = Buffer.alloc(10);
      expect(() => skipField(buf, 0, WireType.StartGroup)).toThrow(
        'Deprecated wire type 3 not supported'
      );
    });

    test('throws for EndGroup wire type', () => {
      const buf = Buffer.alloc(10);
      expect(() => skipField(buf, 0, WireType.EndGroup)).toThrow(
        'Deprecated wire type 4 not supported'
      );
    });

    test('throws for unknown wire type', () => {
      const buf = Buffer.alloc(10);
      expect(() => skipField(buf, 0, 7 as WireType)).toThrow('Unknown wire type 7');
    });
  });

  describe('parseFirestoreValue', () => {
    test('parses boolean true', () => {
      // Field 1 (BooleanValue), varint 1
      const buf = Buffer.from([0x08, 0x01]);
      const result = parseFirestoreValue(buf);
      expect(result).toEqual({ type: 'boolean', value: true });
    });

    test('parses boolean false', () => {
      const buf = Buffer.from([0x08, 0x00]);
      const result = parseFirestoreValue(buf);
      expect(result).toEqual({ type: 'boolean', value: false });
    });

    test('parses integer', () => {
      // Field 2 (IntegerValue), varint 42
      const buf = Buffer.from([0x10, 0x2a]);
      const result = parseFirestoreValue(buf);
      expect(result).toEqual({ type: 'integer', value: 42 });
    });

    test('parses double', () => {
      // Field 3 (DoubleValue), fixed64
      const buf = Buffer.alloc(9);
      buf[0] = 0x19; // Field 3, wire type 1
      buf.writeDoubleLE(3.14, 1);
      const result = parseFirestoreValue(buf);
      expect(result.type).toBe('double');
      expect((result.value as number).toFixed(2)).toBe('3.14');
    });

    test('parses string', () => {
      // Field 17 (StringValue), length-delimited
      const buf = Buffer.from([0x8a, 0x01, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"
      const result = parseFirestoreValue(buf);
      expect(result).toEqual({ type: 'string', value: 'hello' });
    });

    test('parses null', () => {
      // Field 11 (NullValue), varint 0
      const buf = Buffer.from([0x58, 0x00]);
      const result = parseFirestoreValue(buf);
      expect(result).toEqual({ type: 'null', value: null });
    });

    test('parses bytes', () => {
      // Field 18 (BytesValue), length-delimited
      const buf = Buffer.from([0x92, 0x01, 0x03, 0x01, 0x02, 0x03]);
      const result = parseFirestoreValue(buf);
      expect(result.type).toBe('bytes');
      expect(result.value).toEqual(Buffer.from([0x01, 0x02, 0x03]));
    });

    test('parses reference', () => {
      // Field 5 (ReferenceValue), length-delimited
      const refPath = 'projects/test/databases/(default)/documents/col/doc';
      const refBuf = Buffer.from(refPath, 'utf-8');
      const buf = Buffer.concat([
        Buffer.from([0x2a]), // Field 5, wire type 2
        encodeVarint(refBuf.length),
        refBuf,
      ]);
      const result = parseFirestoreValue(buf);
      expect(result).toEqual({ type: 'reference', value: refPath });
    });

    test('parses timestamp', () => {
      // Field 10 (TimestampValue), length-delimited
      // Inner: field 1 = seconds (varint), field 2 = nanos (varint)
      const inner = Buffer.from([0x08, 0x64, 0x10, 0xc8, 0x01]); // seconds=100, nanos=200
      const buf = Buffer.concat([
        Buffer.from([0x52]), // Field 10, wire type 2
        encodeVarint(inner.length),
        inner,
      ]);
      const result = parseFirestoreValue(buf);
      expect(result.type).toBe('timestamp');
      expect((result.value as { seconds: number; nanos: number }).seconds).toBe(100);
      expect((result.value as { seconds: number; nanos: number }).nanos).toBe(200);
    });

    test('parses geopoint', () => {
      // Field 8 (GeoPointValue), length-delimited
      // Inner: field 1 = latitude (double), field 2 = longitude (double)
      const inner = Buffer.alloc(18);
      let pos = 0;
      inner[pos++] = 0x09; // Field 1, wire type 1 (fixed64)
      inner.writeDoubleLE(37.7749, pos);
      pos += 8;
      inner[pos++] = 0x11; // Field 2, wire type 1 (fixed64)
      inner.writeDoubleLE(-122.4194, pos);

      const buf = Buffer.concat([
        Buffer.from([0x42]), // Field 8, wire type 2
        encodeVarint(inner.length),
        inner,
      ]);
      const result = parseFirestoreValue(buf);
      expect(result.type).toBe('geopoint');
      const geo = result.value as { latitude: number; longitude: number };
      expect(geo.latitude.toFixed(4)).toBe('37.7749');
      expect(geo.longitude.toFixed(4)).toBe('-122.4194');
    });

    test('parses empty map', () => {
      // Field 6 (MapValue), empty
      const buf = Buffer.from([0x32, 0x00]);
      const result = parseFirestoreValue(buf);
      expect(result.type).toBe('map');
      expect((result.value as Map<string, FirestoreValue>).size).toBe(0);
    });

    test('parses array', () => {
      // Field 9 (ArrayValue)
      // Inner: field 1 (values), each containing a Value
      // Let's create an array with two integers
      const val1 = Buffer.from([0x10, 0x01]); // integer 1
      const val2 = Buffer.from([0x10, 0x02]); // integer 2
      const arrayInner = Buffer.concat([
        Buffer.from([0x0a]), // Field 1, wire type 2
        encodeVarint(val1.length),
        val1,
        Buffer.from([0x0a]),
        encodeVarint(val2.length),
        val2,
      ]);

      const buf = Buffer.concat([
        Buffer.from([0x4a]), // Field 9, wire type 2
        encodeVarint(arrayInner.length),
        arrayInner,
      ]);

      const result = parseFirestoreValue(buf);
      expect(result.type).toBe('array');
      const arr = result.value as FirestoreValue[];
      expect(arr.length).toBe(2);
      expect(arr[0]).toEqual({ type: 'integer', value: 1 });
      expect(arr[1]).toEqual({ type: 'integer', value: 2 });
    });

    test('returns null for empty buffer', () => {
      const buf = Buffer.from([]);
      const result = parseFirestoreValue(buf);
      expect(result).toEqual({ type: 'null', value: null });
    });

    test('skips unknown fields', () => {
      // Field 99 (unknown), then field 2 (integer)
      const buf = Buffer.from([
        0xf8,
        0x06,
        0x00, // Field 99, varint 0
        0x10,
        0x2a, // Field 2, integer 42
      ]);
      const result = parseFirestoreValue(buf);
      expect(result).toEqual({ type: 'integer', value: 42 });
    });

    test('throws for wrong wire type on boolean', () => {
      // Field 1 but with wire type 2 instead of 0
      const buf = Buffer.from([0x0a, 0x01, 0x00]);
      expect(() => parseFirestoreValue(buf)).toThrow('Expected varint for boolean');
    });

    test('throws for wrong wire type on integer', () => {
      const buf = Buffer.from([0x12, 0x01, 0x00]); // Field 2, wire type 2
      expect(() => parseFirestoreValue(buf)).toThrow('Expected varint for integer');
    });

    test('throws for wrong wire type on double', () => {
      const buf = Buffer.from([0x18, 0x00]); // Field 3, wire type 0
      expect(() => parseFirestoreValue(buf)).toThrow('Expected fixed64 for double');
    });

    test('throws for wrong wire type on string', () => {
      const buf = Buffer.from([0x88, 0x01, 0x00]); // Field 17, wire type 0
      expect(() => parseFirestoreValue(buf)).toThrow('Expected length-delimited for string');
    });

    test('throws for wrong wire type on bytes', () => {
      const buf = Buffer.from([0x90, 0x01, 0x00]); // Field 18, wire type 0
      expect(() => parseFirestoreValue(buf)).toThrow('Expected length-delimited for bytes');
    });

    test('throws for wrong wire type on null', () => {
      const buf = Buffer.from([0x5a, 0x00]); // Field 11, wire type 2
      expect(() => parseFirestoreValue(buf)).toThrow('Expected varint for null');
    });

    test('throws for wrong wire type on reference', () => {
      const buf = Buffer.from([0x28, 0x00]); // Field 5, wire type 0
      expect(() => parseFirestoreValue(buf)).toThrow('Expected length-delimited for reference');
    });

    test('throws for wrong wire type on timestamp', () => {
      const buf = Buffer.from([0x50, 0x00]); // Field 10, wire type 0
      expect(() => parseFirestoreValue(buf)).toThrow('Expected length-delimited for timestamp');
    });

    test('throws for wrong wire type on geopoint', () => {
      const buf = Buffer.from([0x40, 0x00]); // Field 8, wire type 0
      expect(() => parseFirestoreValue(buf)).toThrow('Expected length-delimited for geopoint');
    });

    test('throws for wrong wire type on map', () => {
      const buf = Buffer.from([0x30, 0x00]); // Field 6, wire type 0
      expect(() => parseFirestoreValue(buf)).toThrow('Expected length-delimited for map');
    });

    test('throws for wrong wire type on array', () => {
      const buf = Buffer.from([0x48, 0x00]); // Field 9, wire type 0
      expect(() => parseFirestoreValue(buf)).toThrow('Expected length-delimited for array');
    });
  });

  describe('parseFirestoreDocument', () => {
    test('parses MaybeDocument wrapper', () => {
      const doc = encodeFirestoreDocument({ name: 'Test', count: 42 });
      const fields = parseFirestoreDocument(doc);

      expect(fields.get('name')).toEqual({ type: 'string', value: 'Test' });
      expect(fields.get('count')).toEqual({ type: 'integer', value: 42 });
    });

    test('returns empty map for empty buffer', () => {
      const buf = Buffer.from([]);
      const fields = parseFirestoreDocument(buf);
      expect(fields.size).toBe(0);
    });

    test('returns empty map for NoDocument', () => {
      // Field 1 (NoDocument) instead of field 2 (Document)
      const buf = Buffer.from([0x0a, 0x02, 0x00, 0x00]);
      const fields = parseFirestoreDocument(buf);
      expect(fields.size).toBe(0);
    });
  });

  describe('toPlainObject', () => {
    test('converts string value', () => {
      const fields = new Map<string, FirestoreValue>([['name', { type: 'string', value: 'Test' }]]);
      const obj = toPlainObject(fields);
      expect(obj.name).toBe('Test');
    });

    test('converts integer value', () => {
      const fields = new Map<string, FirestoreValue>([['count', { type: 'integer', value: 42 }]]);
      const obj = toPlainObject(fields);
      expect(obj.count).toBe(42);
    });

    test('converts double value', () => {
      const fields = new Map<string, FirestoreValue>([['price', { type: 'double', value: 19.99 }]]);
      const obj = toPlainObject(fields);
      expect(obj.price).toBe(19.99);
    });

    test('converts boolean value', () => {
      const fields = new Map<string, FirestoreValue>([
        ['active', { type: 'boolean', value: true }],
      ]);
      const obj = toPlainObject(fields);
      expect(obj.active).toBe(true);
    });

    test('converts null value', () => {
      const fields = new Map<string, FirestoreValue>([['data', { type: 'null', value: null }]]);
      const obj = toPlainObject(fields);
      expect(obj.data).toBeNull();
    });

    test('converts reference value', () => {
      const fields = new Map<string, FirestoreValue>([
        ['ref', { type: 'reference', value: 'projects/test/doc' }],
      ]);
      const obj = toPlainObject(fields);
      expect(obj.ref).toBe('projects/test/doc');
    });

    test('converts bytes value', () => {
      const buf = Buffer.from([1, 2, 3]);
      const fields = new Map<string, FirestoreValue>([['data', { type: 'bytes', value: buf }]]);
      const obj = toPlainObject(fields);
      expect(obj.data).toEqual(buf);
    });

    test('converts timestamp to ISO string', () => {
      const fields = new Map<string, FirestoreValue>([
        ['created', { type: 'timestamp', value: { seconds: 1704067200, nanos: 0 } }],
      ]);
      const obj = toPlainObject(fields);
      expect(obj.created).toBe('2024-01-01T00:00:00.000Z');
    });

    test('converts geopoint to lat/lon object', () => {
      const fields = new Map<string, FirestoreValue>([
        ['location', { type: 'geopoint', value: { latitude: 37.77, longitude: -122.42 } }],
      ]);
      const obj = toPlainObject(fields);
      expect(obj.location).toEqual({ lat: 37.77, lon: -122.42 });
    });

    test('converts nested map', () => {
      const innerMap = new Map<string, FirestoreValue>([
        ['city', { type: 'string', value: 'NYC' }],
      ]);
      const fields = new Map<string, FirestoreValue>([
        ['address', { type: 'map', value: innerMap }],
      ]);
      const obj = toPlainObject(fields);
      expect(obj.address).toEqual({ city: 'NYC' });
    });

    test('converts array', () => {
      const arr: FirestoreValue[] = [
        { type: 'integer', value: 1 },
        { type: 'integer', value: 2 },
        { type: 'string', value: 'three' },
      ];
      const fields = new Map<string, FirestoreValue>([['items', { type: 'array', value: arr }]]);
      const obj = toPlainObject(fields);
      expect(obj.items).toEqual([1, 2, 'three']);
    });
  });

  describe('encodeFirestoreValue', () => {
    test('encodes null', () => {
      const buf = encodeFirestoreValue(null);
      expect(buf).toEqual(Buffer.from([0x58, 0x00]));
    });

    test('encodes undefined as null', () => {
      const buf = encodeFirestoreValue(undefined);
      expect(buf).toEqual(Buffer.from([0x58, 0x00]));
    });

    test('encodes boolean true', () => {
      const buf = encodeFirestoreValue(true);
      expect(buf).toEqual(Buffer.from([0x08, 0x01]));
    });

    test('encodes boolean false', () => {
      const buf = encodeFirestoreValue(false);
      expect(buf).toEqual(Buffer.from([0x08, 0x00]));
    });

    test('encodes integer', () => {
      const buf = encodeFirestoreValue(42);
      const decoded = parseFirestoreValue(buf);
      expect(decoded).toEqual({ type: 'integer', value: 42 });
    });

    test('encodes double', () => {
      const buf = encodeFirestoreValue(3.14);
      const decoded = parseFirestoreValue(buf);
      expect(decoded.type).toBe('double');
      expect((decoded.value as number).toFixed(2)).toBe('3.14');
    });

    test('encodes string', () => {
      const buf = encodeFirestoreValue('hello world');
      const decoded = parseFirestoreValue(buf);
      expect(decoded).toEqual({ type: 'string', value: 'hello world' });
    });

    test('encodes empty string', () => {
      const buf = encodeFirestoreValue('');
      const decoded = parseFirestoreValue(buf);
      expect(decoded).toEqual({ type: 'string', value: '' });
    });

    test('encodes array', () => {
      const buf = encodeFirestoreValue([1, 2, 'three']);
      const decoded = parseFirestoreValue(buf);
      expect(decoded.type).toBe('array');
      const arr = decoded.value as FirestoreValue[];
      expect(arr.length).toBe(3);
    });

    test('encodes empty array', () => {
      const buf = encodeFirestoreValue([]);
      const decoded = parseFirestoreValue(buf);
      expect(decoded.type).toBe('array');
      expect((decoded.value as FirestoreValue[]).length).toBe(0);
    });

    test('encodes object', () => {
      const buf = encodeFirestoreValue({ name: 'Test', value: 42 });
      const decoded = parseFirestoreValue(buf);
      expect(decoded.type).toBe('map');
      const map = decoded.value as Map<string, FirestoreValue>;
      expect(map.get('name')).toEqual({ type: 'string', value: 'Test' });
      expect(map.get('value')).toEqual({ type: 'integer', value: 42 });
    });

    test('encodes empty object', () => {
      const buf = encodeFirestoreValue({});
      const decoded = parseFirestoreValue(buf);
      expect(decoded.type).toBe('map');
      expect((decoded.value as Map<string, FirestoreValue>).size).toBe(0);
    });

    test('encodes nested object', () => {
      const buf = encodeFirestoreValue({ outer: { inner: 'value' } });
      const decoded = parseFirestoreValue(buf);
      expect(decoded.type).toBe('map');
    });
  });

  describe('parseFirestoreDocument additional coverage', () => {
    test('skips field 1 (name) in Document proto', () => {
      // Create a MaybeDocument with field 2 (Document) that has:
      // - field 1 (name string) - should be skipped
      // - field 2 (map entries)

      // Document inner content:
      // Field 1 (name): length-delimited string
      const nameField = Buffer.concat([
        Buffer.from([0x0a]), // Field 1, wire type 2
        encodeVarint(10),
        Buffer.from('test/path/', 'utf8'),
      ]);

      // Field 2 (map entry): key="foo", value=integer 42
      const keyPart = Buffer.concat([
        Buffer.from([0x0a, 0x03]), // Field 1 (key), length 3
        Buffer.from('foo', 'utf8'),
      ]);
      const valuePart = Buffer.concat([
        Buffer.from([0x12, 0x02]), // Field 2 (value), length 2
        Buffer.from([0x10, 0x2a]), // integer 42
      ]);
      const mapEntry = Buffer.concat([keyPart, valuePart]);
      const mapField = Buffer.concat([
        Buffer.from([0x12]), // Field 2, wire type 2
        encodeVarint(mapEntry.length),
        mapEntry,
      ]);

      const documentContent = Buffer.concat([nameField, mapField]);

      // Wrap in MaybeDocument: field 2 is Document
      const maybeDoc = Buffer.concat([
        Buffer.from([0x12]), // Field 2, wire type 2
        encodeVarint(documentContent.length),
        documentContent,
      ]);

      const fields = parseFirestoreDocument(maybeDoc);

      // Should have parsed the map entry while skipping the name field
      expect(fields.size).toBe(1);
      expect(fields.get('foo')).toEqual({ type: 'integer', value: 42 });
    });
  });

  describe('encodeFirestoreDocument', () => {
    test('encodes and decodes document roundtrip', () => {
      const original = {
        name: 'Test Document',
        count: 100,
        active: true,
        tags: ['a', 'b'],
      };

      const encoded = encodeFirestoreDocument(original);
      const decoded = parseFirestoreDocument(encoded);
      const obj = toPlainObject(decoded);

      expect(obj.name).toBe('Test Document');
      expect(obj.count).toBe(100);
      expect(obj.active).toBe(true);
      expect(obj.tags).toEqual(['a', 'b']);
    });

    test('handles empty document', () => {
      const encoded = encodeFirestoreDocument({});
      const decoded = parseFirestoreDocument(encoded);
      expect(decoded.size).toBe(0);
    });
  });

  describe('edge cases', () => {
    test('handles map with unknown fields', () => {
      // Create a map value with an unknown field before the valid entries
      // MapValue: field 1 = entries (repeated)
      // Let's add field 99 (unknown) + field 1 (entry)
      const keyBuf = Buffer.from([0x0a, 0x04, 0x74, 0x65, 0x73, 0x74]); // key: "test"
      const valueBuf = Buffer.from([0x12, 0x02, 0x10, 0x2a]); // value: integer 42
      const entry = Buffer.concat([keyBuf, valueBuf]);

      const mapInner = Buffer.concat([
        Buffer.from([0xf8, 0x06, 0x00]), // Field 99, varint 0 (unknown)
        Buffer.from([0x0a]), // Field 1
        encodeVarint(entry.length),
        entry,
      ]);

      const buf = Buffer.concat([
        Buffer.from([0x32]), // Field 6 (MapValue)
        encodeVarint(mapInner.length),
        mapInner,
      ]);

      const result = parseFirestoreValue(buf);
      expect(result.type).toBe('map');
      const map = result.value as Map<string, FirestoreValue>;
      expect(map.get('test')).toEqual({ type: 'integer', value: 42 });
    });

    test('handles array with unknown fields', () => {
      // ArrayValue: field 1 = values (repeated)
      const val = Buffer.from([0x10, 0x05]); // integer 5

      const arrayInner = Buffer.concat([
        Buffer.from([0xf8, 0x06, 0x00]), // Field 99, varint 0 (unknown)
        Buffer.from([0x0a]), // Field 1
        encodeVarint(val.length),
        val,
      ]);

      const buf = Buffer.concat([
        Buffer.from([0x4a]), // Field 9 (ArrayValue)
        encodeVarint(arrayInner.length),
        arrayInner,
      ]);

      const result = parseFirestoreValue(buf);
      expect(result.type).toBe('array');
      const arr = result.value as FirestoreValue[];
      expect(arr).toEqual([{ type: 'integer', value: 5 }]);
    });

    test('handles timestamp with unknown fields', () => {
      // Timestamp with field 99 (unknown) + seconds + nanos
      const inner = Buffer.from([
        0xf8,
        0x06,
        0x00, // Field 99, varint 0 (unknown)
        0x08,
        0x64, // Field 1 (seconds), varint 100
        0x10,
        0xc8,
        0x01, // Field 2 (nanos), varint 200
      ]);

      const buf = Buffer.concat([
        Buffer.from([0x52]), // Field 10 (TimestampValue)
        encodeVarint(inner.length),
        inner,
      ]);

      const result = parseFirestoreValue(buf);
      expect(result.type).toBe('timestamp');
      const ts = result.value as { seconds: number; nanos: number };
      expect(ts.seconds).toBe(100);
      expect(ts.nanos).toBe(200);
    });

    test('handles geopoint with unknown fields', () => {
      // GeoPoint with field 99 (unknown) + lat + lon
      const inner = Buffer.alloc(21);
      let pos = 0;
      inner[pos++] = 0xf8;
      inner[pos++] = 0x06;
      inner[pos++] = 0x00; // Field 99, varint 0
      inner[pos++] = 0x09; // Field 1, wire type 1
      inner.writeDoubleLE(40.0, pos);
      pos += 8;
      inner[pos++] = 0x11; // Field 2, wire type 1
      inner.writeDoubleLE(-74.0, pos);

      const buf = Buffer.concat([
        Buffer.from([0x42]), // Field 8 (GeoPointValue)
        encodeVarint(inner.length),
        inner,
      ]);

      const result = parseFirestoreValue(buf);
      expect(result.type).toBe('geopoint');
      const geo = result.value as { latitude: number; longitude: number };
      expect(geo.latitude).toBe(40.0);
      expect(geo.longitude).toBe(-74.0);
    });

    test('handles map entry with unknown fields', () => {
      // Map entry with field 99 + key + value
      const entry = Buffer.concat([
        Buffer.from([0xf8, 0x06, 0x00]), // Field 99, varint 0
        Buffer.from([0x0a, 0x03, 0x66, 0x6f, 0x6f]), // Field 1 (key): "foo"
        Buffer.from([0x12, 0x02, 0x10, 0x01]), // Field 2 (value): integer 1
      ]);

      const mapInner = Buffer.concat([
        Buffer.from([0x0a]), // Field 1 (entry)
        encodeVarint(entry.length),
        entry,
      ]);

      const buf = Buffer.concat([
        Buffer.from([0x32]), // Field 6 (MapValue)
        encodeVarint(mapInner.length),
        mapInner,
      ]);

      const result = parseFirestoreValue(buf);
      expect(result.type).toBe('map');
      const map = result.value as Map<string, FirestoreValue>;
      expect(map.get('foo')).toEqual({ type: 'integer', value: 1 });
    });
  });
});
