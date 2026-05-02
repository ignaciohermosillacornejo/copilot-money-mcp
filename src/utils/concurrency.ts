/**
 * Bounded-concurrency promise pool.
 *
 * Returns a function `limit(fn)` that runs at most `concurrency` callbacks
 * concurrently. Excess callers are queued FIFO. A rejection in one task
 * does not affect other queued or in-flight tasks; the slot is released
 * regardless of settlement outcome.
 */
export function pLimit(concurrency: number) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`pLimit: concurrency must be a positive integer (got ${concurrency})`);
  }
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active -= 1;
    queue.shift()?.();
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active += 1;
        fn().then(
          (value) => {
            resolve(value);
            next();
          },
          (err: unknown) => {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- pLimit is a transparent wrapper; preserve caller's rejection value verbatim.
            reject(err);
            next();
          }
        );
      };
      if (active < concurrency) {
        run();
      } else {
        queue.push(run);
      }
    });
}
