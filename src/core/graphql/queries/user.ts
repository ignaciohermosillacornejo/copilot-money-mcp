/**
 * GraphQL query wrapper for User.
 *
 * Returns the slice of the user record we use for live-mode read decisions.
 * Currently consumed by LiveCategoriesTools (and LiveBudgetsTools, which
 * shares categoriesCache) to honor the user's
 * `rolloversConfig.isEnabled` setting when calling fetchCategories.
 *
 * The captured query at docs/graphql-capture/operations/queries/User.md
 * exposes additional fields (onboarding, intercomUserHash, serviceEndsOn,
 * termsStatus). We project only what we need to keep this module focused;
 * extend the UserNode shape if a future feature requires more.
 *
 * The User query takes no variables.
 */

import { z } from 'zod';
import type { GraphQLClient } from '../client.js';
import { USER } from '../operations.generated.js';

export interface RolloversConfig {
  isEnabled: boolean;
  startDate: string | null;
}

export interface BudgetingConfig {
  isEnabled: boolean;
  rolloversConfig: RolloversConfig | null;
}

export interface UserNode {
  id: string;
  budgetingConfig: BudgetingConfig | null;
}

export interface UserResponse {
  user: UserNode;
}

export async function fetchUser(client: GraphQLClient): Promise<UserNode> {
  const data = await client.query<Record<string, never>, UserResponse>('User', USER, {});
  return data.user;
}

/**
 * Zod mirror of `UserResponse` for runtime warn-mode read-shape validation
 * (#537). Only the fields the wrapper projects are gated; the wire response
 * carries more (onboarding, intercomUserHash, …) which flow through loose.
 */
export const UserResponseSchema = z.looseObject({
  user: z.looseObject({
    id: z.string(),
    budgetingConfig: z
      .looseObject({
        isEnabled: z.boolean(),
        rolloversConfig: z
          .looseObject({
            isEnabled: z.boolean(),
            startDate: z.string().nullable(),
          })
          .nullable(),
      })
      .nullable(),
  }),
});
