import { AppError } from '../errors.js';

export class MaintenanceGate {
  private writers = 0;
  private maintenance = false;
  private stopped = false;
  private maintenanceDone: Promise<void> = Promise.resolve();
  private readonly idleWaiters = new Set<() => void>();
  get available(): boolean {
    return !this.maintenance && !this.stopped;
  }

  async withWrite<T>(action: () => T | Promise<T>): Promise<T> {
    this.enter();
    try {
      return await action();
    } finally {
      this.leave();
    }
  }

  writeSync<T>(action: () => T): T {
    this.enter();
    try {
      return action();
    } finally {
      this.leave();
    }
  }

  async withMaintenance<T>(action: () => T | Promise<T>): Promise<T> {
    if (!this.available) throw new AppError('MAINTENANCE_MODE', '实例正在维护或关闭', 503);
    this.maintenance = true;
    let finish: () => void = () => {};
    this.maintenanceDone = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      await this.waitForIdle();
      return await action();
    } finally {
      this.maintenance = false;
      finish();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.waitForIdle();
    await this.maintenanceDone;
  }

  private enter(): void {
    if (!this.available) throw new AppError('MAINTENANCE_MODE', '实例正在维护或关闭', 503);
    this.writers++;
  }
  private leave(): void {
    this.writers--;
    if (this.writers === 0) {
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
  }
  private async waitForIdle(): Promise<void> {
    if (this.writers > 0) await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }
}
