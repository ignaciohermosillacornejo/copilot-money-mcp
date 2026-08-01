# Privacy Policy for Copilot Money MCP Server

**Last Updated:** July 31, 2026

## Disclaimer

**This is an independent, community-driven project and is not affiliated with, endorsed by, or associated with Copilot Money or its parent company in any way.** This tool was created by an independent developer. "Copilot Money" is a trademark of its respective owner.

## Overview

The Copilot Money MCP Server is designed with privacy as a core principle. This document outlines our privacy practices and commitments.

The server operates in three modes:

- **Default (cache-only):** Reads data exclusively from your local Copilot Money database cache. No network requests are made.
- **Live reads (opt-in, `--live-reads` flag):** Replaces several cache-backed read tools with GraphQL-backed equivalents that query Copilot Money's API for current data. **This is a read-only mode that does make network requests.**
- **Write mode (opt-in, `--write` flag):** Adds the ability to modify your Copilot Money data. `--write` implies `--live-reads`.

Both `--live-reads` and `--write` send authenticated requests to Copilot Money's own API. See [Network Access](#network-access) below for exactly which destinations are contacted in each mode.

## Important: Data Shared With AI Providers

**The MCP server itself is local, but the AI assistant you connect it to is not.** When you use this server with a hosted AI model (Claude Desktop, ChatGPT, Gemini, Cursor, or any other MCP-compatible client that relies on a cloud-hosted model), the tool responses containing your Copilot Money data — transactions, balances, account names, merchants, categories, holdings, and so on — are sent to that AI provider so the model can answer your question.

**That means your financial data will leave your machine and be transmitted to a third-party AI provider**, such as:

- **Anthropic** (if you use Claude Desktop or any Claude-powered client)
- **OpenAI** (if you use ChatGPT, GPT-based tools, or Cursor with GPT models)
- **Google** (if you use Gemini or any Google-hosted model)
- **Any other AI provider** whose model your MCP client connects to

Each provider has its own privacy policy, data retention, and training-data practices, which apply to this data once it is transmitted. This project has no control over how those providers handle your data.

**By using this MCP server with a hosted AI model, you are knowingly and voluntarily sharing your financial data with the provider of that model. You must be comfortable with that trade-off.** If you are not, do not use this tool — consider waiting for an official Copilot Money integration, or running a fully local model that does not transmit data off your machine.

## Data Collection

**We do not collect, store, or transmit any of your data to our servers or any third party.** The server has no backend, no analytics, and no telemetry.

