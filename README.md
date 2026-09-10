# 💬 محادثة فورية — Instant Chat v2

تطبيق محادثة فورية عربي (RTL) بأسلوب واتساب: رسائل خاصة 1:1 + غرفة عامة مباشرة، مع مؤشرات ✓/✓✓ للحالة والحضور والكتابة، وقاعدة بيانات دائمة، وتوافق كامل مع تطبيق الأندرويد القديم (`InstantChat.apk`) عبر جسر بروتوكولي.

> **الإصدار 2.0** — إعادة بناء كاملة عن النسخة القديمة (Express + ws خام) التي ما كانت تشغّل الـ APK أصلاً. النسخة القديمة محفوظة للمرجعية في مجلد [`legacy/`](./legacy).

---

## ✨ الميزات

| الميزة | الحالة |
|---|---|
| تسجيل دخول برقم الهاتف + رمز تحقق (وضع تجريبي: الرمز يظهر في الواجهة) | ✅ |
| غرفة عامة مباشرة + محادثات خاصة 1:1 | ✅ |
| مؤشرات الحالة: ✓ مرسلة / ✓✓ وصلت / ✓✓ زرقاء قُرئت | ✅ |
| الحضور (متصل الآن / آخر ظهور) ومؤشر «يكتب…» | ✅ |
| سجل رسائل دائم (SQLite عبر Prisma) — لا يضيع بعد إعادة التشغيل | ✅ |
| منتقي إيموجي + أصوات تنبيه WebAudio | ✅ |
| واجهة متجاوبة (موبايل بعرض واحد، ديسكتوب بشقّين) ووضع RTL كامل | ✅ |
| **جسر توافق APK القديم**: تطبيق الأندرويد الحالي يعمل دون أي تعديل | ✅ |
| إشعارات Push + رفع ملفات ثقيلة مجزأ | 🗺️ مؤجل للخارطة |

---

## 🏗️ البنية التقنية

```
المتصفح (Next.js + React + Tailwind + shadcn/ui)
   │  REST: /api/auth، /api/users، /api/conversations…
   │  Socket.IO: رسائل فورية + حضور + حالات قراءة
   ▼
Next.js (:3000) ──────────────┐
                              │ نفس قاعدة SQLite (WAL)
خدمة المحادثة chat-service ───┘
(Socket.IO على :3003، Prisma)
   │
   ├─ عملاء الويب: بروتوكول «الجلسات» (token → auth)
   └─ عملاء APK القديمون: بروتوكول legacy (login بالاسم كوسيط نصي)
        بأشكال الأحداث القديمة حرفياً: your_info / previous_messages /
        online_users / user_joined / user_left / new_message / user_typing
```

- **الواجهة**: `src/` — Next.js 16 App Router + TypeScript + Tailwind 4 + shadcn/ui
- **REST API**: `src/app/api/**` — مصادقة OTP، مستخدمون، محادثات، رسائل (ترحيل للرسائل الأقدم)
- **خدمة السوكيت**: `mini-services/chat-service/` — Socket.IO + Prisma، منفذ `3003` (قابل للتغيير بـ `CHAT_PORT`)
- **قاعدة البيانات**: SQLite + WAL مشتركة بين الطرفين عبر `DATABASE_URL`

### ملاحظة توافق الـ APK المهمة
سيرفر السوكيت يعمل بمسار `/`، ومحرك engine.io يطابق المسار **بالبادئة**، لذلك يقبل السيرفر أيضاً المسار الافتراضي `/socket.io` الذي يستخدمه الـ APK القديم — سيرفر واحد يخدم الجميع دون إعدادات إضافية.

---

## 🚀 التشغيل محلياً

المتطلبات: Node 20+ أو Bun، وأحد مديري الحزم npm/pnpm/bun.

```bash
# 1) الواجهة + REST API
cp .env.example .env          # ثم عدّل DATABASE_URL إلى مسار مطلق
npm install
npx prisma db push            # إنشاء قاعدة البيانات
npm run dev                   # http://localhost:3000

# 2) خدمة السوكيت (نافذة طرفية ثانية)
cd mini-services/chat-service
cp .env.example .env          # نفس DATABASE_URL النسخة السابقة بالضبط
npm install
npx prisma generate
npm run dev                   # يستمع على 3003
```

