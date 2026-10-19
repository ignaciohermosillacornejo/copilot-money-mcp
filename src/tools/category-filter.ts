/**
 * The `category` filter of get_transactions and get_transactions_live, one
 * implementation for both modes (#845).
 *
 * Before this, live mode matched one exact id and cache mode matched a
 * case-insensitive SUBSTRING of the id (a relic of Plaid-taxonomy ids such as
 * `food_and_drink_restaurants`, which real user categories, opaque Firestore
 * ids, no longer have). Neither included a parent's subcategories, and a value
 * that matched nothing (a category name, a typo) silently returned zero rows,
 * which reads exactly like "you spent nothing there".
 *
 * Now, in both modes:
 *   - the value is a category id, matched exactly;
 *   - a parent id also selects every descendant category's rows, the way the
 *     app's parent category rolls up its children;
 *   - a value that is no known category id is an error naming where to get one
 *     (and, if it is a category NAME, the id it probably meant).
 */

export interface CategoryFilterNode {
  id: string;
  parentId: string | null;
  name?: string | null;
}

export interface ResolveCategoryFilterOptions {
  /**
   * The read tool that lists category ids in this mode, for the error hint
   * (`get_categories` or `get_categories_live`).
   */
  listTool: string;
  /**
   * True when `value` is missing from `categories` but a transaction in the
   * queried date range carries it (an orphaned id). Both modes compute it over
   * that same corpus, the rows the call fetched for its window. Such a value is
   * accepted; if it is also some category's parent, its children still expand.
   */
  knownElsewhere?: boolean;
}

/**
 * Resolve a `category` filter value to the set of category ids whose rows it
 * selects: the id itself plus all of its descendants. Throws when the value is
 * not a known category id.
 */
export function resolveCategoryFilter(
  value: string,
  categories: readonly CategoryFilterNode[],
  opts: ResolveCategoryFilterOptions
): Set<string> {
  const known = categories.some((c) => c.id === value);
  if (!known && !opts.knownElsewhere) {
    const lowered = value.trim().toLowerCase();
    const byName = categories.filter((c) => (c.name ?? '').trim().toLowerCase() === lowered);
    const suggestion =
      byName.length > 0
        ? ` '${value}' is a category NAME; its id is ${byName.map((c) => `'${c.id}'`).join(' or ')}.`
        : '';
    throw new Error(
      `Category '${value}' matches no category id, and no transaction in the date range ` +
        `carries it. The filter takes a category id, not a name: pass an id from ` +
        `${opts.listTool}.${suggestion}`
    );
  }

  const childrenOf = new Map<string, string[]>();
  for (const c of categories) {
    if (c.parentId === null) continue;
    const siblings = childrenOf.get(c.parentId) ?? [];
    siblings.push(c.id);
    childrenOf.set(c.parentId, siblings);
  }

  const selected = new Set<string>();
  const queue: string[] = [value];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    if (selected.has(id)) continue; // a cycle in bad data must not loop forever
    selected.add(id);
    queue.push(...(childrenOf.get(id) ?? []));
  }
  return selected;
}

/** The `category` parameter description, shared by both tools. */
export function categoryFilterDescription(listTool: string): string {
  return (
    `Filter by category ID from ${listTool} (exact match, not a name). A parent ` +
    "category's id also returns its subcategories' rows. An id that belongs to no " +
    'category and to no transaction in the date range is an error.'
  );
}
