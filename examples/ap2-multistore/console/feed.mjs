// console/feed.mjs — one store's live activity: an in-memory event log, and the Server-Sent Events
// stream its back office reads. Example glue, not library API.
//
// A reconnecting page sends Last-Event-ID, so it receives only what it missed — never a duplicate.
// A named `ping` every 10 s lets the page show "Live" only while it is actually hearing from the store.

export function createFeed({ keep = 200 } = {}) {
  const events = [];
  const clients = new Set();
  let seq = 0;
  const send = (res, e) => res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);

  return {
    emit(type, data = {}) {
      const event = { id: ++seq, at: new Date().toISOString(), type, ...data };
      events.push(event);
      if (events.length > keep) events.shift();
      for (const res of clients) send(res, event);
      return event;
    },
    history: () => events.slice(),
    stream(req, res) {
      res.set({ "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.flushHeaders();
      const after = Number(req.get("last-event-id") ?? 0);
      for (const e of events) if (e.id > after) send(res, e);
      clients.add(res);
      const ping = setInterval(() => res.write(`event: ping\ndata: {}\n\n`), 10_000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
    },
  };
}
