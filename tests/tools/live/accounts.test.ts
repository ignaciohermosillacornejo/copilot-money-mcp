import { describe, expect, test, mock } from 'bun:test';
import {
  LiveAccountsTools,
  createLiveAccountsToolSchema,
} from '../../../src/tools/live/accounts.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import type { CopilotDatabase } from '../../../src/core/database.js';
import type { AccountNode } from '../../../src/core/graphql/queries/accounts.js';
import { getAccountsTool } from '../../../src/tools/registry/accounts-system.js';
import { getAccountsLiveTool } from '../../../src/tools/registry/live.js';
import { TOOL_REGISTRY } from '../../../src/tools/registry/index.js';
import { ACCOUNT_KNOWN_FIELDS } from '../../../src/tools/tools.js';
import { ACCOUNT_LIVE_KNOWN_FIELDS } from '../../../src/tools/live/accounts.js';

const A = (id: string, opts: Partial<AccountNode> = {}): AccountNode => ({
  id,
  itemId: 'item1',
  name: `Account ${id}`,
  balance: 100,
  liveBalance: true,
  type: 'DEPOSITORY',
  subType: 'checking',
  mask: '0001',
  isUserHidden: false,
  isUserClosed: false,
  isManual: false,
  color: null,
  limit: null,
  institutionId: 'inst1',
  hasHistoricalUpdates: true,
  hasLiveBalance: true,
  latestBalanceUpdate: 1_745_539_200_000,
  ...opts,
});

const mkClientReturning = (rows: AccountNode[]): GraphQLClient =>
  ({
    query: mock(async () => ({ accounts: rows })),
  }) as unknown as GraphQLClient;

const mkLive = (rows: AccountNode[]): LiveCopilotDatabase =>
  new LiveCopilotDatabase(mkClientReturning(rows), {} as CopilotDatabase);

