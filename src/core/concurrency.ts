import { AppError } from "./errors";
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
export class Limiter {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(
    private concurrency: number,
    private capacity: number,
  ) {}
  configure(concurrency: number, capacity: number) {
    this.concurrency = concurrency;
    this.capacity = capacity;
    this.drain();
  }
  private drain() {
    while (this.active < this.concurrency && this.queue.length) {
      this.active++;
      this.queue.shift()!();
    }
  }
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.active >= this.concurrency) {
      if (this.queue.length >= this.capacity)
        throw new AppError("BUSY", "Processing queue full", 503);
      await new Promise<void>((resolve, reject) => {
        const start = () => {
          signal?.removeEventListener("abort", cancel);
          resolve();
        };
        const cancel = () => {
          const index = this.queue.indexOf(start);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(signal!.reason);
        };
        this.queue.push(start);
        signal?.addEventListener("abort", cancel, { once: true });
      });
    } else this.active++;
    try {
      signal?.throwIfAborted();
      return await fn();
    } finally {
      this.active--;
      this.drain();
    }
  }
}
export class InFlight {
  private counts = new Map<string, number>();
  private waiters = new Map<string, Array<() => void>>();
  enter(id: string): () => void {
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const count = this.counts.get(id)! - 1;
      if (count) this.counts.set(id, count);
      else {
        this.counts.delete(id);
        for (const f of this.waiters.get(id) ?? []) f();
        this.waiters.delete(id);
      }
    };
  }
  async wait(id: string) {
    if (!this.counts.has(id)) return;
    await new Promise<void>((resolve) =>
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]),
    );
  }
  async drain() {
    await Promise.all([...this.counts.keys()].map((id) => this.wait(id)));
  }
}
