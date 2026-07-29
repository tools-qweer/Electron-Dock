import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type {
  AtomicLayoutTextStorage as AtomicLayoutTextStorageContract,
} from "../core/layout-persistence.js";

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function closeQuietly(handle: FileHandle | null): Promise<void> {
  if (handle === null) return;
  try {
    await handle.close();
  } catch {
    // Preserve the original write/replace failure.
  }
}

async function unlinkQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      // Cleanup is best effort and must not hide the original failure.
    }
  }
}

/**
 * Node-backed atomic text storage for persisted dock layouts.
 *
 * Each write is staged in a unique sibling file. The staged bytes are flushed
 * to disk and the file handle is closed before `rename` replaces the committed
 * file, which is required for reliable replacement on Windows.
 */
export class AtomicLayoutTextStorage implements AtomicLayoutTextStorageContract {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async readText(): Promise<string | null> {
    try {
      return await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async writeTextAtomically(value: string): Promise<void> {
    const directory = dirname(this.filePath);
    const temporaryPath = resolve(
      directory,
      `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: FileHandle | null = null;
    let committed = false;

    try {
      await mkdir(directory, { recursive: true });
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(value, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporaryPath, this.filePath);
      committed = true;
    } finally {
      await closeQuietly(handle);
      if (!committed) await unlinkQuietly(temporaryPath);
    }
  }
}
