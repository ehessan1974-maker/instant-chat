#!/bin/sh
# ============================================================
# بدء الحاوية: خدمة الرسائل + الواجهة + وكيل Node
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

# ترقية المخطط القديم بأمان (أعمدة قناة تيليجرام لجدول OtpCode إن لزم)
echo "[start] فحص مخطط قاعدة البيانات..."
node /app/migrate.js || echo "[start] تخطي الترقية"

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
# فحص وقائي: رسالة واضحة في السجلات إن اختلفت مسارات النسخ
if [ ! -f /app/proxy.js ]; then
  echo "[start] خطأ: /app/proxy.js غير موجود — محتويات /app:"
  ls -la /app
  exit 1
fi
exec node /app/proxy.js
