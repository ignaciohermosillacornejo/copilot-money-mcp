/**
 * Class-level detector for #902: a bad value below the top level of a decoded
 * document must never cost the whole document.
 *
 * #302 (null `vested_*`), #659 (an `Infinity` price) and #902 (a null
 * `institution_price` on one holding of an MX-linked 401k) are one bug three
 * times: a single nested leaf the schema rejected removed an entire account
 * from `get_accounts`. Each earlier fix covered the instance in front of it —
 * two fields, then one kind of value — so this sweep is indexed by neither.
 *
 * It walks EVERY object schema exported from `src/models/`, builds a valid
 * document with every field populated, then for every node below the top
 * level (array elements, record entries, nested-object fields, and every leaf
 * inside them) replaces the value with each bad value we can name — `null`, a
 * wrong-type primitive, and for numbers `Infinity` — and asserts the document
 * still decodes through `validateOrWarn` with all of its top-level fields.
 *
 * Because the cases come from the schemas themselves, a nested field added
 * later is swept the day it lands, and a new model is swept the day it is
 * exported. If the sampler cannot build a valid document for a new schema,
 * the "sampler covers every model" test fails rather than the schema silently
 * escaping the sweep.
 *
 * Mutation check: removing the `repairNestedIssues` branch from
 * `validateOrWarn` (src/core/schema-warn.ts) turns the sweep red.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { z, type ZodType } from 'zod';
import { validateOrWarn, __resetWarnedKeys, getDecodeStats } from '../../src/core/schema-warn.js';

type AnySchema = ZodType & { _zod: { def: Record<string, unknown> & { type: string } } };
type Segment = string | number;

const MODELS_DIR = path.join(__dirname, '../../src/models');

const WRAPPERS = new Set(['optional', 'nullable', 'default', 'prefault', 'readonly', 'catch']);

function def(t: AnySchema): Record<string, unknown> & { type: string } {
  return t._zod.def;
}

function unwrap(t: AnySchema): AnySchema {
  let current = t;
  while (WRAPPERS.has(def(current).type)) current = def(current).innerType as AnySchema;
  return current;
}

/** Candidate values tried in order for a string schema (some carry date regexes). */
const STRING_CANDIDATES = ['sample', '2026-01-15', '2026-01', '2026-01-15T00:00:00.000Z'];

interface SweepNode {
  path: Segment[];
  kind: string;
}

class SamplerError extends Error {}

/**
 * Build a valid value for `t`, populating optional fields too, and record
 * every node at depth >= 2 (below the top level) that has a concrete type.
 */
function sample(t: AnySchema, at: Segment[], nodes: SweepNode[]): unknown {
  const inner = unwrap(t);
  const d = def(inner);
  if (at.length >= 2 && d.type !== 'unknown' && d.type !== 'any') {
    nodes.push({ path: at, kind: d.type });
  }

  let value: unknown;
  switch (d.type) {
    case 'string': {
      value = STRING_CANDIDATES.find((c) => inner.safeParse(c).success);
      if (value === undefined) throw new SamplerError(`no string candidate fits ${at.join('.')}`);
      break;
    }
    case 'number':
      value = [1, 0].find((c) => inner.safeParse(c).success);
      break;
    case 'boolean':
      value = true;
      break;
    case 'unknown':
    case 'any':
      value = 'sample';
      break;
    case 'enum':
      value = Object.values(d.entries as Record<string, unknown>)[0];
      break;
    case 'literal':
      value = (d.values as unknown[])[0];
      break;
    case 'union':
      value = sample((d.options as AnySchema[])[0] as AnySchema, at, nodes);
      break;
    case 'array':
      value = [sample(d.element as AnySchema, [...at, 0], nodes)];
      break;
    case 'record': {
      const key = STRING_CANDIDATES.find((c) => (d.keyType as AnySchema).safeParse(c).success);
      if (key === undefined) throw new SamplerError(`no record key fits ${at.join('.')}`);
      value = { [key]: sample(d.valueType as AnySchema, [...at, key], nodes) };
      break;
    }
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries((inner as unknown as z.ZodObject).shape)) {
        out[key] = sample(child as AnySchema, [...at, key], nodes);
      }
      value = out;
      break;
    }
    default:
      throw new SamplerError(`sampler has no case for '${d.type}' at ${at.join('.') || '<root>'}`);
  }
  return value;
}

/** Values the schema should reject at a node of this kind. */
function badValuesFor(kind: string): [label: string, value: unknown][] {
  const out: [string, unknown][] = [['null', null]];
  if (kind === 'number') {
    out.push(['a string', 'not-a-number'], ['Infinity', Infinity]);
  } else if (kind === 'string' || kind === 'enum') {
    out.push(['a number', 42]);
  } else {
    out.push(['a string', 'not-a-container']);
  }
  return out;
}

