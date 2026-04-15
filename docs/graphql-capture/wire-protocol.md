# Copilot GraphQL Wire Protocol

HTTP-level details captured via DevTools Network → "Copy as fetch" on 2026-04-15. Source: `raw/wire-samples.txt`.

## Endpoint

- `https://app.copilot.money/api/graphql`
- **POST** only
- Apollo Client v3.13.8 with `BatchHttpLink`

## Authentication

- Header: `Authorization: Bearer <Firebase RS256 JWT>`
- No cookie-based auth is used for GraphQL. No `x-copilot-*` or custom request headers.
- Token source: Firebase Auth, stored in browser IndexedDB under `firebaseLocalStorageDb`, key `firebase:authUser:<firebase-web-api-key>:[DEFAULT]`, field `stsTokenManager.accessToken`. (The Firebase web API key is visible in Copilot's client bundle and is public-by-design — we redact here only to avoid tripping GitHub's secret scanner.)
- Token characteristics: ~1166 chars, `eyJhbGciOiJSUzI1NiIs...` prefix, 1 hour TTL, refreshed automatically by the Firebase SDK.

**What this means for the write-tool rewrite:** we already authenticate with Firebase in `src/core/auth/` (currently used for the direct Firestore writes). We can reuse the same Firebase identity to acquire the JWT, then send it as a Bearer header to the GraphQL endpoint. No additional auth layer required.

## Request batching

Apollo uses `BatchHttpLink` with:
- 30 ms debounce
- Max 10 operations per batch

Wire shapes:
- **Single op:** body is a JSON object `{operationName, query, variables}`.
- **Batched:** body is a JSON array of those objects: `[{op1}, {op2}, ...]`.

**What this means for the write-tool rewrite:** we should always send single ops (plain object body, not an array). The server accepts both. Sending unbatched simplifies error handling and avoids needing a batch cursor layer.

## Document transform caveat

The GraphQL document text we captured via Apollo's document registry is the **pre-transform** version. Apollo's `documentTransform` rewrites documents before the wire send to:
- Add `__typename` to every selection set
- Apply any field aliases registered with the cache
- Merge fragments according to the cache's fragment registry

If we send the pre-transform document verbatim, the server returns 500. We have two options:
1. **Post-process the query text ourselves**: add `__typename` to every selection set before sending. Can be done with the `graphql` npm package's `visit` + `BREAK` API, or with a small hand-rolled transformer.
2. **Bypass the transform concern**: the server often accepts the pre-transform version *if* we don't use cache-dependent features. For simple mutations with small response selections, a pre-transform send usually works. For queries that nest deeply, the server may complain about missing `__typename`.

For the write-tool rewrite, option 1 is safer. The transformation is deterministic and the graphql package is small.

## Response-side observations

Infrastructure headers that confirm the deployment shape:
- `x-powered-by: Copilot` (literal — cute easter egg)
- `x-cloud-trace-context` (Google Cloud Platform)
- `server-timing: cfExtPri`, `cf-ray`, `cf-cache-status: DYNAMIC` (Cloudflare in front of GCP)

Error shape on auth failure: HTTP 401, JSON body with GraphQL-style `errors` array (exact shape not captured end-to-end — verify during rewrite implementation).

Error shape on bad query (e.g. sending pre-transform query text): HTTP 500, shape undocumented.

## Non-GraphQL cookies that appear on the domain

These are NOT used for GraphQL auth but exist on the domain — worth knowing because a reverse-engineered client might accidentally send them:
- `__ps_r`, `__ps_lu`, `__ps_did`, `__ps_fva` (Copilot internal analytics/session tracking)
- `_ga`, `_gcl_au` (Google Analytics)
- `intercom-id-gw2wbwl7`, `intercom-session-gw2wbwl7` (Intercom)
- `__stripe_mid`, `__stripe_sid` (Stripe billing)

A minimal GraphQL client should send **only** the Authorization header, nothing else.
