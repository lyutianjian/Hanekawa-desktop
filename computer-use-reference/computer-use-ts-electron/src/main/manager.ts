import { Session } from '../automation/session';
import type { Driver } from '../automation/driver';
import type { StartInput, Target } from '../shared/contracts';
import { AutomationError } from '../shared/errors';
import { MockDriver } from '../drivers/mock';
import { MacOSDriver } from '../drivers/macos/driver';
export class Manager {
  private sessions = new Map<string, { owner: number; session: Session }>();
  private leases = new Set<string>();
  private ownerEpochs = new Map<number, number>();
  constructor(private nativeExecutable: string, private approve: (target: Target) => Promise<boolean>) {}
  targets(): Target[] {
    return [new MockDriver().target, ...(process.platform === 'darwin' ? [
      { driver: 'macos' as const, bundleId: 'com.apple.calculator', displayName: 'Calculator (macOS)' }
    ] : [])];
  }
  async start(owner: number, input: StartInput) {
    const epoch = this.ownerEpochs.get(owner) ?? 0;
    const target = this.targets().find(t => t.driver === input.driver && t.bundleId === input.bundleId);
    if (!target) throw new AutomationError('NOT_AUTHORIZED', 'Target is not in the application allowlist');
    const key = `${target.driver}:${target.bundleId}`;
    if (this.leases.has(key)) throw new AutomationError('BUSY', 'The target is already reserved by a session');
    this.leases.add(key); // Reserve BEFORE awaiting a native authorization dialog.
    let driver: Driver | undefined;
    try {
      if (target.driver === 'macos' && !await this.approve(target)) throw new AutomationError('NOT_AUTHORIZED', 'Application access was declined');
      if ((this.ownerEpochs.get(owner) ?? 0) !== epoch) throw new AutomationError('CANCELLED', 'Owner changed during authorization');
      driver = target.driver === 'mock' ? new MockDriver() : new MacOSDriver(this.nativeExecutable);
      const session = new Session(driver);
      await session.open();
      if ((this.ownerEpochs.get(owner) ?? 0) !== epoch) {
        await session.cancel();
        throw new AutomationError('CANCELLED', 'Owner changed during driver startup');
      }
      this.sessions.set(session.id, { owner, session });
      return session.info();
    } catch (error) {
      try { await driver?.close(); } finally { this.leases.delete(key); }
      throw error;
    }
  }
  get(owner: number, id: string): Session {
    const entry = this.sessions.get(id);
    if (!entry || entry.owner !== owner) throw new AutomationError('NOT_AUTHORIZED', 'Session does not belong to this window');
    return entry.session;
  }
  async cancel(owner: number, id: string): Promise<{ closed: true }> {
    const session = this.get(owner, id);
    await session.cancel(); // No new session can acquire this target before teardown ends.
    this.sessions.delete(id);
    this.leases.delete(`${session.driver.target.driver}:${session.driver.target.bundleId}`);
    return { closed: true };
  }
  async closeOwner(owner: number): Promise<void> {
    this.ownerEpochs.set(owner, (this.ownerEpochs.get(owner) ?? 0) + 1);
    await Promise.all([...this.sessions].filter(([, e]) => e.owner === owner).map(([id]) => this.cancel(owner, id)));
  }
}
