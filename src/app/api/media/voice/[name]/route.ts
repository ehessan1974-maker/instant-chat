import { NextResponse } from 'next/server'
import { readFile, stat } from 'fs/promises'
import path from 'path'

/**
 * GET /api/media/voice/[name]
 * Serves recorded voice-note files stored by chat-service in <project>/db/voice.
 * File names are unguessable UUIDs generated server-side; the extension
 * whitelist below blocks any path traversal.
 */
const VOICE_DIR = process.env.VOICE_DIR || path.join(process.cwd(), 'db', 'voice')

const NAME_RE = /^[a-zA-Z0-9-]+\.(webm|mp4|ogg|oga|wav|m4a|aac|opus)$/i

const MIME_BY_EXT: Record<string, string> = {
  webm: 'audio/webm;codecs=opus',
  mp4: 'audio/mp4',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg;codecs=opus',
  oga: 'audio/ogg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  opus: 'audio/ogg;codecs=opus',
}

export async function GET(req: Request, { params }: { params: Promise<{ name: string }> }) {
  try {
    const { name } = await params
    if (!name || !NAME_RE.test(name)) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
    }

    const filePath = path.join(VOICE_DIR, name)

    let size = 0
    try {
      const st = await stat(filePath)
      if (!st.isFile()) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
      size = st.size
    } catch {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
    }

    const ext = (name.split('.').pop() ?? 'webm').toLowerCase()
    const contentType = MIME_BY_EXT[ext] ?? 'application/octet-stream'

    // small files (<10MB): simple Range support so mobile browsers can seek
    const range = req.headers.get('range')
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0
        const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1
        if (Number.isFinite(start) && start <= end && start < size) {
          const buf = await readFile(filePath)
          const slice = buf.subarray(start, end + 1)
          return new Response(new Uint8Array(slice), {
            status: 206,
            headers: {
              'Content-Type': contentType,
              'Content-Length': String(slice.length),
              'Content-Range': `bytes ${start}-${end}/${size}`,
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'private, max-age=31536000, immutable',
            },
          })
        }
      }
    }

    const buf = await readFile(filePath)
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    })
  } catch (error) {
    console.error('[media/voice GET] failed:', error)
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 })
  }
}
