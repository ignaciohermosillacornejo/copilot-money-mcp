/**
 * Dispatch-time validation of a tool call's arguments against the tool's own
 * `inputSchema` (#845).
 *
 * Before this, the server ran no input validator: an argument a tool does not
 * take (`get_categories_live {period}`, `get_budgets_live {active_only}`) was
 * dropped in silence, and the caller saw a normal-looking result for a filter
 * that never ran; an out-of-enum value (`get_investment_balance_live
 * {time_frame: "1W"}`) reached Copilot's server and came back as a raw 400.
 * One check here covers every tool in both modes, and a tool added tomorrow is
 * covered by being registered.
 *
 * What it checks, at the top level and recursively through array items and
 * object properties, collecting every problem rather than stopping at the
 * first (#877):
 *   - an argument the schema does not declare is an error naming it and listing
 *     the accepted ones (for a nested object, only when its schema says
 *     `additionalProperties: false`);
 *   - a value of the wrong JSON type is an error naming the argument and the
 *     expected type (`integer` must be a whole number);
 *   - a value outside an `enum` is an error listing the allowed values.
 *
 * What it deliberately does not check: `required`, `pattern`, and ranges. The
 * handlers already reject a missing or malformed value with a message that
 * says what to do (a date range for a lookup, a calendar date), and those
 * messages are better than a generic one.
 *
 * Reporting: problems with the same shape — path pattern and rule broken,
 * whatever the offending values — collapse into one line naming how many items
 * share it, with example indices (a wrong key or a stringified amount repeated
 * across a 200-row batch is one sentence, not 200). At most MAX_REPORTED
 * distinct problems are listed, then a count of the rest, and the walk stops
 * recording after MAX_COLLECTED (#881 review).
 *
 * One tolerance: a tool may name top-level arguments its handler rejects
 * itself, with a more specific message than "unknown argument"
 * (`argsRejectedByHandler`). Three kinds today: the v3 migration errors for
 * `compact` / `include_logos`; get_transactions_live's "not supported in live
 * mode" for the location filters; and a capability Copilot's API lacks
 * (`parent_id` on create_category). Those keys pass through to the handler, and
 * such a call also skips the local-cache gate in src/server.ts so the message
 * arrives without a cache. tests/unit/dispatch-arg-validation.test.ts walks
 * every entry, with and without a cache, and requires the handler's own error.
 */

/** Distinct problems listed before the rest are only counted. */
export const MAX_REPORTED = 15;

/** The subset of a JSON Schema this validator reads. */
interface PropertySchema {
  type?: string;
  enum?: readonly unknown[];
  items?: PropertySchema;
  properties?: Record<string, PropertySchema>;
  additionalProperties?: boolean;
}

export interface ValidatableTool {
  name: string;
  schema: { inputSchema: { properties: Record<string, unknown> } };
  argsRejectedByHandler?: readonly string[];
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      // A type this validator does not model is not ours to reject.
      return true;
  }
}

function describe(value: unknown): string {
  const text = JSON.stringify(value);
  // `undefined` here means a value JSON cannot carry (undefined, a function),
  // which only an in-process caller can pass; JSON-RPC arguments never do.
  return text === undefined ? String(value) : text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** "got null", "got string \"x\"": the type is not repeated when it is the value. */
function got(value: unknown): string {
  return value === null || value === undefined
    ? `got ${String(value)}`
    : `got ${typeOf(value)} ${describe(value)}`;
}

/**
 * One problem, kept structured until it is reported, so problems can be
 * grouped by SHAPE — where (the path with its indices elided) and what (the
 * kind and the rule broken) — rather than by text. Text carries the offending
 * value, which differs per row in exactly the batches that most need
 * collapsing (#881 review: a stringified amount in every row of a batch).
 */
interface Problem {
  /** Concrete path, e.g. `edits[3].amount`. */
  path: string;
  /** Renders the rule broken for a path (concrete or `[*]` pattern), without the value. */
  rule: (path: string) => string;
  /** The offending value's part, e.g. `got string "12.00"`; empty when there is none. */
  detail: string;
}

/**
 * Collects problems up to a budget, so a huge malformed call cannot build an
 * unbounded list only to have most of it discarded (#881 review): once the
 * budget is spent the walk stops recording and the report says so.
 */
class ProblemSink {
  readonly problems: Problem[] = [];
  truncated = false;
  constructor(private readonly budget: number) {}
  add(problem: Problem): void {
    if (this.problems.length < this.budget) this.problems.push(problem);
    else this.truncated = true;
  }
  get full(): boolean {
    return this.truncated;
  }
}

/** Problems recorded before the walk stops collecting. */
export const MAX_COLLECTED = 1000;

/**
 * Validate one value against its property schema, recording every problem
 * through array items and nested objects, so a nested problem costs no extra
 * round trip either (#877 review). A type mismatch stops at that value: its
 * enum, items and keys are meaningless once the type is wrong.
 */
function checkValue(path: string, value: unknown, schema: PropertySchema, sink: ProblemSink): void {
  if (sink.full) return;
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    const type = schema.type;
    const article = /^[aeiou]/.test(type) ? 'an' : 'a';
    sink.add({
      path,
      rule: (p) =>
        `Argument '${p}' must be ${article} ${type}` +
        (type === 'integer' ? ' (a whole number)' : ''),
      detail: got(value),
    });
    return;
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    const allowed = schema.enum.map((v) => describe(v)).join(', ');
    sink.add({
      path,
      rule: (p) => `Argument '${p}' must be one of ${allowed}`,
      detail: `got ${describe(value)}`,
    });
    return;
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    for (let i = 0; i < value.length && !sink.full; i++) {
      checkValue(`${path}[${i}]`, value[i], schema.items, sink);
    }
  }
  if (
    schema.properties !== undefined &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  ) {
    checkObject(
      path,
      value as Record<string, unknown>,
      schema.properties,
      schema.additionalProperties === false,
      [],
      sink
    );
  }
}

