// ============================================================
// خادم مخصص: Next.js + Socket.IO في عملية واحدة وعلى منفذ واحد
// ============================================================
// لماذا؟ خدمة الشات كانت mini-service على منفذ 3003 — وهذا لا
// يعمل على Render (منفذ واحد) ولا في معاينة الساندبوكس عبر البوابة.
// الآن: الويب والـ API والمحادثة الحيّة كلها من نفس الأصل، وتطبيق
// APK القديم io(url) يجد خدمته على /socket.io تلقائياً.
//
// التشغيل: bun server.ts   (تطوير: NODE_ENV غير محجوز، إنتاج: NODE_ENV=production)

import { createServer } from 'http'
import next from 'next'
import { Server } from 'socket.io'
import { initChatIo } from './src/server/chat-io'

const port = Number(process.env.PORT || 3000)
const dev = process.env.NODE_ENV !== 'production'

const app = next({ dev, dir: import.meta.dir })

await app.prepare()
const requestHandler = app.getRequestHandler()
const upgradeHandler = app.getUpgradeHandler()

const server = createServer((req, res) => {
  requestHandler(req, res).catch((err) => {
    console.error('[server] request error:', err)
    res.statusCode = 500
    res.end('internal server error')
  })
})

// Socket.IO على نفس الخادم — المسار الافتراضي /socket.io يخدم الويب وAPK القديم
const io = new Server(server, {
  path: '/socket.io',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  // حاسم أثناء التطوير: لا تدمر ترقيات WebSocket الغريبة عنك
  // (خادم Next يحتاجها لـ HMR على /_next/webpack-hmr)
  destroyUpgrade: false,
})

initChatIo(io)

// توجيه ترقيات WebSocket: socket.io يتكفل بـ /socket.io (مستمعه الخاص)،
// وكل ما عدا ذلك يذهب إلى معالج Next (HMR وأي ترقيات مستقبلية)
server.on('upgrade', (req, socket, head) => {
  const url = req.url || ''
  if (url.startsWith('/socket.io')) return
  upgradeHandler(req, socket, head)
})

server.listen(port, () => {
  console.log(
    `[server] ready on :${port} (${dev ? 'development' : 'production'}) — Next + Socket.IO في عملية واحدة`
  )
})

function shutdown(signal: string): void {
  console.log(`[server] received ${signal}, shutting down...`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
