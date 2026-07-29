type MaybePromise<T> = T | Promise<T>;

/**
 * Serializes atomic layout writes without converting a failed write into a
 * successful flush. A newer full-layout write may supersede an earlier
 * failure; until then flush() rejects with the original storage error.
 */
export class PersistenceWriteQueue {
  readonly #onFailure: (error: unknown) => void;
  #tail = Promise.resolve();
  #failure: unknown;
  #hasFailure = false;
  #revision = 0;

  constructor(onFailure: (error: unknown) => void) {
    this.#onFailure = onFailure;
  }

  enqueue(operation: () => MaybePromise<void>): void {
    const revision = ++this.#revision;
    this.#tail = this.#tail.then(async () => {
      try {
        await operation();
        if (revision === this.#revision) {
          this.#failure = undefined;
          this.#hasFailure = false;
        }
      } catch (error) {
        this.#failure = error;
        this.#hasFailure = true;
        this.#onFailure(error);
      }
    });
  }

  async flush(): Promise<void> {
    await this.#tail;
    if (this.#hasFailure) throw this.#failure;
  }
}
