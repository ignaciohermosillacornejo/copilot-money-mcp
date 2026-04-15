import type { GraphQLClient } from './client.js';
import { EDIT_BUDGET, EDIT_BUDGET_MONTHLY } from './operations.generated.js';

export interface SetBudgetArgs {
  categoryId: string;
  /** Non-negative decimal. "0" clears the budget. Accepts string form like "250.00" or "0". */
  amount: string;
  /** YYYY-MM. When present, uses EditBudgetMonthly. */
  month?: string;
}

export async function setBudget(
  client: GraphQLClient,
  args: SetBudgetArgs
): Promise<{ categoryId: string; amount: string; month?: string; cleared: boolean }> {
  const cleared = args.amount === '0';
  // Parse to Float at the wire boundary — the server schema declares
  // `amount: Float`, and sending a string causes BAD_USER_INPUT. The
  // MCP-facing args stay as strings (matches how tools.ts validates them).
  const amountFloat = parseFloat(args.amount);
  if (!Number.isFinite(amountFloat) || amountFloat < 0) {
    throw new Error(`setBudget: invalid amount ${args.amount}`);
  }
  if (args.month) {
    await client.mutate<
      { categoryId: string; input: Array<{ amount: number; month: string }> },
      { editCategoryBudgetMonthly: boolean }
    >('EditBudgetMonthly', EDIT_BUDGET_MONTHLY, {
      categoryId: args.categoryId,
      input: [{ amount: amountFloat, month: args.month }],
    });
    return { categoryId: args.categoryId, amount: args.amount, month: args.month, cleared };
  }
  await client.mutate<
    { categoryId: string; input: { amount: number } },
    { editCategoryBudget: boolean }
  >('EditBudget', EDIT_BUDGET, {
    categoryId: args.categoryId,
    input: { amount: amountFloat },
  });
  return { categoryId: args.categoryId, amount: args.amount, cleared };
}
