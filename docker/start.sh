#!/bin/sh
# ============================================================
# بدء الحاوية: خدمة الرسائل + الواجهة + وكيل Caddy
# كل البيانات في /app/db (قاعدة SQLite + ملفات الصوت)
# ============================================================
set -e

mkdir -p /app/db/voice

export DATABASE_URL="file:/app/db/custom.db"
export VOICE_DIR="/app/db/voice"

# 1) خدمة الرسائل على 3003
cd /app/chat-service
PORT=3003 npx tsx index.ts &

# 2) واجهة Next.js على 3000
cd /app
PORT=3000 HOSTNAME=127.0.0.1 node server.js &

# 3) وكيل Caddy على المنفذ الخارجي (يعمل في المقدمة)
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
