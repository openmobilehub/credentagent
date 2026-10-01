// Cart updates from the picker, one at a time.
//
// Each quantity change is a read-modify-write of the cart on the server. Two quick clicks sent at
// once would both read the same cart and the second write would erase the first — and on a picker
// with no cart id yet, each would start a cart of its own. Queued, each call starts only after the
// previous one answered, so it reads the cart (and the cart id) that answer left behind.
//
// Replies also come back in order, but only the NEWEST one should repaint the picker: an older
// reply describes the cart before the user's later clicks, which the picker already shows
// optimistically.
//
//   const enqueue = updateQueue();
//   const { value, latest } = await enqueue(() => callTheServer());
//   if (latest) render(value);

export interface Queued<T> {
  value: T;
  /** False when another update was queued after this one — its reply is already out of date. */
  latest: boolean;
}

export function updateQueue(): <T>(task: () => Promise<T>) => Promise<Queued<T>> {
  let tail: Promise<unknown> = Promise.resolve();
  let newest = 0;
  return <T>(task: () => Promise<T>) => {
    const seq = ++newest;
    const run = tail.then(task).then((value) => ({ value, latest: seq === newest }));
    tail = run.catch(() => undefined); // a failed update must not block the ones after it
    return run;
  };
}
