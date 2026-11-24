# Native persistence

The manifest at the project root declares contract pneuma-space.cf/1, runtime node, an entry relative to app/, and capability objects. Node listens on PNEUMA_SPACE_PORT. app/ is prebuilt code, not a build service. Public Internet egress is disabled; native services use this intercepted host:

```js
const response = await fetch('http://pneuma-space.internal/broker', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(command)
});
const value = await response.json();
if (!response.ok) throw Object.assign(new Error(value.error.message), { status: response.status });
```

Declare kv for JSON state. Commands: `{type:'kv.get',key}` returns `{value,revision,expiresAt}` or null. `{type:'kv.put',key,value,expected}` returns a new revision. Use expected:null for create-only or the previous numeric revision for compare-and-swap;409 means reload before retrying. `{type:'kv.delete',key,expected?}` removes a key. `{type:'kv.list',prefix?}` returns items and an optional nextCursor. `{type:'kv.increment',key,amount}` is atomic.

Declare db for SQLite. `{type:'db.query',sql,params:[]}` returns rows, columns and row counts. `{type:'db.batch',statements:[{sql,params:[]}]}` is atomic. Use one statement per query, parameters for values, and small bounded results. Platform lifecycle state is not in the application's SQL namespace.

Declare files for small durable documents. `{type:'files.put',path,body,expected?}` stores base64 up to64KiB; `{type:'files.get',path}` reads it. Larger objects use object upload/download tickets and direct browser-to-R2 transfer; never proxy object bytes through the app.

The starter needs only kv and identity. Its one collection is limited to24 entries and16KiB of JSON. Filter/search in the browser and avoid polling so the app can become idle. The benchmark proof marker is a separate small key and does not change the user's collection.

The app lives at `/apps/<name>/` on the workspace origin, which it shares with the workspace and every other app. Requests reach the server with that prefix removed and an `X-Forwarded-Prefix: /apps/<name>` header. Use relative URLs for pages, assets, API calls and WebSockets (`api/items`, not `/api/items`), and add the prefix to any absolute path the server writes, such as a redirect. `_pneuma-space/` is reserved under the prefix.

Requests arrive with platform-provided X-Pneuma-Space-Subject/Name/Owner headers when identity is declared. Framework or dependency additions must fit the4MiB package limit. The CLI publishes only app/; credentials and project instructions live outside it.
