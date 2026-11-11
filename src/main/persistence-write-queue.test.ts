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

  it("retries the latest full layout once per flush and shares an in-flight retry", async () => {
    const failure = new Error("config file is locked");
    const save = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const queue = new PersistenceWriteQueue(() => {});
    queue.enqueue(save);
    await expect(queue.flush()).rejects.toBe(failure);
    await expect(queue.flush()).rejects.toBe(failure);
    await Promise.all([queue.flush(), queue.flush()]);
    await queue.flush();
    expect(save).toHaveBeenCalledTimes(3);
  });

  it("does not replay a failed layout after a newer layout is queued", async () => {
    const queue = new PersistenceWriteQueue(() => {});
    const stale = vi.fn(() => Promise.reject(new Error("locked")));
    const latest = vi.fn();
    queue.enqueue(stale);
    await expect(queue.flush()).rejects.toThrow("locked");
    queue.enqueue(latest);
    await queue.flush();
    expect(stale).toHaveBeenCalledTimes(1);
    expect(latest).toHaveBeenCalledTimes(1);
  });
});
