import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import type { BaseWindow } from "electron";

export interface NativeCursorEvent {
  readonly x: number;
  readonly y: number;
}

export interface WindowsDragHelperEvents {
  move: [event: NativeCursorEvent];
  release: [event: NativeCursorEvent];
  cancel: [event: NativeCursorEvent];
  error: [error: Error];
}

export class WindowsDragHelper extends EventEmitter<WindowsDragHelperEvents> {
  readonly #executablePath: string;
  #child: ChildProcessWithoutNullStreams | null = null;
  #ready: Promise<void> | null = null;
  #disposed = false;

  constructor(executablePath: string) {
    super();
    this.#executablePath = executablePath;
  }

  async warmup(): Promise<void> {
    await this.#ensureStarted();
  }

  async begin(window: BaseWindow): Promise<void> {
    await this.#sendWindowCommand("BEGIN", window);
  }

  async monitor(window: BaseWindow): Promise<void> {
    await this.#sendWindowCommand("MONITOR", window);
  }

  dispose(): void {
    this.#disposed = true;
    const child = this.#child;
    this.#child = null;
    this.#ready = null;
    if (child === null) return;
    if (!child.killed) {
      child.stdin.write("QUIT\n");
      child.stdin.end();
      child.kill();
    }
  }

  async #ensureStarted(): Promise<void> {
    if (this.#disposed) {
      throw new Error("Windows drag helper is disposed");
    }
    if (this.#ready !== null) return this.#ready;
    this.#ready = new Promise<void>((resolve, reject) => {
      const child = spawn(this.#executablePath, [], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.#child = child;
      const lines = readline.createInterface({ input: child.stdout });
      let resolved = false;
      lines.on("line", (line) => {
        if (line === "READY") {
          resolved = true;
          resolve();
          return;
        }
        this.#handleLine(line);
      });
      child.stderr.on("data", (chunk) => {
        this.emit("error", new Error(String(chunk)));
      });
      child.once("error", (error) => {
        if (!resolved) reject(error);
        else this.emit("error", error);
      });
      child.once("exit", (code) => {
        const wasCurrentChild = this.#child === child;
        if (this.#child === child) {
          this.#child = null;
          this.#ready = null;
        }
        if (!resolved) {
          reject(new Error(`Windows drag helper exited with ${String(code)}`));
        } else if (!this.#disposed && wasCurrentChild) {
          this.emit(
            "error",
            new Error(`Windows drag helper exited unexpectedly with ${String(code)}`),
          );
        }
      });
    });
    return this.#ready;
  }

  async #sendWindowCommand(
    command: "BEGIN" | "MONITOR",
    window: BaseWindow,
  ): Promise<void> {
    if (window.isDestroyed()) {
      throw new Error("Cannot drag a destroyed window");
    }
    await this.#ensureStarted();
    const child = this.#child;
    if (child === null) throw new Error("Windows drag helper did not start");
    const handle = window.getNativeWindowHandle();
    const rawHandle = handle.length >= 8
      ? handle.readBigUInt64LE(0)
      : BigInt(handle.readUInt32LE(0));
    child.stdin.write(`${command} ${rawHandle.toString(16)}\n`);
  }

  #handleLine(line: string): void {
    const [kind, rawX, rawY] = line.trim().split(/\s+/);
    const x = Number(rawX);
    const y = Number(rawY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      this.emit("error", new Error(`Invalid native drag event: ${line}`));
      return;
    }
    const event = { x, y };
    if (kind === "MOVE") this.emit("move", event);
    else if (kind === "RELEASE") this.emit("release", event);
    else if (kind === "CANCEL") this.emit("cancel", event);
    else this.emit("error", new Error(`Native drag helper error: ${line}`));
  }
}
