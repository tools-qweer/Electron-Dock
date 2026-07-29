import path from "node:path";
import { describe, expect, it } from "vitest";
import { readPortableExecutableMachine } from "./build-native-helper.mjs";

describe("tracked native helper architecture", () => {
  it("is an AMD64 PE image", async () => {
    const helper = path.resolve(
      import.meta.dirname,
      "..",
      "native",
      "bin",
      "windows-drag-helper.exe",
    );
    await expect(readPortableExecutableMachine(helper)).resolves.toBe(0x8664);
  });
});
