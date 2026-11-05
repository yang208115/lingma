import { LoopStop } from './errors.js';

export function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(signal.reason instanceof LoopStop ? signal.reason : new LoopStop('cancelled'));
    if (signal.aborted) {
      Promise.resolve(promise).catch(() => {});
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
      .catch(() => {});
  });
}
export class RunControl {
  private readonly controller = new AbortController();
  private readonly externalAbort = () => this.controller.abort(new LoopStop('cancelled'));
  readonly signal = this.controller.signal;
  constructor(private readonly external: AbortSignal) {
    external.addEventListener('abort', this.externalAbort, { once: true });
    if (external.aborted) this.externalAbort();
  }
  check(): void {
    if (this.signal.aborted) throw this.signal.reason;
  }
  modelCall() {
    this.check();
    const controller = new AbortController();
    const forward = () => controller.abort(this.signal.reason);
    this.signal.addEventListener('abort', forward, { once: true });
    return {
      signal: controller.signal,
      check: () => {
        this.check();
        if (controller.signal.aborted) throw controller.signal.reason;
      },
      close: () => {
        this.signal.removeEventListener('abort', forward);
        controller.abort();
      },
    };
  }
  close(): void {
    this.external.removeEventListener('abort', this.externalAbort);
  }
}
