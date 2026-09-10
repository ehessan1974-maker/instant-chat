import { randomBytes } from 'node:crypto'
import type { User } from '@prisma/client'
import { db } from '@/lib/db'

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i

/** WhatsApp-style palette used for new users' avatar colors. */
export const AVATAR_COLORS = [
  '#00a884',
  '#128c7e',
  '#25d366',
  '#075e54',
  '#34b7f1',
  '#517da2',
  '#00bfa5',
] as const

/**
 * Extract the bearer token from the `Authorization: Bearer <token>` header.
 * Returns null when the header is missing or malformed.
 */
export function extractBearerToken(req: Request): string | null {
  const header = req.headers.get('authorization')
  if (!header) return null
  const match = BEARER_PATTERN.exec(header.trim())
  return match ? match[1] : null
}

/**
 * Resolve the authenticated User for a request via its session token.
 * Returns null when there is no token or the session does not exist.
 */
export async function getSessionUser(req: Request): Promise<User | null> {
  try {
    const token = extractBearerToken(req)
    if (!token) return null
    const session = await db.session.findUnique({
      where: { token },
      include: { user: true },
    })
    return session?.user ?? null
  } catch (error) {
    console.error('[auth] getSessionUser failed:', error)
    return null
  }
}

/** Cryptographically strong session token (64 hex characters). */
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Normalize a phone number into a simple international form:
 * strip spaces/symbols, keep an optional leading "+".
 * Returns null when the number has fewer than 7 digits (or more than 15).
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const hasPlus = trimmed.startsWith('+')
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length < 7 || digits.length > 15) return null
  return hasPlus ? `+${digits}` : digits
}

/**
 * Safely parse a JSON request body into a plain record.
 * Returns null for empty/invalid/non-object bodies.
 */
export async function readJsonRecord(
  req: Request
): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await req.json()
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null
    }
    return value as Record<string, unknown>
  } catch {
    return null
  }
}
