// ============================================================
// وكيل Node.js خفيف — بديل Caddy (Render يمنع تشغيل الثنائيات الخارجية)
// يوزع الطلبات على المنفذ الخارجي:
//   /socket.io/* → خدمة الرسائل (CHAT_PORT، افتراضي 3003) + ترقية WebSocket
//   الباقي      → واجهة Next.js (NEXT_PORT، افتراضي 3000)
//
// حماية فحص النشر (Render Timed Out):
//   طلبات فحص الصحة (مسارات health/ping/status أو HEAD أو بلا User-Agent)
//   تُجاب 200 مباشرة من الوكيل — لا تعتمد على أي خدمة أخرى ولا تتجاوز 512MB
// ============================================================
const http = require('http');
const net = require('net');

const PORT = Number(process.env.PORT || 7860);
const NEXT_PORT = Number(process.env.NEXT_PORT || 3000);
const CHAT_PORT = Number(process.env.CHAT_PORT || 3003);

const PROBE_UA = /render|probe|health|monitor|uptime|GoogleHC|kube|loadbalanc|pingdom|uptimerobot|StatusCake|betteruptime/i;
// بادئات مسارات الصحة الشائعة (healthz، healthcheck، readyz، livez...)
const PROBE_PATH = /^\/(api\/)?(_?health|health|ping|status|ready|readiness|liveness|live|up)/;

function isChatRequest(url) {
  return url.startsWith('/socket.io');
}

// هل هذا طلب فحص صحة/نشر؟ نجيب عليه 200 مباشرة دون تمرير
function isProbe(req) {
  const raw = ((req.url || '/').split('?')[0].toLowerCase().replace(/\/+$/, '')) || '/';
  // HEAD: الفاحصات تستخدمه كثيراً والمتصفحات لا تكاد ترسله
  if (req.method === 'HEAD') return true;
  const ua = (req.headers['user-agent'] || '').toString();
  const automated = !ua || PROBE_UA.test(ua);
  // فاحص آلي على الجذر أو أي مسار صحي → جواب فوري
  if (automated && (raw === '/' || PROBE_PATH.test(raw))) {
    return true;
  }
  // مسارات صحة شائعة حتى من عملاء عاديين (التطبيق لا يستخدمها)
  if (PROBE_PATH.test(raw)) {
    return true;
  }
  return false;
}

function answerOk(req, res) {
  const body = req.method === 'HEAD' ? undefined : 'OK';
  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

// طلبات HTTP العادية
const server = http.createServer((req, res) => {
  if (isProbe(req)) {
    answerOk(req, res);
    return;
  }

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

  // فشل سريع بدل تعليق الفاحص دقائق
  upstream.setTimeout(30000, () => upstream.destroy(new Error('upstream timeout')));

  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end('Bad gateway');
  });

  req.pipe(upstream);
});

// متانة الاتصالات: مهل معقولة بدل افتراضيات Node الطويلة
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 120000;

// طلبات HTTP تالفة: رد واضح بدل انهيار المقبض
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
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

// إصغاء مزدوج المكدس (IPv6 + IPv4) مع تراجع آمن لـ IPv4 فقط
server.on('error', (e) => {
  if (e.code === 'EAFNOSUPPORT' || e.code === 'EADDRNOTAVAIL') {
    console.log('[proxy] تعذر إصغاء مزدوج المكدس — التراجع إلى 0.0.0.0');
    server.listen(PORT, '0.0.0.0');
  } else {
    throw e;
  }
});

server.listen(PORT, () => {
  console.log(`[proxy] يعمل على :${PORT} — /socket.io/* ← :${CHAT_PORT} | الباقي ← :${NEXT_PORT} | فحوصات الصحة ← 200 مباشرة`);
});
