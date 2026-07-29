import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { BaseWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { WindowsDragHelper } from "./windows-drag-helper.js";

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  readonly kill = vi.fn(() => {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", null));
    return true;
  });
}

function childProcess(child: FakeChildProcess): ChildProcessWithoutNullStreams {
  return child as unknown as ChildProcessWithoutNullStreams;
}

function fakeWindow(): BaseWindow {
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(0x1234n);
  return {
    isDestroyed: () => false,
    getNativeWindowHandle: () => handle,
  } as unknown as BaseWindow;
}

async function ready(
  helper: WindowsDragHelper,
  child: FakeChildProcess,
): Promise<void> {
  const warming = helper.warmup();
  child.stdout.write("READY\n");
  await warming;
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe("WindowsDragHelper", () => {
  it("kills a blocked helper, ignores its stale output, and restarts lazily", async () => {
    const first = new FakeChildProcess();
    const second = new FakeChildProcess();
    spawnMock
      .mockReturnValueOnce(childProcess(first))
      .mockReturnValueOnce(childProcess(second));
    const helper = new WindowsDragHelper("windows-drag-helper.exe");
    const move = vi.fn();
    const error = vi.fn();
    helper.on("move", move);
    helper.on("error", error);

    await ready(helper, first);
    await helper.begin(fakeWindow());
    expect(first.stdin.read()?.toString()).toBe("BEGIN 1234\n");

    helper.cancelActive();
    expect(first.kill).toHaveBeenCalledOnce();
    first.stdout.write("MOVE 10 20\n");
    first.stdout.write("RELEASE 10 20\n");

    const secondStart = helper.begin(fakeWindow());
    second.stdout.write("READY\n");
    await secondStart;
    second.stdout.write("MOVE 30 40\n");
    await vi.waitFor(() => expect(move).toHaveBeenCalledWith({ x: 30, y: 40 }));

    expect(move).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    helper.dispose();
  });

  it("rejects a startup that is cancelled before READY", async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValueOnce(childProcess(child));
    const helper = new WindowsDragHelper("windows-drag-helper.exe");

    const warming = helper.warmup();
    helper.cancelActive();

    await expect(warming).rejects.toThrow("cancelled before startup");
    expect(child.kill).toHaveBeenCalledOnce();
    helper.dispose();
  });

  it("surfaces command write failures without leaving an unhandled stream error", async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValueOnce(childProcess(child));
    const helper = new WindowsDragHelper("windows-drag-helper.exe");
    const error = vi.fn();
    helper.on("error", error);
    await ready(helper, child);
    vi.spyOn(child.stdin, "write").mockImplementationOnce(() => {
      throw new Error("EPIPE");
    });

    await expect(helper.begin(fakeWindow())).rejects.toThrow("EPIPE");
    expect(error).not.toHaveBeenCalled();
    helper.dispose();
  });

  it("reports an unexpected ready helper exit but not an intentional stop", async () => {
    const unexpected = new FakeChildProcess();
    const intentional = new FakeChildProcess();
    spawnMock
      .mockReturnValueOnce(childProcess(unexpected))
      .mockReturnValueOnce(childProcess(intentional));
    const helper = new WindowsDragHelper("windows-drag-helper.exe");
    const error = vi.fn();
    helper.on("error", error);

    await ready(helper, unexpected);
    unexpected.emit("exit", 7);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("unexpectedly") }),
    );

    await ready(helper, intentional);
    helper.dispose();
    await Promise.resolve();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
