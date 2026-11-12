export default {
  async fetch(request, app) {
    if (new URL(request.url).pathname !== '/api/count') return new Response('Not found.', { status: 404 });
    if (!['GET', 'POST'].includes(request.method)) return new Response(null, { status: 405 });
    for (let attempt = 0; attempt < 3; attempt++) {
      const record = await app.records.get('count');
      const count = record?.value ?? 0;
      if (request.method === 'GET') return Response.json({ count, name: app.identity.name, release: app.release });
      const result = await app.records.commit([{ kind: 'put', key: 'count', expected: record?.revision ?? null, value: count + 1 }]);
      if (result.ok) return Response.json({ count: count + 1, name: app.identity.name, release: app.release });
    }
    return new Response('Please try again.', { status: 409 });
  },
};
