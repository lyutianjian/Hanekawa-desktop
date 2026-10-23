import { spawn } from 'node:child_process'
import path from 'node:path'

export async function gitIgnoredPaths(cwd: string, filePaths: string[]): Promise<Set<string>> {
  if (filePaths.length === 0) return new Set()

  return new Promise((resolve) => {
    const child = spawn('git', ['-C', cwd, 'check-ignore', '--no-index', '--stdin'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const ignored = new Set<string>()
    let output = ''
    let settled = false

    const finish = (result: Set<string>) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    child.on('error', () => finish(new Set()))
    // git exits before reading stdin outside a repository; `close` still settles.
    child.stdin.on('error', () => {})
    child.on('close', (code) => {
      if (code === 0 || code === 1) {
        for (const line of output.split(/\r?\n/)) {
          const normalized = normalizePath(line.trim())
          if (normalized) ignored.add(normalized)
        }
      }
      finish(ignored)
    })

    child.stdin.end(`${filePaths.join('\n')}\n`)
  })
}

export async function filterGitIgnoredPaths(cwd: string, filePaths: string[]): Promise<string[]> {
  const ignored = await gitIgnoredPaths(cwd, filePaths)
  if (ignored.size === 0) return filePaths
  return filePaths.filter((filePath) => !ignored.has(normalizePath(filePath)))
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll(path.sep, '/')
}
