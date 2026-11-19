import { createServer } from 'node:http';

createServer((request, response) => {
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
