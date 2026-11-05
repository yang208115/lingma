import { createServer, request } from 'node:http';

/** Test-only gateway: interrupt the first actual SSE socket, observe native browser reconnect headers. */
export async function startSseTestProxy(port = 4178, target = 4177) {
  const dropped = new Set(),
    connections = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/__test/sse') {
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(
          JSON.stringify(
            connections.filter(
              (item) =>
                !url.searchParams.get('runId') || item.runId === url.searchParams.get('runId'),
            ),
          ),
        );
      return;
    }
    const match = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/events$/);
    const observe = match && !url.searchParams.has('check');
    if (observe)
      connections.push({
        runId: match[1],
        after: url.searchParams.get('after'),
        lastEventId: req.headers['last-event-id'] ?? null,
      });
    const upstream = request(
      {
        hostname: '127.0.0.1',
        port: target,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        if (!observe || dropped.has(match[1]) || response.statusCode !== 200) {
          response.pipe(res);
          return;
        }
        let buffer = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          buffer += chunk;
          for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const frame = buffer.slice(0, end + 2);
            buffer = buffer.slice(end + 2);
            res.write(frame);
            if (/^id: ?\d+/m.test(frame)) {
              dropped.add(match[1]);
              res.end();
              upstream.destroy();
              return;
            }
          }
        });
        response.on('end', () => {
          if (!res.writableEnded) res.end(buffer);
        });
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      if (!res.writableEnded) res.end();
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}