The Copilot Money MCP Server:
- Operates on your local machine
- Reads data only from your local Copilot Money database cache
- Never sends your financial data to servers operated by this project (we don't have servers)
- Does not include any analytics or telemetry
- Makes zero network requests in the default (cache-only) mode
- In the opt-in `--live-reads` and `--write` modes, makes network requests **only** to Copilot Money's own API at `https://app.copilot.money/api/graphql`, plus Google's token-exchange endpoint (`https://securetoken.googleapis.com`) to refresh the Firebase credential those requests are authenticated with

## Data Access

### What Data We Access

The server reads from your local Copilot Money database, which is stored at:
```
~/Library/Containers/com.copilot.production/Data/Library/Application Support/firestore/__FIRAPP_DEFAULT/copilot-production-22904/main
```

This database contains:
- Transaction records (amounts, dates, merchant names, categories)
- Account information (balances, account types, institution names)
- Budgets, goals, tags, categories, and recurring transactions
- Investment holdings, prices, and performance data

### How We Access Data

- **Local Reads by Default:** In the default mode, all data reads happen against your local Copilot Money database cache
- **Local Processing:** All query processing, filtering, and aggregation happens on your machine
- **Cache-Only by Default:** In the default mode, the server only reads locally and makes zero network requests
- **Opt-In Live Reads:** With `--live-reads`, several read tools query Copilot Money's API directly instead of the local cache. This is still read-only — it modifies nothing — but your requests, and the financial data returned, travel over the network
- **No Third-Party Analytics:** No connections to analytics, tracking, or telemetry services
- **Opt-In Writes:** Write operations are disabled unless you explicitly start the server with `--write`. When enabled, writes are sent directly to Copilot Money's own API — the same backend the Copilot Money app uses — and not to any intermediary operated by this project

## Data Usage

Data read from your local database is used exclusively to:
1. Respond to queries from an AI client (Claude Desktop, ChatGPT, Cursor, etc.) via the Model Context Protocol (MCP)
2. Perform local calculations (e.g., spending aggregations, category summaries)
3. Filter and search transactions based on your requests

If you explicitly enable `--live-reads`, your queries are additionally used to:
4. Construct authenticated GraphQL queries against Copilot Money's API to fetch current data instead of reading the local cache

If you explicitly enable write mode with `--write`, data you ask the server to modify is additionally used to:
5. Construct authenticated GraphQL mutations that apply your requested changes to your own Copilot Money account

All processing happens in memory on your local machine. No data is persisted outside of the existing Copilot Money database and Copilot Money's own backend.

## Data Sharing

**This project does not collect or share your data with anyone.** However, please read the section above on [Data Shared With AI Providers](#important-data-shared-with-ai-providers) — the AI model you connect this server to will receive your financial data as part of normal MCP tool-call responses.

- No data is sent to our servers (we don't have servers)
- No data is sent to third parties for analytics, advertising, or tracking by this project
- No analytics or crash reports are transmitted by this project
- **Your AI provider (Anthropic, OpenAI, Google, or whichever model you use) will receive your Copilot Money data** as part of answering your queries — governed by that provider's privacy policy, not this project's

In the opt-in `--live-reads` and `--write` modes, requests are sent directly from your machine to Copilot Money's own API using your own Copilot Money credentials. This is the same backend the Copilot Money app uses — no intermediary server operated by this project is involved. This traffic is governed by Copilot Money's own privacy policy.

## Data Security

### Technical Safeguards

- **Local-First Architecture:** All queries, filtering, and aggregation happen locally
- **No Network Access in Default Mode:** In the default (cache-only) mode, the server makes zero network requests
- **Opt-In Network Access:** Network access requires either `--live-reads` or `--write`; neither is on by default
- **Opt-In Writes:** Write tools are disabled unless you explicitly start the server with `--write`
- **Authenticated Requests Only:** When `--live-reads` or `--write` is enabled, requests are authenticated with your own Copilot Money credentials over HTTPS
- **No Third-Party Network Destinations:** In every mode, the only destinations the server contacts are Copilot Money's own API (`app.copilot.money`) and Google's Firebase token-exchange endpoint (`securetoken.googleapis.com`), which is used solely to refresh your credential and never receives your financial data
- **macOS Sandbox Compliance:** Respects macOS file system permissions

### Your Control

You maintain full control over your data:
- The server only runs when you explicitly start it via your MCP client
- You can stop the server at any time by closing your MCP client
- You can uninstall the server at any time
- Your Copilot Money data remains in its original location
- **Write mode is strictly opt-in:** Write tools are unavailable unless you explicitly start the server with `--write`. Without this flag, the server cannot modify your Copilot Money data even if instructed to do so

## Network Access

By default, the server makes **zero** network requests: every read comes from the local cache. Network access is opt-in, and there are two flags that enable it.

### The exact destinations, in every mode

| Mode | Network requests | Destinations |
|---|---|---|
| Default (no flags) | None | — |
| `--live-reads` | Authenticated reads | `app.copilot.money`, `securetoken.googleapis.com` |
| `--write` (implies `--live-reads`) | Authenticated reads and writes | `app.copilot.money`, `securetoken.googleapis.com` |

- **`https://app.copilot.money/api/graphql`** — Copilot Money's own API. This is where your financial data is requested from and where your changes are sent. It is the same backend the Copilot Money app uses, so your data and your changes reach your own account exactly as they would in the app.
- **`https://securetoken.googleapis.com/v1/token`** — Google's Firebase token-exchange endpoint. Used **only** to exchange the refresh token from your local Copilot Money session for a short-lived access token. Your financial data is never sent here.

No other destination is contacted in any mode.

### What Happens in `--live-reads` Mode

- Several read tools stop reading the local cache and query Copilot Money's API for current data instead
- Your query parameters, and the financial data returned, travel over the network
- **This mode is read-only — it modifies nothing — but it is not offline.** If you chose this flag to get fresher data, be aware you also chose to make network requests

### What Happens in Write Mode

- The server can execute write tools that modify your Copilot Money data (categorizing transactions, creating budgets, editing goals, etc.)
- To apply those changes, the server exchanges a Firebase refresh token extracted from your local Copilot Money session for an access token, then sends authenticated GraphQL mutations to Copilot Money's API
- `--write` also enables `--live-reads`: once the session is authenticated there is no privacy benefit to reading a stale cache, and write tools need live records to resolve IDs outside the cache window
- No traffic passes through any server operated by this project

### What Does Not Happen

- No traffic is ever sent to servers operated by this project (we don't have any)
- No traffic is sent to Anthropic, OpenAI, or any AI provider by the server itself — see [Data Shared With AI Providers](#important-data-shared-with-ai-providers) for what your MCP *client* transmits
- The server never initiates reads or writes on its own — every request is the direct result of a tool call you (or an AI assistant on your behalf) issued
- Your Firebase credentials are held only in memory. They are never logged or persisted. The refresh token is sent only to Google's token-exchange endpoint; the resulting access token is sent only to Copilot Money's API as an `Authorization` header

### Governing Policies

Network traffic in `--live-reads` and `--write` modes is subject to:
- Copilot Money's own terms and privacy policy (as you are reading and modifying data on their backend)
- [Google's Privacy Policy](https://policies.google.com/privacy), for the Firebase token exchange only

## AI Client Integration

When integrated with an AI client such as Claude Desktop, ChatGPT, Cursor, or Gemini:
- Your queries and the tool responses produced by this server are processed by the underlying AI model
- To answer your questions, the AI model will see the Copilot Money data returned by tool calls (transactions, balances, merchants, categories, holdings, etc.)
- This data is transmitted to and processed by the AI provider (Anthropic, OpenAI, Google, or another third party, depending on which model you use) according to **that provider's** privacy policy and data retention terms — not this project's
- Relevant policies include [Anthropic's Privacy Policy](https://www.anthropic.com/privacy), [OpenAI's Privacy Policy](https://openai.com/policies/privacy-policy), and [Google's Privacy Policy](https://policies.google.com/privacy)
- You control what queries you send and which AI client you connect to this server

## Third-Party Services

This server does not integrate with any third-party services beyond:
- **Your MCP client's AI provider** (required only if you use the server for AI-powered queries; optional if you call tools programmatically) — e.g., Anthropic (Claude Desktop), OpenAI (ChatGPT, Cursor with GPT), Google (Gemini). Your Copilot Money data is shared with this provider as part of normal MCP tool-call responses. See [Data Shared With AI Providers](#important-data-shared-with-ai-providers).
- **Copilot Money** (reads the local database created by the app; and in the opt-in `--live-reads` and `--write` modes, its API at `app.copilot.money`, accessed directly with your own Copilot Money credentials)
- **Google Firebase** (token exchange only, in the opt-in `--live-reads` and `--write` modes, to refresh the credential those requests are authenticated with — no financial data is sent to Google)

## Children's Privacy

This server is not directed to children under 13. We do not knowingly collect data from children.

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be reflected in this document with an updated "Last Updated" date.

## Open Source

This server is open source. You can:
- Review the source code at https://github.com/ignaciohermosillacornejo/copilot-money-mcp
- Verify exactly which network destinations (if any) are contacted in each mode
- Audit the data access patterns
- Contribute improvements

## Contact

For privacy-related questions or concerns:
- Open an issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues
- Email: hello@ignaciohermosilla.com

## Summary

**In short:** This server is a local-first tool that reads your Copilot Money data to enable AI-powered queries via an MCP client such as Claude Desktop, ChatGPT, Cursor, or Gemini. This project never collects, stores, or transmits your financial information to servers operated by this project — we don't have any.

**However, the AI assistant you connect this server to will see your Copilot Money data** in order to answer your questions, and that data will be transmitted to the corresponding AI provider (Anthropic, OpenAI, Google, or another third party) according to that provider's privacy policy. By using this MCP server with a hosted AI model, you knowingly accept sharing your financial data with that provider. If you are not comfortable with that, do not use this tool.

By default the server makes no network requests at all. If you explicitly opt in with `--live-reads` (read-only, but online) or `--write` (which implies it), the server talks directly to Copilot Money's own API at `app.copilot.money` using your own credentials, plus Google's Firebase endpoint to refresh that credential. Nothing else is contacted in any mode.
