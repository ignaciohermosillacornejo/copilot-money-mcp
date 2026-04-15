import type { GraphQLClient } from './client.js';
import { EDIT_BUDGET, EDIT_BUDGET_MONTHLY } from './operations.generated.js';

export interface SetBudgetArgs {
  categoryId: string;
  /** Stringified decimal. "0" clears the budget. */
  amount: string;
  /** YYYY-MM. When present, uses EditBudgetMonthly. */
  month?: string;
}

export async function setBudget(
  client: GraphQLClient,
  args: SetBudgetArgs
): Promise<{ categoryId: string; amount: string; month?: string; cleared: boolean }> {
  const cleared = args.amount === '0';
  if (args.month) {
    await client.mutate<
      { categoryId: string; input: Array<{ amount: string; month: string }> },
      { editCategoryBudgetMonthly: boolean }
    >('EditBudgetMonthly', EDIT_BUDGET_MONTHLY, {
      categoryId: args.categoryId,
      input: [{ amount: args.amount, month: args.month }],
    });
    return { categoryId: args.categoryId, amount: args.amount, month: args.month, cleared };
  }
  await client.mutate<
    { categoryId: string; input: { amount: string } },
    { editCategoryBudget: boolean }
  >('EditBudget', EDIT_BUDGET, {
    categoryId: args.categoryId,
    input: { amount: args.amount },
  });
  return { categoryId: args.categoryId, amount: args.amount, cleared };
}
