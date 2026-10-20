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
 * object properties:
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
 * One tolerance: a tool may name arguments its handler rejects itself, with a
 * more specific message than "unknown argument" — the v3 migration errors for
 * `compact` / `include_logos`, and get_transactions_live's "not supported in
 * live mode" for the location filters. Those keys pass through to the handler
 * (`argsRejectedByHandler`).
 */

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

/** Validate one value against its property schema; returns its first error or null. */
function checkValue(path: string, value: unknown, schema: PropertySchema): string | null {
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    const article = /^[aeiou]/.test(schema.type) ? 'an' : 'a';
    return (
      `Argument '${path}' must be ${article} ${schema.type}` +
      (schema.type === 'integer' ? ' (a whole number)' : '') +
      `; ${got(value)}.`
    );
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    return (
      `Argument '${path}' must be one of ${schema.enum.map((v) => describe(v)).join(', ')}; ` +
      `got ${describe(value)}.`
    );
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    for (let i = 0; i < value.length; i++) {
      const error = checkValue(`${path}[${i}]`, value[i], schema.items);
      if (error) return error;
    }
  }
  if (
    schema.properties !== undefined &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const errors = checkObject(
      path,
      value as Record<string, unknown>,
      schema.properties,
      schema.additionalProperties === false,
      []
    );
    if (errors.length > 0) return errors[0] ?? null;
  }
  return null;
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
  passThrough: readonly string[]
): string[] {
  const accepted = Object.keys(properties);
  const errors: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    // Own-property lookup on purpose: JSON.parse creates an own `__proto__`
    // key, and `properties[key]` would read Object.prototype for it instead of
    // reporting it as the unknown argument it is.
    const childSchema = Object.prototype.hasOwnProperty.call(properties, key)
      ? properties[key]
      : undefined;
    if (childSchema === undefined) {
      if (!rejectUnknown || passThrough.includes(key)) continue;
      errors.push(
        accepted.length === 0
          ? path
            ? `Unknown key '${childPath}': '${path}' accepts no keys.`
            : `Unknown argument '${childPath}': this tool takes no arguments.`
          : `Unknown ${path ? 'key' : 'argument'} '${childPath}'. Accepted ` +
              `${path ? `keys of '${path}'` : 'arguments'}: ${accepted.join(', ')}.`
      );
      continue;
    }
    const error = checkValue(childPath, child, childSchema);
    if (error) errors.push(error);
  }
  return errors;
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
  const errors = checkObject(
    '',
    args as Record<string, unknown>,
    tool.schema.inputSchema.properties as Record<string, PropertySchema>,
    true,
    tool.argsRejectedByHandler ?? []
  );
  return errors.length === 0 ? null : `Invalid arguments for ${tool.name}: ${errors.join(' ')}`;
}
