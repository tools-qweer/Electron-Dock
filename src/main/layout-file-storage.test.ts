import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtomicLayoutTextStorage } from "./layout-file-storage.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "electron-dock-layout-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("AtomicLayoutTextStorage", () => {
  it("returns null when the committed file does not exist", async () => {
    const directory = await createTemporaryDirectory();
    const storage = new AtomicLayoutTextStorage(
      join(directory, "layout.json"),
    );

    await expect(storage.readText()).resolves.toBeNull();
  });

  it("reads an existing UTF-8 layout document", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = join(directory, "layout.json");
    await writeFile(filePath, '{"标题":"组件层级"}', "utf8");

    const storage = new AtomicLayoutTextStorage(filePath);

    await expect(storage.readText()).resolves.toBe('{"标题":"组件层级"}');
  });

  it("creates missing parent directories and commits the complete value", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = join(directory, "nested", "layout.json");
    const storage = new AtomicLayoutTextStorage(filePath);

    await storage.writeTextAtomically('{"version":1}');

    await expect(readFile(filePath, "utf8")).resolves.toBe('{"version":1}');
    await expect(readdir(join(directory, "nested"))).resolves.toEqual([
      "layout.json",
    ]);
  });

  it("atomically replaces an existing file on Windows without temp residue", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = join(directory, "layout.json");
    const storage = new AtomicLayoutTextStorage(filePath);
    await storage.writeTextAtomically("first");

    await storage.writeTextAtomically("second");

    await expect(storage.readText()).resolves.toBe("second");
    await expect(readdir(directory)).resolves.toEqual(["layout.json"]);
  });

  it("cleans the sibling temporary file when the final rename fails", async () => {
    const directory = await createTemporaryDirectory();
    const targetDirectory = join(directory, "layout.json");
    await mkdir(targetDirectory);
    await writeFile(join(targetDirectory, "keep.txt"), "keep", "utf8");
    const storage = new AtomicLayoutTextStorage(targetDirectory);

    await expect(storage.writeTextAtomically("replacement")).rejects.toThrow();

    expect(await readdir(directory)).toEqual(["layout.json"]);
    await expect(
      readFile(join(targetDirectory, "keep.txt"), "utf8"),
    ).resolves.toBe("keep");
  });
});