افتح `http://localhost:3000`، أدخل أي رقم هاتف، سيظهر **رمز التحقق في الواجهة** (وضع تجريبي بلا مزود SMS)، ثم اسمك — وأنت داخل.

### ملف `.env` (الجذر)

```bash
# قاعدة البيانات — استخدم مساراً مطلقاً
DATABASE_URL=file:/absolute/path/to/project/db/custom.db

# اتصال السوكيت من المتصفح — اختر حالة واحدة:
# أ) نشر خلف وكيل يمرر /socket.io إلى :3003 (موصى به للإنتاج)
NEXT_PUBLIC_SOCKET_URL=
NEXT_PUBLIC_SOCKET_PATH=/socket.io
# ب) اتصال مباشر بدون وكيل (كورس مفتوح في الخدمة أصلًا)
# NEXT_PUBLIC_SOCKET_URL=http://SERVER_IP:3003
# NEXT_PUBLIC_SOCKET_PATH=/socket.io
# ج) بيئة بوابة Caddy بشكل هذه البيئة التجريبية
# NEXT_PUBLIC_SOCKET_URL=/?XTransformPort=3003
# NEXT_PUBLIC_SOCKET_PATH=/
```

### ملف `mini-services/chat-service/.env`

```bash
DATABASE_URL=file:/absolute/path/to/project/db/custom.db   # نفس القيمة السابقة
# CHAT_PORT=3003                                            # اختياري
```

---

## 🌐 النشر على سيرفر (VPS)

الطريقة الموصى بها (دومين واحد + nginx):

1. شغّل الواجهة على `127.0.0.1:3000` (بعد `npm run build && npm run start` أو عبر pm2/systemd).
2. شغّل خدمة السوكيت على `127.0.0.1:3003`.
3. في nginx، مرّر `/socket.io` إلى خدمة السوكيت مع ترويسات الترقية:

```nginx
location /socket.io/ {
    proxy_pass http://127.0.0.1:3003;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
location / {
    proxy_pass http://127.0.0.1:3000;
}
```

4. فعّل شهادة HTTPS (certbot) — **ضرورية لإشعارات Push مستقبلاً**.

> ⚠️ **ملاحظة الـ APK القديم**: التطبيق الحالي يتصل بـ `ws://` فقط (سطر wss معطّل داخله)، لذا سيعمل على `http://IP:3003` مباشرة أو خلف nginx غير مشفّر. تشفير الـ APK يحتاج إعادة بنائه — مفردات خارطة الطريق.

### 📱 تطبيق الأندرويد
`android/InstantChat.apk` — النسخة القديمة كما هي. عند فتحه: أدخل عنوان الخادم (مثل `SERVER_IP:3003`) واسمك، وسيدخل الغرفة العامة ويتشارك الرسائل مع مستخدمي الويب فوراً (رسائل الغرفة العامة فقط — بلا محادثات خاصة/حالات قراءة بحكم واجهته القديمة).

---

## 📁 خريطة المجلدات

```
├── src/                    واجهة Next.js + REST API
│   ├── app/                الصفحات ومسارات /api
│   ├── components/chat/    مكونات المحادثة (قائمة، محادثة، دخول، إيموجي…)
│   └── lib/                السوكيت، واجهة REST، الأصوات، Prisma
├── prisma/                 مخطط قاعدة البيانات (User, Session, OtpCode,
│                           Conversation, ConversationParticipant, Message)
├── mini-services/chat-service/   خدمة Socket.IO + جسر APK
├── legacy/                 النسخة القديمة (server.js بـ ws خام + واجهته + sw.js)
├── android/                تطبيق الأندرويد APK
├── db/                     ملف SQLite (يُنشأ محليًا — غير مرفوع)
└── .env.example            نموذج متغيرات البيئة
```

## 🗺️ خارطة الطريق

- **المرحلة القادمة**: إشعارات Push (web-push + VAPID بمفاتيح خاصة)، رسائل صوتية وصور خفيفة
- **لاحقاً**: رفع ملفات ثقيلة مجزأ قابل للاستئناف بأسلوب تيليغرام، مجموعات، تشفير طرف-لطرف
- **بنية تحتية**: تبديل SQLite إلى PostgreSQL عند الحاجة لعدة نسخ خدمة

## 🧾 الرخصة والحقوق

مشروع تعليمي/شخصي — استخدمه وعدّله بحرية.
