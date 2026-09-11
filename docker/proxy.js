// ============================================================
// وكيل Node.js خفيف — بديل Caddy (Render يمنع تشغيل الثنائيات الخارجية)
// يوزع الطلبات على المنفذ الخارجي:
//   /socket.io/* → خدمة الرسائل (CHAT_PORT، افتراضي 3003) + ترقية WebSocket
//   الباقي      → واجهة Next.js (NEXT_PORT، افتراضي 3000)
// ============================================================
const http = require('http');
const net = require('net');

const PORT = Number(process.env.PORT || 7860);
const NEXT_PORT = Number(process.env.NEXT_PORT || 3000);
const CHAT_PORT = Number(process.env.CHAT_PORT || 3003);

function isChatRequest(url) {
  return url.startsWith('/socket.io');
}

// طلبات HTTP العادية
const server = http.createServer((req, res) => {
  const target = isChatRequest(req.url)
    ? { host: '127.0.0.1', port: CHAT_PORT }
    : { host: '127.0.0.1', port: NEXT_PORT };

  const headers = { ...req.headers };
  headers['x-forwarded-for'] = req.socket.remoteAddress || '';
  headers['x-forwarded-proto'] = 'https';

  const upstream = http.request(
    { host: target.host, port: target.port, path: req.url, method: req.method, headers },
    (uRes) => {
      res.writeHead(uRes.statusCode || 502, uRes.headers);
      uRes.pipe(res);
    }
  );

  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end('Bad gateway');
  });

  req.pipe(upstream);
});

// ترقية WebSocket (socket.io + مكالمات الويب)
server.on('upgrade', (req, socket, head) => {
  const target = isChatRequest(req.url) ? CHAT_PORT : NEXT_PORT;
  const upstream = net.connect(target, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  const cleanup = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on('error', cleanup);
  socket.on('error', cleanup);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[proxy] يعمل على :${PORT} — /socket.io/* ← :${CHAT_PORT} | الباقي ← :${NEXT_PORT}`);
});
