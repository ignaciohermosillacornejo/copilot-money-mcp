/**
 * Readers for what a `globalThis.fetch` test double receives. `String(input)`
 * on a `Request`, or `String(body)` on a `Blob`/`FormData`/stream, yields
 * `[object Request]` and the like, and a substring check against that passes
 * or fails for the wrong reason (#919, no-base-to-string).
 */

/** The URL a fetch call targets, whichever of the three input forms it used. */
export function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * A fetch call's request body as text: '' when there is none. Every client
 * under test sends a JSON string, so any other body type is a broken double
 * and throws rather than being stringified into something unreadable.
 */
export function bodyText(init?: RequestInit): string {
  const body = init?.body;
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  throw new Error(
    `fetch double expected a string body, got ${Object.prototype.toString.call(body)}`
  );
}
