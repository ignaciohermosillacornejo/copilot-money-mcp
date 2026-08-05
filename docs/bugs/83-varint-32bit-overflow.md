---
id: 83
title: 64-bit varint decoding silently corrupted negative transaction amounts (32-bit bitwise overflow)
class: numeric-width-overflow
status: fixed
detected: dogfooding  # specific transaction amounts disagreed with the app
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/83
issue: none — found and fixed directly
date: 2026-01-16
---

## Symptom
Certain transactions showed amounts that were wildly wrong — off by more than an order of magnitude (e.g. a charge of $X reported as a few dollars). Only some negative amounts were affected; most data looked fine, making the corruption easy to miss in aggregate views.

## How it was detected
Dogfooding: spot-checking individual transactions against the Copilot app revealed specific rows with impossible amounts. Follow-up verification (in PR #84) compared the full decode against a CSV export of the real data to measure the match rate.

## Root cause
Protobuf encodes negative integers as 10-byte varints (64-bit two's complement). `decodeVarint` in `src/core/decoder.ts` accumulated with JavaScript's `|=` and `<<`, which operate on **32-bit signed integers**. Shift amounts wrap mod 32: at byte 6 the code computed `value << 35`, which JavaScript executes as `value << 3`, folding high-order bits onto low-order bits. Bytes 1–5 decoded correctly, so small positive values were fine — only 64-bit-encoded (negative) values were corrupted, silently, into other valid-looking numbers.

## The fix
`decodeVarint`/`encodeVarint` were rewritten to accumulate in `BigInt`, converting two's complement explicitly for negative values (landed in #83; the same commit also rode along in the overlapping branch merged as #84).

## Detector
None — instance-only regression tests with 64-bit-range values. There is no property-based round-trip test (`encodeVarint(decodeVarint(x)) === x` across the 64-bit range) that would catch the class.

## Lesson
Any hand-rolled binary decoder in JavaScript must treat 32-bit bitwise operators as a footgun the moment the wire format allows more than 31 bits. A round-trip property test over boundary values (±2^31, ±2^53, 10-byte varints) would have caught this before any real amount was corrupted.
