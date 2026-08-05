// A tiny per-key async serializer. `run(key, fn)` executes `fn` strictly AFTER any prior
// run for the SAME key has settled, so calls that share a key run one-at-a-time; different
// keys never contend. It closes the read-check-write (TOCTOU) window that every value-moving
// path in this package shares — two concurrent callers both pass the "already done?" check and
// each act. Lives at the package root, not under `ceremony/`: it is a generic primitive, not an
// authorization rail, and both a rail and the grants facade depend on it (#140).
//
// Two callers today, keyed differently but for the same reason:
//   - `ceremony/completion.ts` (#103), keyed by ORDER id — two overlapping verifies for one
//     order must not both miss the "already completed?" check and each call the processor's
//     `settle`. Serialized, the loser sees the record the winner wrote and takes the
//     idempotent echo instead of settling again.
//   - `grants.ts` (#104), keyed by GRANT id — two concurrent same-key spends must not both
//     miss the idempotency cache and reach the engine, leaving the loser to come back
//     `consumed` and be misreported as `revoked`. Revocation must also win mid-spend.
//
// IN-PROCESS ONLY. A lock in one Node process says nothing to another instance, so a
// multi-instance / serverless deploy must ALSO rely on an idempotent settle (see
// `DelegatedVerifier.settle` — idempotent by `reference`) or a shared store + CAS. This is the
// belt; that is the suspenders.
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