function setAt(doc: unknown, at: Segment[], value: unknown): unknown {
  const copy = structuredClone(doc) as Record<string, unknown>;
  let node: Record<string | number, unknown> = copy;
  for (const segment of at.slice(0, -1)) node = node[segment] as Record<string | number, unknown>;
  node[at[at.length - 1] as Segment] = value;
  return copy;
}

// ---------------------------------------------------------------------------
// Collect cases at module load. No expect() here (see CLAUDE.md, #714):
// failures are collected and asserted inside named tests below.
// ---------------------------------------------------------------------------

interface ModelCase {
  name: string;
  schema: AnySchema;
  base: Record<string, unknown>;
  nodes: SweepNode[];
}

const modelCases: ModelCase[] = [];
const samplerFailures: string[] = [];
const seen = new Set<unknown>();

for (const file of fs.readdirSync(MODELS_DIR).sort()) {
  if (!file.endsWith('.ts') || file === 'index.ts') continue;
  const mod = (await import(path.join(MODELS_DIR, file))) as Record<string, unknown>;
  for (const [exportName, exported] of Object.entries(mod)) {
    if (!(exported instanceof z.ZodType) || seen.has(exported)) continue;
    seen.add(exported);
    const schema = exported as unknown as AnySchema;
    if (def(unwrap(schema)).type !== 'object') continue;
    const name = `${file}:${exportName}`;
    try {
      const nodes: SweepNode[] = [];
      const base = sample(schema, [], nodes) as Record<string, unknown>;
      const check = schema.safeParse(base);
      if (!check.success) {
        samplerFailures.push(
          `${name}: sampled document does not validate — ${check.error.message}`
        );
        continue;
      }
      if (nodes.length > 0) modelCases.push({ name, schema, base, nodes });
    } catch (err) {
      if (!(err instanceof SamplerError)) throw err;
      samplerFailures.push(`${name}: ${err.message}`);
    }
  }
}

const sweepCases = modelCases.flatMap((m) =>
  m.nodes.flatMap((node) =>
    badValuesFor(node.kind).map(
      ([label, value]) =>
        [`${m.name} ${node.path.join('.')} = ${label}`, m, node.path, value] as const
    )
  )
);

describe('nested-field sweep (#902)', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    __resetWarnedKeys();
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('the sampler covers every exported model schema', () => {
    expect(samplerFailures).toEqual([]);
  });

  test('the sweep reaches the schemas and fields that have dropped documents before', () => {
    const covered = new Set(
      modelCases.flatMap((m) => m.nodes.map((n) => `${m.name} ${n.path.join('.')}`))
    );
    // #902 and #659 — the account holding price; #302 — vested_*; the
    // sibling Plaid-account schema that #302 needed a second PR for.
    expect(covered).toContain('account.ts:AccountSchema holdings.0.institution_price');
    expect(covered).toContain('account.ts:AccountSchema holdings.0.vested_value');
    expect(covered).toContain('plaid-account.ts:PlaidAccountSchema holdings.0.institution_price');
    expect(covered).toContain('holdings-history.ts:HoldingsHistorySchema history.sample.price');
    // A floor, so a sampler regression that quietly stops descending is loud.
    expect(sweepCases.length).toBeGreaterThan(100);
  });

  test.each(sweepCases)('%s keeps the document', (_label, model, at, bad) => {
    const doc = setAt(model.base, at, bad);
    const result = validateOrWarn(model.schema, doc, { collection: 'sweep', docId: 'doc1' });

    expect(result).not.toBeNull();
    // Every top-level field survives — the repair removes only nested values.
    expect(Object.keys(result as object).sort()).toEqual(Object.keys(model.base).sort());
    expect(getDecodeStats().sweep?.dropped).toBe(0);
  });

  // Control: the repair must not swallow top-level drift. A required top-level
  // field set to null still drops the document.
  const requiredTopLevel = modelCases.flatMap((m) =>
    Object.entries((unwrap(m.schema) as unknown as z.ZodObject).shape)
      .filter(([, child]) => !(child as AnySchema).safeParse(undefined).success)
      .filter(([, child]) => !(child as AnySchema).safeParse(null).success)
      .map(([key]) => [`${m.name} ${key}`, m, key] as const)
  );

  test.each(requiredTopLevel)('%s = null still drops (top level is not repaired)', (_l, m, key) => {
    const doc = setAt(m.base, [key], null);
    const result = validateOrWarn(m.schema, doc, { collection: 'sweep', docId: 'doc1' });

    expect(result).toBeNull();
    expect(getDecodeStats().sweep?.dropped).toBe(1);
  });
});
