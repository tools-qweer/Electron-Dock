type MaybePromise<T> = T | Promise<T>;

/**
 * Serializes atomic layout writes without converting a failed write into a
 * successful flush. After storage fails, the next flush can retry the latest
 * full layout. Newer writes supersede older retries.
 */
export class PersistenceWriteQueue {
  readonly #onFailure: (error: unknown) => void;
  #tail = Promise.resolve();
  #retry: (() => MaybePromise<void>) | null = null;

  constructor(onFailure: (error: unknown) => void) {
    this.#onFailure = onFailure;
  }

  enqueue(operation: () => MaybePromise<void>): void {
    this.#retry = null;
    const write = this.#tail.catch(() => undefined).then(operation);
    this.#tail = write;
    void write.catch((error: unknown) => {
      if (this.#tail === write) this.#retry = operation;
      this.#onFailure(error);
    });
  }

  flush(): Promise<void> {
    if (this.#retry) this.enqueue(this.#retry);
    return this.#tail;
  }
}
