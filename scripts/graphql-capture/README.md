# GraphQL Capture — Operator Runbook

Captures every GraphQL query and mutation the Copilot Money web app issues, so we can rewrite our write tools off direct Firestore onto the official API. See design spec: `docs/superpowers/specs/2026-04-14-graphql-capture-design.md`.

## One-time setup

1. Open Chrome and sign into https://copilot.money.
2. Open DevTools (Cmd+Opt+I). Go to the **Network** tab. Enable **Preserve log**. This is the HAR backup.
3. Go to the **Console** tab. Paste the entire contents of `scripts/graphql-capture/interceptor.js` and press Enter. You should see `[gql-capture] installed`.
4. **Reload the page** so initial queries go through the interceptor.
5. Leave this tab and DevTools open for the entire session.

## During the session

The agent navigates the app via the `claude-in-chrome` extension. Periodically the agent will need to drain the browser-side log. To drain:

1. In the DevTools console, run: `copy(JSON.stringify(window.__gqlLog)); window.__gqlLog = []`
2. Paste the copied JSON into a file the agent reads (or let the agent prompt you — the agent will tell you when it needs a drain).
3. The agent runs `bun scripts/graphql-capture/scrub.ts <raw> <scrubbed>` and then `bun scripts/graphql-capture/generate-docs.ts <scrubbed> docs/graphql-capture/`.

All output under `docs/graphql-capture/` is gitignored. Review it personally before committing anything.

## End of session

1. In DevTools Network tab, right-click → **Save all as HAR with content**. Save to `docs/graphql-capture/raw/session-YYYY-MM-DD.har`.
2. Final drain of `window.__gqlLog`.
3. Run scrub + generate-docs one final time.
4. Review `docs/graphql-capture/` end-to-end. If satisfied, remove the gitignore entry and commit.

## Safety rules (do not skip)

- Do not connect or disconnect bank accounts.
- Do not trigger account sync.
- Do not submit real money-moving actions.
- For destructive mutations (delete budget/category/goal/tag/recurring), create a test entity first named `GQL-TEST` and delete that.
- If the agent asks before a mutation, the answer is yes only for `GQL-TEST` entities.
