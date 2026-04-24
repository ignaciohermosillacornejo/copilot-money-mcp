import { describe, test, expect, mock } from 'bun:test';
import { LiveTransactionsTools } from '../../../src/tools/live/transactions.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import type { CopilotDatabase } from '../../../src/core/database.js';

function mkLive(): LiveCopilotDatabase {
  const client = { mutate: mock(), query: mock() } as unknown as GraphQLClient;
  const cache = {
    getAccounts: mock(() => Promise.resolve([])),
    getTags: mock(() => Promise.resolve([])),
    getUserCategories: mock(() => Promise.resolve([])),
    getCategoryNameMap: mock(() => Promise.resolve(new Map<string, string>())),
  } as unknown as CopilotDatabase;
  return new LiveCopilotDatabase(client, cache);
}

describe('LiveTransactionsTools — input validation', () => {
  test('rejects city filter', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ city: 'Brooklyn' } as never)).rejects.toThrow(
      /city.*not supported/i
    );
  });

  test('rejects lat/lon filter', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ lat: 40.7, lon: -74 } as never)).rejects.toThrow(
      /lat.*not supported|lon.*not supported/i
    );
  });

  test('rejects region/country/radius_km filters', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ region: 'NY' } as never)).rejects.toThrow(
      /region.*not supported/i
    );
    await expect(tools.getTransactions({ country: 'US' } as never)).rejects.toThrow(
      /country.*not supported/i
    );
    await expect(tools.getTransactions({ radius_km: 10 } as never)).rejects.toThrow(
      /radius_km.*not supported/i
    );
  });

  test('rejects transaction_type=foreign and =duplicates', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ transaction_type: 'foreign' } as never)).rejects.toThrow(
      /foreign.*not supported/i
    );
    await expect(
      tools.getTransactions({ transaction_type: 'duplicates' } as never)
    ).rejects.toThrow(/duplicates.*not supported/i);
  });

  test('rejects exclude_split_parents=false', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ exclude_split_parents: false } as never)).rejects.toThrow(
      /exclude_split_parents.*not supported/i
    );
  });

  test('rejects transaction_id lookup without account_id+item_id', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ transaction_id: 't1' } as never)).rejects.toThrow(
      /account_id.*item_id/i
    );
  });
});
