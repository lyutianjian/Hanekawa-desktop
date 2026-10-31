/**
 * Files for the browser, served by the app.
 *
 * The browser opens `http:`/`https:` only, and that refusal is the security
 * model rather than an inconvenience to route around: a `file://` document runs
 * with a page's privileges against the user's disk. This server is the way in.
 * The bytes are read by the app — under a root the caller authorised, past the
 * app's own checks — and handed to the page as ordinary HTTP, so relative CSS,
 * scripts, images and `fetch` all behave the way they do on a real site.
 *
 * Two things keep the port private. The token is random and only this process
 * mints one; it names a session and the roots that session may read, so a URL
 * copied into a transcript still cannot reach a path nobody opened. And every
 * refusal — a bad token, a path outside the roots, a directory — is answered
 * without describing the disk, because a caller that never got a token learns
 * nothing by probing.
 */

import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { getGlobalHanekawaDir } from '../../utils/paths.js'

/** One page's worth of assets, with room for a build's images. */
const MAX_FILE_BYTES = 64 * 1024 * 1024

const TOKEN_BYTES = 24

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
}

interface Authorization {
  sessionId: string
  /** Real paths a page opened in this session may read. */
  roots: Set<string>
}

export interface LocalFileServerOptions {
  /**
   * Directories this server never serves, whatever a caller authorised: the
   * app's own data holds API keys and transcripts, and a page that read them
   * would put them in the conversation. Defaults to `~/.hanekawa`.
   */
  blockedRoots?: readonly string[]
}

export class LocalFileServer {
  private server: Server | undefined
  private starting: Promise<void> | undefined
  private port = 0
  private readonly authorizations = new Map<string, Authorization>()
  private readonly tokenFor = new Map<string, string>()
  private readonly blocked: readonly string[]

  constructor(options: LocalFileServerOptions = {}) {
    this.blocked = (options.blockedRoots ?? [getGlobalHanekawaDir()]).map((root) => path.resolve(root))
  }

  /**
   * The URL for a page on disk, once `root` is authorised for `sessionId`.
   *
   * `root` is what the page may read besides the file itself: the workspace
   * when the page lives inside it, otherwise the file's own directory.
   */
  async urlFor(sessionId: string, root: string, file: string): Promise<string> {
    await this.ensureServer()
    const authorization = this.authorize(sessionId)
    authorization.roots.add(await realPathOr(path.resolve(root)))
    return `http://127.0.0.1:${this.port}/${this.tokenFor.get(sessionId)}${pathSegments(file)}`
  }

  async dispose(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.starting = undefined
    this.authorizations.clear()
    this.tokenFor.clear()
    if (server === undefined) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private authorize(sessionId: string): Authorization {
    const existingToken = this.tokenFor.get(sessionId)
    const existing = existingToken === undefined ? undefined : this.authorizations.get(existingToken)
    if (existing !== undefined) return existing
    const token = randomBytes(TOKEN_BYTES).toString('base64url')
    const authorization: Authorization = { sessionId, roots: new Set() }
    this.authorizations.set(token, authorization)
    this.tokenFor.set(sessionId, token)
    return authorization
  }

  private ensureServer(): Promise<void> {
    if (this.server !== undefined) return Promise.resolve()
    this.starting ??= new Promise<void>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handle(request, response)
      })
      server.once('error', (error) => {
        this.starting = undefined
        reject(error)
      })
      server.listen(0, '127.0.0.1', () => {
        this.port = (server.address() as AddressInfo).port
        this.server = server
        resolve()
      })
    })
    return this.starting
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') return refuse(response, 405, 'Method not allowed.')
      if (!this.hostIsOwn(request.headers.host)) return notFound(response)

      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      const [token = '', ...rest] = pathname.split('/').slice(1).map(decodeSegment)
      const authorization = this.authorizations.get(token)
      if (authorization === undefined) return notFound(response)

      const target = realJoin(rest)
      const real = await realpath(target).catch(() => undefined)
      if (real === undefined) return notFound(response)
      if (this.blocked.some((root) => isInside(root, real))) {
        return refuse(response, 403, 'This directory is not served to the browser.')
      }
      if (![...authorization.roots].some((root) => isInside(root, real))) {
        return refuse(response, 403, 'This path was not opened for the browser. Reopen the page with its path.')
      }

      const stats = await stat(real).catch(() => undefined)
      if (stats === undefined || !stats.isFile()) return refuse(response, 403, 'Directories are not served.')
      if (stats.size > MAX_FILE_BYTES) return refuse(response, 413, 'The file is too large to preview.')

      const headers = {
        'Content-Type': CONTENT_TYPES[path.extname(real).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': String(stats.size),
        // A build or an edit must show up on the next reload, not the next day.
        'Cache-Control': 'no-store',
      }
      response.writeHead(200, headers)
      if (request.method === 'HEAD') {
        response.end()
        return
      }
      const stream = createReadStream(real)
      stream.on('error', () => response.destroy())
      stream.pipe(response)
    } catch {
      if (!response.headersSent) refuse(response, 500, 'The file could not be read.')
      else response.destroy()
    }
  }

  /** Only this app's own loopback names: a rebinding domain arrives with its own. */
  private hostIsOwn(host: string | undefined): boolean {
    if (host === undefined) return false
    return [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`].includes(host)
  }
}

/** `/<token>/Users/a/b.html` → `/Users/a/b.html`; Windows keeps its drive letter. */
function realJoin(segments: string[]): string {
  if (/^[A-Za-z]:$/.test(segments[0] ?? '')) return segments.join('/')
  return `/${segments.join('/')}`
}

/** The absolute path as URL path segments, so spaces and `#` survive the trip. */
function pathSegments(file: string): string {
  return path
    .resolve(file)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

async function realPathOr(candidate: string): Promise<string> {
  return realpath(candidate).catch(() => candidate)
}

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

/** Whether `target` is `root` or sits below it, with the platform's own casing. */
function isInside(root: string, target: string): boolean {
  const fold = (value: string) => (CASE_INSENSITIVE ? value.toLowerCase() : value)
  const base = fold(root.endsWith(path.sep) ? root : root + path.sep)
  const candidate = fold(target)
  return candidate === fold(root) || candidate.startsWith(base)
}

function notFound(response: ServerResponse): void {
  refuse(response, 404, 'Not found.')
}

function refuse(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(message)
}