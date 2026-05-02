/**
 * Shared smoke-test harness for live-mode tools.
 *
 * Encapsulates auth + client + LiveCopilotDatabase assembly so per-entity
 * smoke scripts (scripts/smoke/<entity>.ts) stay 30 lines or so.
 *
 * Usage:
 *   const { live, graphql, log } = await setupLiveSmoke({ verbose: true });
 *   const result = await someTool(live);
 *   log('done', { rows: result.length });
 *
 * Requires an authenticated app.copilot.money browser session — same auth
 * path the production server uses (FirebaseAuth via extractRefreshToken).
 */

import { CopilotDatabase } from '../../src/core/database.js';
import { GraphQLClient } from '../../src/core/graphql/client.js';
import { FirebaseAuth } from '../../src/core/auth/firebase-auth.js';
import { extractRefreshToken } from '../../src/core/auth/browser-token.js';
import { LiveCopilotDatabase, preflightLiveAuth } from '../../src/core/live-database.js';

export interface SmokeHarnessOptions {
  verbose?: boolean;
  /** For tests only — bypass real auth + client construction. */
  injectedClient?: GraphQLClient;
}

export interface SmokeHarnessContext {
  live: LiveCopilotDatabase;
  graphql: GraphQLClient;
  log: (msg: string, fields?: Record<string, unknown>) => void;
}

export async function setupLiveSmoke(opts: SmokeHarnessOptions = {}): Promise<SmokeHarnessContext> {
  const verbose = opts.verbose ?? true;

  let graphql: GraphQLClient;
  if (opts.injectedClient) {
    graphql = opts.injectedClient;
  } else {
    const auth = new FirebaseAuth(() => extractRefreshToken());
    graphql = new GraphQLClient(auth);
  }

  const db = new CopilotDatabase();
  const live = new LiveCopilotDatabase(graphql, db, { verbose });

  await preflightLiveAuth(graphql);

  const log = (msg: string, fields?: Record<string, unknown>): void => {
    const prefix = `[smoke] ${msg}`;
    if (fields) {
      console.error(prefix, fields);
    } else {
      console.error(prefix);
    }
  };

  return { live, graphql, log };
}
