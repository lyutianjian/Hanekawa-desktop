/**
 * One asynchronous preparation, shared by every caller that can race it.
 *
 * A startup repair (the GUI PATH probe) must run once and finish before any
 * project bootstrap starts a child process, but `whenReady`, `second-instance`,
 * `activate` and the menu can all reach a bootstrap at nearly the same time.
 * They await this one promise, so the repair never runs twice and none of them
 * can observe a half-prepared environment.
 */
export class StartupPreparation {
  private started: Promise<void> | undefined

  constructor(
    private readonly prepare: () => Promise<void>,
    private readonly onError: (error: unknown) => void = (error) => {
      console.error('[hanekawa] 启动环境准备失败：', error)
    },
  ) {}

  /** Starts the preparation on first call; every call returns the same promise. */
  ready(): Promise<void> {
    this.started ??= this.prepare().catch((error) => {
      // Fail-open: a failed preparation must not block every future bootstrap.
      this.onError(error)
    })
    return this.started
  }
}
