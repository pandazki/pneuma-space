import { createServer, type ServerResponse } from 'node:http';
import { ADMIN_PATHS, ADMIN_PORT, INGRESS_PORT } from './model.ts';

const network = process.env.PNEUMA_NETWORK ?? 'pneuma';

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

createServer((_request, response) => json(response, 503, { error: 'not implemented' }))
  .listen(INGRESS_PORT, () => console.log(`ingress listening on :${INGRESS_PORT}`));

createServer((request, response) => {
  if (request.method === 'GET' && request.url === ADMIN_PATHS.health) json(response, 200, { ok: true });
  else json(response, 404, { error: 'not found' });
}).listen(ADMIN_PORT, () => console.log(`admin listening on :${ADMIN_PORT}, app network ${network}`));
