/**
 * GraphQL query wrapper for UpcomingRecurrings.
 *
 * Returns the next-due recurring/subscription items ("about to bill" view).
 * Distinct from `fetchRecurrings`, which returns the full configured set
 * (historical view). The captured query takes no variables and returns
 * `unpaidUpcomingRecurrings: Recurring[]` shaped exactly like `Recurrings`
 * (RecurringFields + rule + payments). The `category @client` block is
 * stripped by the operations generator. The `payments @connection(key:
 * "upcoming")` directive is preserved by design — server tolerates it,
 * affects only Apollo's local cache.
 *
 * The node shape is structurally identical to `RecurringNode`. We re-export
 * a distinct alias (`UpcomingRecurringNode`) so consumers that distinguish
 * the two views can import the matching type.
 */

import type { GraphQLClient } from '../client.js';
import { UPCOMING_RECURRINGS } from '../operations.generated.js';
import type {
  RecurringIcon,
  RecurringNode,
  RecurringPaymentNode,
  RecurringRuleNode,
} from './recurrings.js';

export type { RecurringIcon, RecurringPaymentNode, RecurringRuleNode };

export type UpcomingRecurringNode = RecurringNode;

interface UpcomingRecurringsResponse {
  unpaidUpcomingRecurrings: UpcomingRecurringNode[];
}

export async function fetchUpcomingRecurrings(
  client: GraphQLClient
): Promise<UpcomingRecurringNode[]> {
  const data = await client.query<Record<string, never>, UpcomingRecurringsResponse>(
    'UpcomingRecurrings',
    UPCOMING_RECURRINGS,
    {}
  );
  return data.unpaidUpcomingRecurrings;
}
