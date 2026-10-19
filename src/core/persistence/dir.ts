import { homedir } from 'os';
import { join } from 'path';

/**
 * Where the server's persistent per-uid stores live by default: the routing-id
 * index (TransactionMetaStore, #511) and the split-parent record
 * (SplitParentStore, #842). One directory, so the two never drift apart.
 */
export function defaultPersistenceDir(): string {
  return join(homedir(), '.claude', 'copilot-money');
}
