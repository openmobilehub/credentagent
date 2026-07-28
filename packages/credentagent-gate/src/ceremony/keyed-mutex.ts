// A tiny per-key async serializer. `run(key, fn)` executes `fn` strictly AFTER any prior
// run for the SAME key has settled, so calls that share a key run one-at-a-time; different
// keys never contend. Used to close the concurrent double-settle window in `completeOrder`
// (#103): two overlapping verifies for one order must not both pass the "already completed?"
// check and each call the processor's `settle` — serializing them per order id makes the
// loser see the record the winner wrote and take the idempotent echo instead of settling again.
//
// IN-PROCESS ONLY. A lock in one Node process says nothing to another instance, so a
// multi-instance / serverless deploy must ALSO rely on an idempotent settle (see
// `DelegatedVerifier.settle` — idempotent by `reference`). This is the belt; that is the
// suspenders.
export class KeyedMutex {
  // The tail promise per key: the next caller chains onto it and awaits its settlement.
  // Failure-swallowed so one run's rejection never blocks the queue behind it.
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    // Run once the previous run for this key settles — whether it resolved or rejected
    // (both branches call `fn`), so a thrown completion can't wedge the lock.
    const result = prev.then(fn, fn);
    // The next caller waits on THIS run; store a failure-swallowed tail so its rejection
    // doesn't poison the chain, and drop the key once nothing newer is queued behind it.
    const tail = result.then(
      () => {},
      () => {},
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
