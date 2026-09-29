/** Sliding-window rate limiter keyed by an arbitrary string (e.g. contact id). In-memory, per process. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit and returns true when it is within the limit. */
  tryAcquire(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((ts) => t - ts < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }

  /** Milliseconds until the next hit would be allowed (0 if allowed now). */
  waitTime(key: string): number {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((ts) => t - ts < this.windowMs);
    if (recent.length < this.limit) return 0;
    return this.windowMs - (t - recent[0]!);
  }
}

/**
 * Runs tasks one-at-a-time per key (e.g. per WhatsApp chat) so that messages
 * from the same person are processed in order and never concurrently.
 */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(task);
    this.tails.set(key, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.tails.get(key) === next) this.tails.delete(key);
      });
    return next;
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
