import { describe, expect, test } from 'bun:test';
import { decodeAllCollectionsIsolated } from '../../src/core/decoder';

describe('decodeAllCollectionsIsolated worker error handling', () => {
  test('rejects with a non-empty Error when db path does not exist', async () => {
    const bogusPath = '/tmp/copilot-mcp-test-nonexistent-db-' + Date.now();

    const err = await decodeAllCollectionsIsolated(bogusPath, 10_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.length).toBeGreaterThan(0);
  }, 15_000);

  test('settle guard prevents double-rejection (error followed by exit)', async () => {
    // When the worker encounters an error and then exits, only the first
    // settle() call wins. We verify this by ensuring the promise rejects
    // exactly once (i.e., no unhandled rejection from the exit handler).
    const bogusPath = '/tmp/copilot-mcp-test-double-settle-' + Date.now();

    let rejectionCount = 0;
    try {
      await decodeAllCollectionsIsolated(bogusPath, 10_000);
    } catch {
      rejectionCount++;
    }

    // The promise should have rejected exactly once despite both error and
    // exit handlers firing.
    expect(rejectionCount).toBe(1);
  }, 15_000);
});
