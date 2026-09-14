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
import { cleanupAllTempDatabases } from './leveldb-reader.js';

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

  let message: { type: 'result'; data: unknown } | { type: 'error'; message: string };
  try {
    message = { type: 'result', data: await decodeAllCollections(dbPath) };
  } catch (error) {
    message = {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // PERFORM the cleanup here rather than leaving it to be performed later,
    // and do it BEFORE the result goes back: the parent resolves the moment it
    // receives the message, and this thread can be torn down mid-statement
    // immediately afterwards. A sweep placed after the postMessage was
    // observed starting and never finishing.
    //
    // Nothing else reclaims this thread's temp copy. The TTL timer is unref'd,
    // and `process.on('exit')` reaches neither the `worker.terminate()` path
    // the decode timeout takes nor a worker thread under bun at all — measured
    // as copies stranded in $TMPDIR by every decode a `bun test` run performs.
    // #631 established the lesson (release, do not schedule); #642 found the
    // one place in the read path where it had not been applied.
    //
    // The sweep sits between a completed decode and its postMessage, so it is
    // now inside the parent's decode-timeout budget (`getDecodeTimeoutMs`,
    // which is not cleared until the message lands). An rmSync of a copied
    // LevelDB is nowhere near that budget, and the alternative is a guaranteed
    // leak — but it is a real term in it, deliberately.
    //
    // Wrapped, because "a completed decode always posts its result" must not
    // become conditional on a callee's internals: `cleanupTempDatabase`
    // swallows its own rmSync failures today, and if anything added here later
    // threw, a successful decode would reach the parent as
    // "worker exited without sending result".
    try {
      cleanupAllTempDatabases();
    } catch {
      // Never let cleanup cost the caller a result it already has.
    }
  }

  port.postMessage(message);
}

void main();
