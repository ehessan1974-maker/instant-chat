#!/bin/sh
# ============================================================
# بدء الحاوية: خدمة الرسائل + الواجهة + وكيل Caddy
# كل البيانات في /app/db (قاعدة SQLite + ملفات الصوت)
# ============================================================
set -e

echo "[start] تحضير قاعدة البيانات..."
mkdir -p /app/db/voice

# أول تشغيل: نسخ قاعدة بيانات نظيفة بالهيكل الصحيح
if [ ! -f /app/db/custom.db ]; then
  cp /seed/custom.db /app/db/custom.db
fi

export DATABASE_URL="file:/app/db/custom.db"
export VOICE_DIR="/app/db/voice"

# 1) خدمة الرسائل على 3003
echo "[start] تشغيل خدمة الرسائل على 3003..."
cd /app/chat-service
CHAT_PORT=3003 PORT=3003 ./node_modules/.bin/tsx index.ts &

# 2) واجهة Next.js على 3000
echo "[start] تشغيل واجهة Next.js على 3000..."
cd /app
PORT=3000 HOSTNAME=127.0.0.1 node server.js &

# 3) وكيل Node.js على المنفذ الخارجي (يعمل في المقدمة)
echo "[start] تشغيل وكيل Node على المنفذ ${PORT:-7860}..."
exec node /app/proxy.js
