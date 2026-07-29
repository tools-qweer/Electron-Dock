import { describe, expect, it, vi } from "vitest";
import { PersistenceWriteQueue } from "./persistence-write-queue.js";

describe("PersistenceWriteQueue", () => {
  it("surfaces a failed write through flush instead of swallowing it", async () => {
    const failure = new Error("atomic replace failed");
    const onFailure = vi.fn();
    const queue = new PersistenceWriteQueue(onFailure);

    queue.enqueue(async () => {
      throw failure;
    });

    await expect(queue.flush()).rejects.toBe(failure);
    expect(onFailure).toHaveBeenCalledWith(failure);
  });

  it("continues serially and clears an obsolete failure after a newer full write", async () => {
    const writes: string[] = [];
    const queue = new PersistenceWriteQueue(() => {});
    queue.enqueue(() => {
      writes.push("failed");
      throw new Error("first failed");
    });
    queue.enqueue(() => {
      writes.push("latest");
    });

    await expect(queue.flush()).resolves.toBeUndefined();
    expect(writes).toEqual(["failed", "latest"]);
  });

  it("does not lose an undefined rejection value", async () => {
    const queue = new PersistenceWriteQueue(() => {});
    queue.enqueue(() => Promise.reject(undefined));

    await expect(queue.flush()).rejects.toBeUndefined();
  });
});
