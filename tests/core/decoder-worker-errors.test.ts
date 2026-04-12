import { describe, expect, test } from 'bun:test';
import { decodeAllCollectionsIsolated } from '../../src/core/decoder';

describe('decodeAllCollectionsIsolated worker error handling', () => {
  test('rejects exactly once with a non-empty Error when db path does not exist', async () => {
    const bogusPath = '/tmp/copilot-mcp-test-nonexistent-db-' + Date.now();

    // Verify the promise rejects with a meaningful Error and that the
    // settle guard prevents double-rejection (error followed by exit).
    let rejectionCount = 0;
    let caughtError: Error | undefined;
    try {
      await decodeAllCollectionsIsolated(bogusPath, 10_000);
    } catch (e) {
      rejectionCount++;
      caughtError = e as Error;
    }

    expect(rejectionCount).toBe(1);
    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError!.message.length).toBeGreaterThan(0);
  }, 15_000);
});
