import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

createServer((request, response) => {
  if (request.url === '/upload') {
    let bytes = 0;
    const hash = createHash('sha256');
    request.on('data', (chunk) => { bytes += chunk.length; hash.update(chunk); });
    request.on('end', () => response.end(JSON.stringify({ bytes, hash: hash.digest('hex') })));
    return;
  }
  if (request.url === '/delayed' || request.url === '/gap') {
    if (request.url === '/gap') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: start\n\n');
    }
    const timer = setTimeout(() => response.end('data: end\n\n'), 130_000);
    response.on('close', () => clearTimeout(timer));
    return;
  }
  if (request.url === '/cookies') {
    response.writeHead(200, { 'set-cookie': ['pneuma-space-control=forged; Path=/', '__Host-pneuma-space-app=forged; Secure; Path=/', 'application=kept; Path=/'] });
    return response.end('cookies');
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${request.headers['x-pneuma-space-subject']}\n\n`);
  const timer = setInterval(() => response.write(': heartbeat\n\n'), 1000);
  response.on('close', () => clearInterval(timer));
}).listen(Number(process.env.PNEUMA_SPACE_PORT), '0.0.0.0');

process.on('SIGTERM', () => process.exit(0));
