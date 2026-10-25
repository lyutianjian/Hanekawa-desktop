import { spawn } from 'node:child_process'
import path from 'node:path'

export async function gitIgnoredPaths(cwd: string, filePaths: string[]): Promise<Set<string>> {
  if (filePaths.length === 0) return new Set()

  return new Promise((resolve) => {
    const child = spawn('git', ['-C', cwd, 'check-ignore', '--no-index', '-z', '--stdin'], {
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
      const paths = output.split('\0')
      output = paths.pop() ?? ''
      for (const filePath of paths) ignored.add(normalizePath(filePath))
    })
    child.on('error', () => finish(new Set()))
    // git exits before reading stdin outside a repository; `close` still settles.
    child.stdin.on('error', () => {})
    child.on('close', (code) => {
      finish(code === 0 || code === 1 ? ignored : new Set())
    })

    child.stdin.end(`${filePaths.join('\0')}\0`)
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
