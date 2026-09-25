#!/usr/bin/env bash
# ============================================================
# تحديث البرنامج على السيرفر لآخر إصدار من GitHub — بأمر واحد
# الاستخدام:  sudo bash update.sh
# آمن: لا يمس قاعدة البيانات ولا الرسائل ولا ملفات الصوت
# ============================================================
set -euo pipefail
APP_DIR="/opt/instant-chat"

[ "$(id -u)" -eq 0 ] || { echo "❌ شغّل السكربت بـ sudo"; exit 1; }

echo "→ جلب آخر إصدار..."
cd "$APP_DIR"
git fetch origin
git reset --hard origin/main
echo "   النسخة الآن: $(git log --oneline -1)"

echo "→ تحديث الاعتماديات والبناء..."
npm install --no-audit --no-fund
npx prisma db push
npm run build
cd "$APP_DIR/mini-services/chat-service"
npm install --no-audit --no-fund
npx prisma generate

echo "→ إعادة تشغيل الخدمتين..."
systemctl restart instant-chat-web instant-chat-socket

echo "✅ تم التحديث — https://$(awk 'NR>2{sub(/ {.*/,"");print;exit}' /etc/caddy/Caddyfile 2>/dev/null || echo 'دومينك')"
