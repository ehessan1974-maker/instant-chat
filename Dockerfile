# ============================================================
# صورة Docker موحّدة — واجهة + خادم رسائل + وكيل في حاوية واحدة
# تعمل على أي منصة Docker مجانية: Render / Hugging Face Spaces / Fly…
#
# المنفذ الخارجي: متغير PORT (افتراضي 7860 لـ HF Spaces،
# وRender يضبطه تلقائياً) — Caddy يوزع:
#   /socket.io/* → خدمة الرسائل (:3003)
#   الباقي      → واجهة Next.js (:3000)
# ============================================================

# ---------- مرحلة 1: الأساس ----------
FROM node:20-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ---------- مرحلة 2: البناء ----------
FROM base AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
# اتصال السوكيت بنفس الدومين (خلف وكيل الحاوية)
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_SOCKET_URL=
ENV NEXT_PUBLIC_SOCKET_PATH=/socket.io
RUN npx prisma generate \
 && npm run build

# ---------- مرحلة 3: التشغيل ----------
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=7860
COPY --from=caddy:2 /usr/bin/caddy /usr/local/bin/caddy

# واجهة Next.js (standalone + static + public — السكربت build نسخها)
COPY --from=build /app/.next/standalone ./
# ضمان وجود عميل Prisma ومحركه حتى مع tracing
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/prisma ./prisma

# خدمة الرسائل
COPY mini-services/chat-service /app/chat-service
RUN cd /app/chat-service \
 && npm install --no-audit --no-fund \
 && npx prisma generate

# الوكيل والبدء
COPY Caddyfile.docker /etc/caddy/Caddyfile
COPY docker/start.sh /start.sh
RUN chmod +x /start.sh && mkdir -p /app/db/voice /app/chat-service/db

EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7860)+'/api').then(r=>process.exit(0)).catch(()=>process.exit(1))"
CMD ["/start.sh"]
