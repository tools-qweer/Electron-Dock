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
  #generation = 0;
  readonly #expectedStops = new WeakSet<ChildProcessWithoutNullStreams>();
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

  /**
   * A native drag loop cannot consume another stdin command until the mouse
   * button is released. Terminating that one helper process is therefore the
   * only reliable out-of-band cancellation mechanism. The next operation
   * starts a fresh helper lazily.
   */
  cancelActive(): void {
    this.#stopCurrentChild();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopCurrentChild();
  }

  async #ensureStarted(): Promise<void> {
    if (this.#disposed) {
      throw new Error("Windows drag helper is disposed");
    }
    if (this.#ready !== null) return this.#ready;
    const generation = ++this.#generation;
    const ready = new Promise<void>((resolve, reject) => {
      const child = spawn(this.#executablePath, [], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.#child = child;
      const lines = readline.createInterface({ input: child.stdout });
      let resolved = false;
      let settled = false;
      const isCurrent = (): boolean => (
        this.#child === child && this.#generation === generation
      );
      const resolveStartup = (): void => {
        if (settled) return;
        settled = true;
        resolved = true;
        resolve();
      };
      const rejectStartup = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const reportProcessError = (error: Error): void => {
        if (!isCurrent() || this.#expectedStops.has(child)) return;
        if (!resolved) {
          this.#clearCurrentChild(child, generation);
          rejectStartup(error);
          return;
        }
        this.emit("error", error);
      };
      lines.on("line", (line) => {
        if (!isCurrent() || this.#expectedStops.has(child)) return;
        if (line === "READY") {
          resolveStartup();
          return;
        }
        this.#handleLine(line);
      });
      child.stderr.on("data", (chunk) => {
        reportProcessError(new Error(String(chunk)));
      });
      child.stdin.on("error", (error) => {
        reportProcessError(error);
      });
      child.once("error", (error) => {
        reportProcessError(error);
      });
      child.once("exit", (code) => {
        const wasCurrentChild = isCurrent();
        const expected = this.#expectedStops.has(child);
        if (wasCurrentChild) this.#clearCurrentChild(child, generation);
        lines.close();
        if (!resolved) {
          rejectStartup(new Error(
            expected
              ? "Windows drag helper was cancelled before startup"
              : `Windows drag helper exited with ${String(code)}`,
          ));
        } else if (!this.#disposed && !expected && wasCurrentChild) {
          this.emit(
            "error",
            new Error(`Windows drag helper exited unexpectedly with ${String(code)}`),
          );
        }
      });
    });
    this.#ready = ready;
    return ready;
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
    await new Promise<void>((resolve, reject) => {
      if (this.#child !== child || this.#expectedStops.has(child)) {
        reject(new Error("Windows drag helper was cancelled"));
        return;
      }
      try {
        child.stdin.write(
          `${command} ${rawHandle.toString(16)}\n`,
          (error?: Error | null) => {
            if (error) reject(error);
            else resolve();
          },
        );
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
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

  #stopCurrentChild(): void {
    const child = this.#child;
    if (child === null) return;
    this.#expectedStops.add(child);
    this.#child = null;
    this.#ready = null;
    ++this.#generation;
    if (!child.killed) {
      try {
        child.kill();
      } catch (error: unknown) {
        process.stderr.write(
          `Windows drag helper termination failed: ${String(error)}\n`,
        );
      }
    }
  }

  #clearCurrentChild(
    child: ChildProcessWithoutNullStreams,
    generation: number,
  ): void {
    if (this.#child !== child || this.#generation !== generation) return;
    this.#child = null;
    this.#ready = null;
  }
}
