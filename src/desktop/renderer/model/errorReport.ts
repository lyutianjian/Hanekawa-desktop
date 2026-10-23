/**
 * Where a failed action says so. An error belongs next to what failed when that
 * place is on screen; when it is not (the user has moved on, or the action has
 * no place of its own) it goes to the window's toast stack — never to a
 * transcript that may be behind another screen.
 */

export type ErrorPlace = 'projects-page' | 'thread-panel' | 'merge-bar' | 'toast'

export interface ErrorSite {
  /** What was being attempted, as a noun phrase: 「删除会话」. */
  readonly action: string
  /** Where the failure is drawn when that place is on screen. */
  readonly place?: Exclude<ErrorPlace, 'toast'>
  /** The detail is already a full sentence (a refusal the host worded itself). */
  readonly bare?: boolean
  /** Runs the action again; a toast offers it as 重试. */
  readonly retry?: () => void
}

export function errorText(site: ErrorSite, detail: string): string {
  const worded = errorDetailText(detail)
  return site.bare === true ? worded : `${site.action}失败：${worded}`
}

/**
 * The detail in Chinese, when it is one of the system's own English messages.
 *
 * What arrives here is whatever the main process or the host threw: Node's
 * `ENOENT: no such file or directory, open '/x'`, a `spawn code ENOENT`, the
 * shell client's own 「The shell host disconnected.」. Left alone they put an
 * English sentence after a Chinese 「…失败：」. The path a Node error names is
 * kept — it is the half of the message that says *what* — and anything not
 * recognised passes through untouched rather than being guessed at.
 */
export function errorDetailText(detail: string): string {
  const text = detail.trim()
  const spawn = /^spawn (\S+) ENOENT$/.exec(text)
  if (spawn) return `找不到命令 ${spawn[1]}`
  const node = /^(E[A-Z]+): [^,]*(?:, \w+ '([^']*)')?/.exec(text)
  if (node) {
    const reason = NODE_ERROR_TEXT[node[1]!]
    if (reason) return node[2] ? `${reason}：${node[2]}` : reason
  }
  for (const [pattern, worded] of PLAIN_ERROR_TEXT) if (pattern.test(text)) return worded
  return detail
}

const NODE_ERROR_TEXT: Readonly<Record<string, string>> = {
  ENOENT: '文件或目录不存在',
  EACCES: '没有权限',
  EPERM: '没有权限',
  EEXIST: '已经存在',
  ENOTEMPTY: '目录不为空',
  EBUSY: '文件正被占用',
  EISDIR: '这是一个目录',
  ENOTDIR: '不是目录',
  ENOSPC: '磁盘空间不足',
  ETIMEDOUT: '连接超时',
  ECONNREFUSED: '连接被拒绝',
  ECONNRESET: '连接被重置',
}

const PLAIN_ERROR_TEXT: ReadonlyArray<readonly [RegExp, string]> = [
  [/^The shell host disconnected\.?$/i, '与应用后台的连接已断开'],
  [/^The shell host (was )?disposed\.?$/i, '应用后台已关闭'],
  [/^(The operation was |Request )?abort(ed)?\.?$/i, '已取消'],
  [/^(fetch failed|Failed to fetch)$/i, '网络请求失败'],
]

export function errorPlace(site: ErrorSite, visible: ReadonlySet<ErrorPlace>): ErrorPlace {
  return site.place !== undefined && visible.has(site.place) ? site.place : 'toast'
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