describe('LiveAccountsTools.getAccounts', () => {
  test('first call: cache miss, returns rows with _cache_hit: false', async () => {
    const live = mkLive([A('a'), A('b')]);
    const tools = new LiveAccountsTools(live);

    const result = await tools.getAccounts({});

    expect(result._cache_hit).toBe(false);
    expect(result.count).toBe(2);
    expect(typeof result._cache_oldest_fetched_at).toBe('string');
    expect(result._cache_oldest_fetched_at).toBe(result._cache_newest_fetched_at);
  });

  test('second call: cache hit, no GraphQL call, _cache_hit: true', async () => {
    const client = mkClientReturning([A('a')]);
    const live = new LiveCopilotDatabase(client, {} as CopilotDatabase);
    const tools = new LiveAccountsTools(live);

    await tools.getAccounts({});
    const second = await tools.getAccounts({});

    expect(second._cache_hit).toBe(true);
    expect((client.query as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  test('include_hidden=false (default) filters hidden and closed accounts', async () => {
    const live = mkLive([A('a'), A('b', { isUserHidden: true }), A('c', { isUserClosed: true })]);
    const tools = new LiveAccountsTools(live);

    const result = await tools.getAccounts({ include_hidden: false });
    expect(result.count).toBe(1);
    expect(result.accounts[0]?.id).toBe('a');
  });

  test('include_hidden=true returns all', async () => {
    const live = mkLive([A('a'), A('b', { isUserHidden: true })]);
    const tools = new LiveAccountsTools(live);

    const result = await tools.getAccounts({ include_hidden: true });
    expect(result.count).toBe(2);
  });

  test('include_hidden=true: default rows still discriminate hidden/closed from active', async () => {
    // The flags `include_hidden` toggles must survive projection, or opting in
    // returns rows a caller cannot tell apart. `isUserClosed` was the gap: a
    // closed account came back shape-identical to an active one while the
    // totals counted it.
    const live = mkLive([
      A('active'),
      A('hidden', { isUserHidden: true }),
      A('closed', { isUserClosed: true }),
    ]);
    const tools = new LiveAccountsTools(live);

    const result = await tools.getAccounts({ include_hidden: true });
    const byId = new Map(result.accounts.map((a) => [a.id, a]));

    expect(byId.get('active')).toMatchObject({ isUserHidden: false, isUserClosed: false });
    expect(byId.get('hidden')).toMatchObject({ isUserHidden: true, isUserClosed: false });
    expect(byId.get('closed')).toMatchObject({ isUserHidden: false, isUserClosed: true });
  });

  test('account_type filter applied', async () => {
    const live = mkLive([A('a', { type: 'DEPOSITORY' }), A('b', { type: 'CREDIT' })]);
    const tools = new LiveAccountsTools(live);

    const result = await tools.getAccounts({ account_type: 'credit' });
    expect(result.count).toBe(1);
    expect(result.accounts[0]?.id).toBe('b');
  });

  test('totals calculated correctly: assets minus liabilities', async () => {
    const live = mkLive([
      A('a', { type: 'DEPOSITORY', balance: 1000 }),
      A('b', { type: 'CREDIT', balance: 200 }),
      A('c', { type: 'LOAN', balance: 500 }),
    ]);
    const tools = new LiveAccountsTools(live);

    const result = await tools.getAccounts({});
    expect(result.total_assets).toBe(1000);
    expect(result.total_liabilities).toBe(700); // 200 + 500
    expect(result.total_balance).toBe(300); // 1000 - 700
  });

  test('regression A1: real-shape uppercase types are bucketed correctly', async () => {
    // GraphQL returns Account.type as uppercase enum values ('CREDIT', 'DEPOSITORY',
    // 'LOAN'). Pre-fix code held lowercase in LIABILITY_TYPES, so production saw
    // every credit-card balance summed into total_assets and total_liabilities=0.
    // See docs/superpowers/audits/2026-05-03-live-mode-parity-audit.md § Issue A1.
    const live = mkLive([
      A('chk', { type: 'DEPOSITORY', balance: 5000 }),
      A('cc', { type: 'CREDIT', balance: 1500 }),
      A('ln', { type: 'LOAN', balance: 800 }),
    ]);
    const tools = new LiveAccountsTools(live);

    const result = await tools.getAccounts({});
    expect(result.total_assets).toBe(5000);
    expect(result.total_liabilities).toBe(2300);
    expect(result.total_balance).toBe(2700);
  });

  test('regression A1: account_type filter is case-insensitive', async () => {
    // Real server returns uppercase. Tool description documents lowercase examples
    // ("depository, credit, loan, investment, etc."). Both must work.
    const live = mkLive([A('a', { type: 'DEPOSITORY' }), A('b', { type: 'CREDIT' })]);
    const tools = new LiveAccountsTools(live);

    const lower = await tools.getAccounts({ account_type: 'credit' });
    expect(lower.count).toBe(1);
    expect(lower.accounts[0]?.id).toBe('b');

    const upper = await tools.getAccounts({ account_type: 'CREDIT' });
    expect(upper.count).toBe(1);
    expect(upper.accounts[0]?.id).toBe('b');
  });

  test('regression A2: limit:0 mapped to null for charge cards', async () => {
    // Charge cards have no preset limit; server returns 0, project null to prevent /0.
    // `limit` isn't in the v3 default preset (DEFAULT_ACCOUNT_LIVE_FIELDS), so
    // this test opts in explicitly — the normalization must still apply to a
    // field a caller has to ask for.
    const live = mkLive([
      A('chk', { type: 'DEPOSITORY', balance: 5000, limit: null }),
      A('cc-with-limit', { type: 'CREDIT', balance: 100, limit: 5000 }),
      A('charge', { type: 'CREDIT', balance: 1500, limit: 0 }),
    ]);
    const tools = new LiveAccountsTools(live);
    const result = await tools.getAccounts({ fields: ['default', 'limit'] });

    const charge = result.accounts.find((a) => a.id === 'charge');
    const ccLimit = result.accounts.find((a) => a.id === 'cc-with-limit');
    const chk = result.accounts.find((a) => a.id === 'chk');

    expect(charge?.limit).toBeNull();
    // Sanity: a real-limit credit card retains its limit.
    expect(ccLimit?.limit).toBe(5000);
    // Sanity: depository accounts (already null in fixture) stay null.
    expect(chk?.limit).toBeNull();
  });

  test('`limit` is absent from a default row', async () => {
    // Retitled: this used to claim it proved the limit:0 normalization
    // "survives" projection. It cannot — the normalization rewrites the key it
    // reads, so it is order-invariant w.r.t. projectRows, and this test stays
    // green with the normalization deleted outright (see the call-site
    // comment). What it does pin is that `limit` stays OUT of the default
    // preset; the opt-in test above covers the normalization itself.
    const live = mkLive([A('charge', { type: 'CREDIT', balance: 1500, limit: 0 })]);
    const tools = new LiveAccountsTools(live);
    const result = await tools.getAccounts({});
    expect(result.accounts[0]).not.toHaveProperty('limit');
  });

  test('default rows drop sync/plumbing fields', async () => {
    const live = mkLive([
      A('a', {
        hasHistoricalUpdates: true,
        hasLiveBalance: true,
        liveBalance: true,
        latestBalanceUpdate: 1_745_539_200_000,
        isManual: true,
      }),
    ]);
    const tools = new LiveAccountsTools(live);

    const result = await tools.getAccounts({});
    expect(result.accounts[0]).not.toHaveProperty('hasHistoricalUpdates');
    expect(result.accounts[0]).not.toHaveProperty('hasLiveBalance');
    expect(result.accounts[0]).not.toHaveProperty('liveBalance');
    expect(result.accounts[0]).not.toHaveProperty('latestBalanceUpdate');
    expect(result.accounts[0]).not.toHaveProperty('isManual');
    // Everything in the preset survives.
    expect(result.accounts[0]).toMatchObject({
      id: 'a',
      name: 'Account a',
      type: 'DEPOSITORY',
      subType: 'checking',
      balance: 100,
      institutionId: 'inst1',
      itemId: 'item1',
      isUserHidden: false,
    });
  });

  test('sync/plumbing fields are reachable via an explicit fields request', async () => {
    const live = mkLive([
      A('a', {
        hasHistoricalUpdates: true,
        hasLiveBalance: true,
        liveBalance: true,
        latestBalanceUpdate: 1_745_539_200_000,
        isManual: true,
      }),
    ]);
    const tools = new LiveAccountsTools(live);

    const result = await tools.getAccounts({
      fields: [
        'default',
        'hasHistoricalUpdates',
        'hasLiveBalance',
        'liveBalance',
        'latestBalanceUpdate',
        'isManual',
      ],
    });
    expect(result.accounts[0]?.hasHistoricalUpdates).toBe(true);
    expect(result.accounts[0]?.hasLiveBalance).toBe(true);
    expect(result.accounts[0]?.liveBalance).toBe(true);
    expect(result.accounts[0]?.latestBalanceUpdate).toBe(1_745_539_200_000);
    expect(result.accounts[0]?.isManual).toBe(true);
  });

  test('an unrecognized fields name reports _field_warning', async () => {
    const live = mkLive([A('a')]);
    const tools = new LiveAccountsTools(live);

    const result = await tools.getAccounts({ fields: ['id', 'totally_bogus_field'] });
    expect(result._field_warning).toContain('totally_bogus_field');
  });

  test('_field_warning fires even on an empty result set (knownFields, not row-key fallback)', async () => {
    // Without ACCOUNT_LIVE_KNOWN_FIELDS wired, unknown-name detection falls
    // back to checking requested names against the returned ROWS' own keys —
    // which stays silent when there are no rows to check against. A
    // non-matching account_type filter is the one condition that
    // distinguishes the two. Same reasoning as the get_recurring_live fix in
    // #606 review.
    const live = mkLive([A('a', { type: 'DEPOSITORY' })]);
    const tools = new LiveAccountsTools(live);

    const result = await tools.getAccounts({
      account_type: 'NO_SUCH_TYPE',
      fields: ['totally_bogus_field'],
    });
    expect(result.count).toBe(0);
    expect(result._field_warning).toContain('totally_bogus_field');
  });

  test('"all" returns the full row, including sync/plumbing fields', async () => {
    const live = mkLive([A('a', { hasHistoricalUpdates: true })]);
    const tools = new LiveAccountsTools(live);

    const result = await tools.getAccounts({ fields: ['all'] });
    expect(result.accounts[0]?.hasHistoricalUpdates).toBe(true);
  });

  test('schema definition exposes filter args', () => {
    const schema = createLiveAccountsToolSchema();
    expect(schema.name).toBe('get_accounts_live');
    expect(schema.inputSchema).toBeDefined();
  });
});

describe('get_accounts_live fields param — parity with get_accounts', () => {
  // Compare through the REGISTRY defs (what the server actually lists), not
  // the shared constant, so forking either side back to a private copy that
  // then drifts fails here. Same pattern as the transactions parity suite in
  // tests/tools/live/transactions.test.ts.
  const cacheFragment = getAccountsTool.schema.inputSchema.properties?.fields;
  const liveFragment = getAccountsLiveTool.schema.inputSchema.properties?.fields;

  test('both tools expose a fields param', () => {
    expect(cacheFragment).toBeDefined();
    expect(liveFragment).toBeDefined();
  });

  test('cache and live account fields descriptions stay in lockstep', () => {
    expect(cacheFragment).toEqual(liveFragment);
  });

  test('the SHARED fragment names no field that exists on NEITHER surface', () => {
    // #709 — the typo half of the rule #707 established for the transactions
    // fragment, ported here because this fragment ships verbatim into both
    // schemas too and had only the equality test above watching it. Equality
    // pins that the two modes say the SAME thing; it says nothing about whether
    // the thing they say is true, so a misspelled field name was identical in
    // both schemas and wrong in both.
    //
    // ONLY the typo half transfers. The mode-parity half — "a name only one
    // surface has is a failure" — cannot: this fragment names `current_balance`
    // and `balance` deliberately, one per mode, because the two account presets
    // share no field names at all (see ACCOUNT_FIELDS_PARAM_SCHEMA's own
    // docstring). Checking each labeled name against the mode it is labeled
    // for is the stronger guard and the one that would catch the two being
    // swapped; it needs the prose parsed for "for get_accounts" / "for
    // get_accounts_live" and is deliberately not attempted here.
    //
    // THE TOOL-NAME EXEMPTION. A verbatim port fails on this fragment: it names
    // four underscored identifiers, and two of them (`get_accounts`,
    // `get_accounts_live`) are TOOL names, fields on neither surface. The
    // transactions fragment happens to name no tool, which is why that guard
    // never needed this. The exemption is the registry's own name→definition
    // map rather than a pair of string literals, so renaming or retiring a tool
    // moves it automatically — a hardcoded pair would be the next stale literal,
    // still green after the name it names is gone.
    const shared = (cacheFragment as { description: string }).description;
    const everyField = new Set([...ACCOUNT_KNOWN_FIELDS, ...ACCOUNT_LIVE_KNOWN_FIELDS]);
    const identifiers = [...new Set(shared.match(/\b[a-z][a-z0-9_]*\b/g) ?? [])];
    const looksLikeAField = identifiers.filter((n) => n.includes('_'));

    const unknownEverywhere = looksLikeAField.filter(
      (n) => !everyField.has(n) && !TOOL_REGISTRY.has(n)
    );
    expect(
      unknownEverywhere,
      `Snake_case names in the shared accounts fields description that are neither a field on ` +
        `either surface nor a registered tool name: ${unknownEverywhere.join(', ')}. The ` +
        `fragment is shared verbatim by get_accounts and get_accounts_live ` +
        `(ACCOUNT_FIELDS_PARAM_SCHEMA), so a typo here ships into BOTH schemas and every ` +
        `caller who copies it gets a _field_warning instead of a field.`
    ).toEqual([]);

    // Guards the gate, four ways, because every one of these can go to zero
    // silently and a filter over an empty list is green: an empty union (a
    // renamed or unexported known-field set), a regex that matches nothing, a
    // fragment that stopped naming fields at all, and an exemption that matches
    // nothing — the last of which fails loudly here rather than quietly
    // widening. Measured as this lands: 45 cache + 17 live = 57 distinct names,
    // and four underscored identifiers, two fields and two tool names.
    //
    // AFTER the assertion above, not before it. A typo'd field name trips the
    // "at least two real fields" floor as well, and when the floor ran first
    // the failure a developer read was `expected >= 2, received 1` instead of
    // the name that was misspelled — the guard detecting the right thing and
    // reporting the wrong one. Verified by mutation in both orders.
    expect(everyField.size).toBeGreaterThan(50);
    expect(looksLikeAField.length).toBeGreaterThanOrEqual(4);
    expect(looksLikeAField.filter((n) => everyField.has(n)).length).toBeGreaterThanOrEqual(2);
    expect(looksLikeAField.filter((n) => TOOL_REGISTRY.has(n)).length).toBeGreaterThanOrEqual(2);

    // Not reachable by the regex, and stated rather than left to be discovered:
    // `\b[a-z]` cannot start a match at a leading underscore, so
    // `_field_warning` in this description is invisible to the filter above —
    // and so would a mistyped `_fild_warning` be.
  });

  test('include_logos does not exist on either schema (retired in v3)', () => {
    expect(getAccountsTool.schema.inputSchema.properties?.include_logos).toBeUndefined();
    expect(getAccountsLiveTool.schema.inputSchema.properties?.include_logos).toBeUndefined();
  });
});