/**
 * Every problem in one object, in argument order, so a caller who sent two bad
 * arguments learns about both in one round trip (#877 review).
 */
function checkObject(
  path: string,
  value: Record<string, unknown>,
  properties: Record<string, PropertySchema>,
  rejectUnknown: boolean,
  passThrough: readonly string[],
  sink: ProblemSink
): void {
  const accepted = Object.keys(properties);
  for (const [key, child] of Object.entries(value)) {
    if (sink.full) return;
    const childPath = path ? `${path}.${key}` : key;
    // Own-property lookup on purpose: JSON.parse creates an own `__proto__`
    // key, and `properties[key]` would read Object.prototype for it instead of
    // reporting it as the unknown argument it is.
    const childSchema = Object.prototype.hasOwnProperty.call(properties, key)
      ? properties[key]
      : undefined;
    if (childSchema === undefined) {
      // mutation-guard: handler-rejected arguments pass dispatch
      if (!rejectUnknown || passThrough.includes(key)) continue;
      // The parent path is the child path minus its last `.key`, so a `[*]`
      // pattern of the child renders a matching pattern of the parent.
      const parentOf = (p: string) => p.slice(0, p.length - key.length - 1);
      sink.add({
        path: childPath,
        rule: (p) =>
          accepted.length === 0
            ? path
              ? `Unknown key '${p}': '${parentOf(p)}' accepts no keys`
              : `Unknown argument '${p}': this tool takes no arguments`
            : `Unknown ${path ? 'key' : 'argument'} '${p}'. Accepted ` +
              `${path ? `keys of '${parentOf(p)}'` : 'arguments'}: ${accepted.join(', ')}`,
        detail: '',
      });
      continue;
    }
    checkValue(childPath, child, childSchema, sink);
  }
}

/**
 * Validate a tool call's arguments. Returns an error message naming the tool,
 * or null when the arguments are acceptable. `undefined` arguments (a call
 * with none) are acceptable.
 */
export function validateToolArgs(tool: ValidatableTool, args: unknown): string | null {
  if (args === undefined) return null;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return `Invalid arguments for ${tool.name}: expected an object of named arguments.`;
  }
  const sink = new ProblemSink(MAX_COLLECTED);
  checkObject(
    '',
    args as Record<string, unknown>,
    tool.schema.inputSchema.properties as Record<string, PropertySchema>,
    true,
    tool.argsRejectedByHandler ?? [],
    sink
  );
  return sink.problems.length === 0
    ? null
    : `Invalid arguments for ${tool.name}: ${summarize(sink.problems, sink.truncated)}`;
}

function sentence(problem: Problem, path: string): string {
  return problem.detail ? `${problem.rule(path)}; ${problem.detail}.` : `${problem.rule(path)}.`;
}

/** Example items named in a collapsed line before the rest are elided. */
const EXAMPLE_ITEMS = 3;

/**
 * Group problems by shape (path pattern + rule), then cap the list.
 *
 * A group of one is reported as itself. A larger group leads with where it
 * applies — how many ITEMS of the outermost array share it, with a few example
 * indices — then states the rule once on the `[*]` path, and gives the first
 * occurrence's value as an example: "In 200 items of 'edits' (0, 1, 2, …):
 * Argument 'edits[*].amount' must be a number; for example, 'edits[0].amount'
 * got string "12.00"." Items, not occurrences: three bad tags in one edit are
 * one item. Groups appear in first-seen order, and at most MAX_REPORTED are
 * listed before the rest are counted.
 */
function summarize(problems: readonly Problem[], truncated: boolean): string {
  const groups = new Map<string, Problem[]>();
  for (const problem of problems) {
    const pattern = problem.path.replace(/\[\d+\]/g, '[*]');
    const key = `${pattern}\u0000${problem.rule(pattern)}`;
    const group = groups.get(key);
    if (group) group.push(problem);
    else groups.set(key, [problem]);
  }
  const lines = [...groups.values()].map((group) => {
    const [first] = group as [Problem, ...Problem[]];
    if (group.length === 1) return sentence(first, first.path);
    const pattern = first.path.replace(/\[\d+\]/g, '[*]');
    // The outermost array: the path up to its first index, e.g. `edits`.
    const outer = first.path.slice(0, first.path.indexOf('['));
    const items: number[] = [];
    for (const p of group) {
      const index = Number(/\[(\d+)\]/.exec(p.path)?.[1]);
      if (!items.includes(index)) items.push(index);
    }
    const examples =
      items.slice(0, EXAMPLE_ITEMS).join(', ') + (items.length > EXAMPLE_ITEMS ? ', …' : '');
    const where =
      items.length === 1
        ? `In item ${examples} of '${outer}'`
        : `In ${items.length} items of '${outer}' (${examples})`;
    return (
      `${where}: ${first.rule(pattern)}` +
      (first.detail ? `; for example, '${first.path}' ${first.detail}.` : '.')
    );
  });
  const shown = lines.slice(0, MAX_REPORTED);
  const hidden = lines.length - shown.length;
  let report = shown.join(' ');
  if (hidden > 0)
    report += ` ...and ${hidden} more problem${hidden === 1 ? '' : 's'}; fix these first.`;
  if (truncated) report += ` (Stopped checking after ${MAX_COLLECTED} problems.)`;
  return report;
}
