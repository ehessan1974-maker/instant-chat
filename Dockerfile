# ============================================================
# صورة تشغيل جاهزة — بدون أي بناء على منصة الاستضافة
#
# لماذا؟ الخطط المجانية (Render Free = 512MB) لا تكفي لبناء
# Next.js (يحتاج ~3.5GB أثناء البناء → فشل Deploy failed).
# الحل: النسخة النهائية تُبنى محلياً وتوضع في prebuilt/ ثم تُرفع
# مع المستودع — فيصبح بناء المنصة مجرد نسخ ملفات (أقل من دقيقتين).
#
# المنفذ: متغير PORT (Render/HF يضبطانه تلقائياً، افتراضي 7860)
#   /socket.io/* → خدمة الرسائل (:3003)
#   الباقي      → واجهة Next.js (:3000)
# ============================================================
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=7860
COPY --from=caddy:2 /usr/bin/caddy /usr/local/bin/caddy

# الواجهة المبنية مسبقاً (server.js + node_modules + .next + public)
COPY prebuilt/next ./
# خدمة الرسائل مع اعتمادياتها الجاهزة (tsx + عميل Prisma)
COPY prebuilt/chat-service ./chat-service
# قاعدة بيانات أولية نظيفة بالهيكل الصحيح
COPY prebuilt/seed /seed
COPY Caddyfile.docker /etc/caddy/Caddyfile
COPY docker/start.sh /start.sh
RUN chmod +x /start.sh && mkdir -p /app/db/voice

EXPOSE 7860
# تشغيل عبر sh مباشرة — لا يعتمد على صلاحية تنفيذ الملف
CMD ["sh", "/start.sh"]
