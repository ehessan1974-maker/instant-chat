import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  })

// Enable WAL mode so the Next.js server and the Socket.IO mini-service
// can safely share the same SQLite file with concurrent readers.
// NOTE: on Prisma 6.19.x SQLite, PRAGMA returns a result row, so
// $executeRawUnsafe rejects it — $queryRawUnsafe applies it correctly.
async function initSqlitePragmas(client: PrismaClient) {
  try {
    await client.$queryRawUnsafe('PRAGMA journal_mode=WAL;')
    await client.$queryRawUnsafe('PRAGMA busy_timeout=5000;')
  } catch (e) {
    console.error('Failed to set SQLite pragmas', e)
  }
}

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

void initSqlitePragmas(db)

// Ensure the public room conversation exists.
export async function ensurePublicRoom() {
  return db.conversation.upsert({
    where: { key: 'PUBLIC' },
    update: {},
    create: { type: 'group', name: 'الغرفة العامة', key: 'PUBLIC' },
  })
}
