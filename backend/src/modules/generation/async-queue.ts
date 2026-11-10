export const TIMED_OUT = Symbol('timed out');

/** A queue you can wait on, with an optional timeout (used for SSE keep-alives). */
export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private waiting: ((value: T | typeof TIMED_OUT) => void) | undefined;

  push(item: T): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve(item);
    } else {
      this.items.push(item);
    }
  }

  next(timeoutMs: number): Promise<T | typeof TIMED_OUT> {
    const ready = this.items.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting = undefined;
        resolve(TIMED_OUT);
      }, timeoutMs);
      this.waiting = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
    });
  }
}
