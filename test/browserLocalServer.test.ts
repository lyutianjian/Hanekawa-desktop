/**
 * The loopback file server the browser reads local pages through.
 *
 * Each case is a request a page could actually make, answered the way the
 * server promises: the token decides *whose* roots apply, the roots decide
 * which files exist, and everything else is a refusal that says nothing.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { LocalFileServer } from '../src/desktop/browser/localServer.js'

async function scratch(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'hanekawa-local-server-'))
}

/** The URL for an absolute path under an existing token, encoded the way the server reads it. */
function withPath(pageUrl: string, absolute: string): string {
  const parsed = new URL(pageUrl)
  const token = parsed.pathname.split('/')[1]
  const segments = absolute.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  return `${parsed.origin}/${token}${segments}`
}

test('a page and its relative assets come back with their own types and no cache', async () => {
  const dir = await scratch()
  const root = path.join(dir, 'site')
  await mkdir(path.join(root, 'assets'), { recursive: true })
  await writeFile(path.join(root, 'index.html'), '<!doctype html><link rel="stylesheet" href="assets/a.css">')
  await writeFile(path.join(root, 'assets', 'a.css'), 'body{color:red}')
  const server = new LocalFileServer({ blockedRoots: [] })
  try {
    const pageUrl = await server.urlFor('session-1', root, path.join(root, 'index.html'))
    const page = await fetch(pageUrl)
    assert.equal(page.status, 200)
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(page.headers.get('cache-control'), 'no-store')
    assert.match(await page.text(), /stylesheet/)

    const css = await fetch(new URL('assets/a.css', pageUrl))
    assert.equal(css.status, 200)
    assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8')
    assert.equal(await css.text(), 'body{color:red}')
  } finally {
    await server.dispose()
  }
})

test('a token is the only way in, and it only opens the roots that session authorised', async () => {
  const dir = await scratch()
  const root = path.join(dir, 'site')
  const secret = path.join(dir, 'secret.txt')
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, 'index.html'), '<p>ok</p>')
  await writeFile(secret, 'no')
  const server = new LocalFileServer({ blockedRoots: [] })
  try {
    const pageUrl = await server.urlFor('session-1', root, path.join(root, 'index.html'))
    const origin = new URL(pageUrl).origin

    assert.equal((await fetch(`${origin}/not-a-token/index.html`)).status, 404)
    assert.equal((await fetch(withPath(pageUrl, secret))).status, 403)
    assert.equal((await fetch(withPath(pageUrl, root))).status, 403)
    assert.equal((await fetch(pageUrl, { method: 'POST' })).status, 405)
  } finally {
    await server.dispose()
  }
})

test('app data is refused even when a caller authorised a directory that contains it', async () => {
  const dir = await scratch()
  const data = path.join(dir, '.hanekawa')
  await mkdir(data, { recursive: true })
  await writeFile(path.join(data, 'config.json'), '{"apiKey":"sk-test"}')
  const server = new LocalFileServer({ blockedRoots: [data] })
  try {
    const pageUrl = await server.urlFor('session-1', dir, path.join(data, 'config.json'))
    assert.equal((await fetch(pageUrl)).status, 403)
  } finally {
    await server.dispose()
  }
})

test('a symlink cannot carry a request out of the authorised root', async () => {
  const dir = await scratch()
  const root = path.join(dir, 'site')
  const outside = path.join(dir, 'outside.txt')
  await mkdir(root, { recursive: true })
  await writeFile(outside, 'no')
  await symlink(outside, path.join(root, 'escape.txt'))
  const server = new LocalFileServer({ blockedRoots: [] })
  try {
    const pageUrl = await server.urlFor('session-1', root, path.join(root, 'escape.txt'))
    assert.equal((await fetch(pageUrl)).status, 403)
  } finally {
    await server.dispose()
  }
})