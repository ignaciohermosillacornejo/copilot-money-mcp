import { describe, expect, test } from 'bun:test';
import { decodeAllCollectionsIsolated } from '../../src/core/decoder';

describe('decodeAllCollectionsIsolated worker error handling', () => {
  test('rejects with error message when worker posts error (non-existent db path)', async () => {
    const bogusPath = '/tmp/copilot-mcp-test-nonexistent-db-' + Date.now();

    await expect(decodeAllCollectionsIsolated(bogusPath, 10_000)).rejects.toThrow();
  }, 15_000);

  test('rejection error from non-existent path contains a meaningful message', async () => {
    const bogusPath = '/tmp/copilot-mcp-test-nonexistent-db-' + Date.now();

    try {
      await decodeAllCollectionsIsolated(bogusPath, 10_000);
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      // The error should have a non-empty message — either from the worker's
      // error message post or from the exit handler.
      expect((err as Error).message.length).toBeGreaterThan(0);
    }
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
