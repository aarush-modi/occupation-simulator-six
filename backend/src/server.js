import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 3001);

const server = createServer((request, response) => {
  const isHealthCheck = request.method === 'GET' && request.url === '/health';
  response.writeHead(isHealthCheck ? 200 : 404, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(isHealthCheck ? { ok: true } : { error: 'Not found' }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Workshift backend listening on port ${server.address().port}`);
});
