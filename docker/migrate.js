// ============================================================
// ترقية مخطط قاعدة البيانات القديمة بأمان (Idempotent)
// يُشغَّل من start.sh عند كل إقلاع — يضيف أعمدة قناة تيليجرام
// إلى جدول OtpCode إن لم تكن موجودة، ولا يفشل الإقلاع أبداً.
// ============================================================
const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  const steps = [
    [
      'channel',
      'ALTER TABLE "OtpCode" ADD COLUMN "channel" TEXT NOT NULL DEFAULT \'sms\'',
    ],
    ['linkCode', 'ALTER TABLE "OtpCode" ADD COLUMN "linkCode" TEXT'],
    ['deliveredAt', 'ALTER TABLE "OtpCode" ADD COLUMN "deliveredAt" DATETIME'],
  ];
  for (const [name, sql] of steps) {
    try {
      await prisma.$executeRawUnsafe(sql);
      console.log('[migrate] أُضيف عمود OtpCode.' + name);
    } catch (e) {
      // العمود موجود مسبقاً — تجاهل بصمت
    }
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(
    '[migrate] تحذير: تعذر فحص المخطط:',
    e && e.message ? e.message : e
  );
  // لا نوقف الإقلاع — قاعدة seed الجديدة تغطي عمليات النشر الجديدة
});
