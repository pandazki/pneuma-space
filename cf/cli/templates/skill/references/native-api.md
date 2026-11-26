# Native persistence

The manifest at the project root declares contract pneuma-space.cf/1, runtime node, an entry relative to app/, and capability objects. Node listens on PNEUMA_SPACE_PORT. app/ is prebuilt code, not a build service. Public Internet egress is disabled; native services use this intercepted host:

```js
const response = await fetch('http://pneuma-space.internal/broker', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(command)
});
const value = await response.json();
if (!response.ok) throw Object.assign(new Error(value.error.message), { status: response.status, code: value.error.code });
```

A refusal answers a 4xx or 5xx status with `{error:{code,message}}`, such as 400 `input` for a malformed field, 403 `capability` for a capability the manifest does not declare, 413 `body_limit` for a command over 256 KiB and 429 `storage_quota`. Times such as `expiresAt` are milliseconds since the epoch.

Declare kv for JSON state. A key is 1 to 300 characters without control characters.

| Command | Reply |
| --- | --- |
| `{type:'kv.get',key}` | `{key,value,revision,expiresAt}`, or `null` when absent or expired |
| `{type:'kv.put',key,value,expected?,ttl?}` | `{value,revision}` |
| `{type:'kv.delete',key,expected?}` | `{deleted}`, false when absent |
| `{type:'kv.list',prefix?,cursor?}` | `{items,nextCursor?}`, each item `{key,value,revision,expiresAt}` |
| `{type:'kv.increment',key,amount}` | `{value,revision}` |
| `{type:'kv.publish',channel,value}` | `{subscribers}`, how many received it |

Use expected:null for create-only or the previous numeric revision for compare-and-swap; 409 `revision` means reload before retrying. One counter per app issues the revisions of every key and file, so a key's revision grows but not by one. `ttl` is 1 to 31536000 seconds; a put without it clears the expiry. Increment is atomic: `amount` is a required integer, a missing key starts at 0, a non-numeric value answers 409 `value_type`. Publish sends the value as JSON text to the channel's WebSocket subscribers: Node at `ws://pneuma-space.internal/subscribe/<channel>`, a page at `_pneuma-space/realtime/<channel>` under the app's prefix.

A list returns items in key order, at most 100 and 256 KiB of JSON per page. `nextCursor` is present only while more items follow: repeat the command with the same `prefix` and `cursor:nextCursor`. A cursor that does not belong to that listing answers 400 `cursor`. files.list and object.list page the same way.

Declare db for SQLite.

| Command | Reply |
| --- | --- |
| `{type:'db.query',sql,params:[]}` | `{rows,columns,rowsRead,rowsWritten}`, each row an object keyed by column, blobs as base64 |
| `{type:'db.batch',statements:[{sql,params:[]}]}` | `{results}`, one db.query reply per statement |

A batch of 1 to 32 statements is atomic. Use one statement per query, parameters for values, and small bounded results: over 1000 rows or 256 KiB answers 413 `result_limit`. Platform lifecycle state is not in the application's SQL namespace.

Declare files for small durable documents. A path is relative, 1 to 300 characters, without backslashes or empty, `.` or `..` segments.

| Command | Reply |
| --- | --- |
| `{type:'files.put',path,body,expected?}` | `{path,body,revision,bytes}` |
| `{type:'files.get',path}` | `{path,body,revision,bytes}`, or `null` when absent |
| `{type:'files.list',prefix?,cursor?}` | `{items,nextCursor?}`, each item `{path,body,revision,bytes}` |
| `{type:'files.delete',path,expected?}` | `{deleted}`, false when absent |

`body` is base64 of at most 64 KiB and `bytes` its decoded length; `expected` works as for kv. List items carry their bodies, so a page may hold only two large files.

Declare object for larger files. Object bytes move directly between the browser and R2 with tickets; never proxy them through the app. A key follows the path rule of files.

| Command | Reply |
| --- | --- |
| `{type:'object.upload',key,bytes,contentType}` | `{id,url,headers,expiresAt}`: PUT exactly `bytes` bytes to `url` with `headers` |
| `{type:'object.complete',id}` | `{key,bytes,contentType,etag,uploadedAt}` |
| `{type:'object.download',key}` | `{id,url,headers,expiresAt}`: GET `url`; `id` is the key |
| `{type:'object.list',prefix?,cursor?}` | `{items,nextCursor?}`, each item `{key,bytes,contentType,etag,uploadedAt}` |
| `{type:'object.delete',key}` | `{deleted}` |

An object is at most 100 MiB and a ticket lasts 300 seconds. Complete answers 409 `upload_missing` until the bytes reach R2 and 409 `upload_metadata` if their size or content type differs.

Declare rtc for TURN relays.

| Command | Reply |
| --- | --- |
| `{type:'rtc.credentials'}` | `{iceServers,expiresAt}`, each server `{urls,username?,credential?}`, valid 600 seconds |

Declare static with a directory inside app/ for the page shell. A GET or HEAD for a file in that directory is answered from storage without starting Node, even while the app sleeps; a path ending in `/` serves that directory's `index.html`. Every other request reaches Node. The starter declares static, kv and identity. Its one collection is limited to 24 entries and 16 KiB of JSON. Filter/search in the browser and avoid polling so the app can become idle. The benchmark proof marker is a separate small key and does not change the user's collection.

The app lives at `/apps/<name>/` on the workspace origin, which it shares with the workspace and every other app. Requests reach the server with that prefix removed and an `X-Forwarded-Prefix: /apps/<name>` header. Use relative URLs for pages, assets, API calls and WebSockets (`api/items`, not `/api/items`); a root path such as `/style.css` answers 404. Add the prefix to any absolute path the server writes, such as a redirect. `_pneuma-space/` is reserved under the prefix.

Requests arrive with platform-provided X-Pneuma-Space-Subject/Name/Owner headers when identity is declared. Framework or dependency additions must fit the 4 MiB package limit. The CLI publishes only app/; credentials and project instructions live outside it.
