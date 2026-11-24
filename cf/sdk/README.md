# Native application SDK

Import `space` from `sdk/index.ts` in a prebundled Node package. Declare each used capability in the manifest. The runtime supplies the application identity and execution generation through trusted interception.

```ts
const result = await space.db.query('SELECT body FROM notes WHERE id = ?', [1]);
const saved = await space.kv.put('count', 1, { expected: null, ttl: 60 });
await space.kv.put('count', 2, { expected: saved.revision });
await space.files.put('draft.txt', new TextEncoder().encode('durable'));
```

`files.get` returns base64 bytes and a revision. `space.files.bytes(file)` decodes them. A file is limited to 64 KiB. SQL queries return rows, column names and read/write counters; batches are atomic. SQL blob results are base64 strings. Lists return `items` and an optional `nextCursor`. Pass that cursor unchanged to the next list call with the same prefix.

`space.subscribe(channel)` returns a native WebSocket. Wait for its `open` event before publishing. Messages contain JSON values. Pub/sub is live and has no replay.

```ts
const ticket = await space.objects.upload({ key: 'photo.jpg', bytes: file.size, contentType: file.type });
// Give this ticket to the browser. Object bytes must travel directly between the browser and R2.
await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: file });
const metadata = await space.objects.complete(ticket.id);
```

The PUT body must have a known length matching the declared bytes, such as a browser File or Blob. Its automatically supplied Content-Length is part of the signature. Do not set a Content-Length header in browser JavaScript. The application's server handles only tickets and metadata. Download tickets likewise go to the browser. Signed URLs are bearer grants until expiry. Deleting an object removes its metadata; outstanding upload tickets can still write their immutable R2 key until expiry. Purge waits for ticket expiry and cleans again.

`space.rtc.credentials()` returns expiring ICE servers from the configured TURN provider. It fails when unavailable. No cloud account credentials enter the SDK.
