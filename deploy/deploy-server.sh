#!/usr/bin/env bash
# ============================================================
# نشر «محادثة فورية» على سيرفر VPS — بأمر واحد
# ============================================================
# الاستخدام:
#   sudo bash deploy-server.sh DOMAIN [EMAIL]
# أمثلة:
#   sudo bash deploy-server.sh mychat.duckdns.org
#   sudo bash deploy-server.com chat.example.com me@gmail.com
#
# المتطلبات: سيرفر Ubuntu 22.04/24.04 أو Debian 12، ويعمل الدومين
# (أو سجل DuckDNS) ويشير إلى IP السيرفر قبل التشغيل.
#
# ماذا يفعل؟
#   1) يثبّت Node.js 20 + Caddy + أدوات النظام
#   2) يجهّز ذاكرة Swap (مهم للبناء على السيرفرات الصغيرة)
#   3) يستنسخ البرنامج من GitHub إلى /opt/instant-chat
#   4) يجهّز .env وقاعدة البيانات ويبني نسخة الإنتاج
#   5) ينشئ خدمتين systemd (تشغيل دائم + إعادة تشغيل تلقائية بعد أي انهيار
#      أو إعادة تشغيل للسيرفر)
#   6) يضبط Caddy لشهادة HTTPS تلقائية + تمرير السوكيت
# ============================================================
set -euo pipefail

DOMAIN="${1:?الاستخدام: sudo bash deploy-server.sh DOMAIN [EMAIL]}"
EMAIL="${2:-}"
APP_DIR="/opt/instant-chat"
REPO_URL="https://github.com/ehessan1974-maker/instant-chat.git"

[ "$(id -u)" -eq 0 ] || { echo "❌ شغّل السكربت بـ sudo"; exit 1; }
echo "← الدومين: $DOMAIN"

echo "→ 1/7 تثبيت المتطلبات الأساسية..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y -qq
apt-get install -y -qq curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 20 ]; then
  echo "→ تثبيت Node.js 20.x ..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
echo "   Node $(node -v) ✓"

echo "→ 2/7 تجهيز ذاكرة Swap (2GB) للبناء الآمن..."
if [ ! -f /swapfile ] && [ "$(free -m | awk '/^Swap:/{print $2}')" -lt 1000 ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "   Swap مفعّل ✓"
else
  echo "   Swap موجود مسبقاً ✓"
fi

echo "→ 3/7 تثبيت Caddy (لشهادة HTTPS التلقائية)..."
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -y -qq
  apt-get install -y -qq caddy
fi
echo "   Caddy مثبت ✓"

echo "→ 4/7 استنساخ/تحديث البرنامج من GitHub..."
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin
  git -C "$APP_DIR" reset --hard origin/main
else
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
echo "   النسخة: $(git log --oneline -1)"

echo "→ 5/7 إعداد البيئة وقاعدة البيانات وبناء الإنتاج..."
mkdir -p "$APP_DIR/db"
cat > "$APP_DIR/.env" <<EOF
DATABASE_URL=file:$APP_DIR/db/custom.db

# الإنتاج خلف Caddy: نفس الدومين ومسار /socket.io
NEXT_PUBLIC_SOCKET_URL=
NEXT_PUBLIC_SOCKET_PATH=/socket.io
EOF
cat > "$APP_DIR/mini-services/chat-service/.env" <<EOF
DATABASE_URL=file:$APP_DIR/db/custom.db
VOICE_DIR=$APP_DIR/db/voice
EOF

npm install --no-audit --no-fund
npx prisma db push
npm run build
cd "$APP_DIR/mini-services/chat-service"
npm install --no-audit --no-fund
npx prisma generate

echo "→ 6/7 إنشاء الخدمتين (تشغيل دائم + إعادة تشغيل تلقائية)..."
cat > /etc/systemd/system/instant-chat-web.service <<EOF
[Unit]
Description=Instant Chat - Web (Next.js production)
After=network.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node $APP_DIR/.next/standalone/server.js
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOSTNAME=127.0.0.1
Environment=VOICE_DIR=$APP_DIR/db/voice
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/instant-chat-socket.service <<EOF
[Unit]
Description=Instant Chat - Socket.IO service (voice/calls/groups + legacy APK)
After=network.target

[Service]
WorkingDirectory=$APP_DIR/mini-services/chat-service
ExecStart=/usr/bin/npx tsx index.ts
Environment=NODE_ENV=production
Environment=VOICE_DIR=$APP_DIR/db/voice
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now instant-chat-socket instant-chat-web

echo "→ 7/7 ضبط Caddy (HTTPS + السوكيت)..."
cat > /etc/caddy/Caddyfile <<EOF
{
        ${EMAIL:+email $EMAIL}
}

$DOMAIN {
        encode gzip zstd
        # خدمة الرسائل الفورية (WebSocket)
        reverse_proxy /socket.io/* 127.0.0.1:3003
        # واجهة الموقع
        reverse_proxy 127.0.0.1:3000
}
EOF
systemctl restart caddy

echo "→ جدار الحماية (22/80/443)..."
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp  >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  # لتفعيل تطبيق الأندرويد القديم (جسر الغرفة العامة) فك التعليق عن السطر التالي:
  # ufw allow 3003/tcp
fi

sleep 2
echo ""
echo "=============================================="
echo "✅ اكتمل النشر!"
echo "   رابط برنامجك:  https://$DOMAIN"
echo "   (امنح HTTPS دقيقة حتى تصدر الشهادة أول مرة)"
echo ""
echo "   أوامر مفيدة:"
echo "   systemctl status instant-chat-web    # حالة الواجهة"
echo "   systemctl status instant-chat-socket # حالة خادم الرسائل"
echo "   journalctl -u instant-chat-web -f    # سجلات حية"
echo "=============================================="
