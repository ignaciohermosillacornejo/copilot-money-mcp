/**
 * Worker thread for decoding LevelDB data.
 *
 * This worker isolates classic-level's native memory allocations from the main thread.
 * When the worker terminates, its entire V8 isolate is destroyed, which frees ALL
 * native-allocated ArrayBuffers — including those that classic-level's block cache
 * retains as weak references and that V8's GC never collects due to low heap pressure.
 *
 * Without this isolation, each cache refresh leaks ~7MB of 256KB ArrayBuffers
 * (classic-level's block cache buffers), accumulating ~88MB/hour.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { decodeAllCollections } from './decoder.js';

interface WorkerInput {
  dbPath: string;
}

async function main(): Promise<void> {
  if (!parentPort) {
    throw new Error('decode-worker must be run as a worker thread');
  }

  if (!workerData || typeof (workerData as Record<string, unknown>).dbPath !== 'string') {
    throw new Error('decode-worker: invalid workerData — expected { dbPath: string }');
  }

  const { dbPath } = workerData as WorkerInput;
  const port = parentPort;

  try {
    const result = await decodeAllCollections(dbPath);
    port.postMessage({ type: 'result', data: result });
  } catch (error) {
    port.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

void main();
