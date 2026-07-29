import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { verifyTrackedNativeHelper } from "./build-native-helper.mjs";

const root = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);

const expected = {
  name: "@tools-qweer/electron-dock",
  version: "0.2.0-alpha.1",
  license: "MIT",
};

for (const [field, value] of Object.entries(expected)) {
  if (packageJson[field] !== value) {
    throw new Error(
      `package.json ${field} must be ${JSON.stringify(value)}; received `
      + JSON.stringify(packageJson[field]),
    );
  }
}

if (packageJson.private === true) {
  throw new Error("package.json must not be private");
}
if (packageJson.publishConfig?.access !== "public") {
  throw new Error("publishConfig.access must be public for the scoped package");
}
if (packageJson.publishConfig?.tag !== "alpha") {
  throw new Error("publishConfig.tag must be alpha");
}
if (packageJson.peerDependencies?.electron === undefined) {
  throw new Error("Electron must be declared as a peer dependency");
}
if (
  !Array.isArray(packageJson.os)
  || packageJson.os.length !== 1
  || packageJson.os[0] !== "win32"
  || !Array.isArray(packageJson.cpu)
  || packageJson.cpu.length !== 1
  || packageJson.cpu[0] !== "x64"
) {
  throw new Error("The alpha package must be restricted to Windows x64");
}

const requiredFiles = [
  "dist/public/index.js",
  "dist/core/index.js",
  "dist/preload/public.cjs",
  "dist/preload/internal.cjs",
  "dist/types/public/index.d.ts",
  "dist/types/core/index.d.ts",
  "dist/types/preload/public.d.ts",
  "dist/native/windows-drag-helper.exe",
  "native/windows-drag-helper.cs",
  "native/bin/windows-drag-helper.exe",
  "native/bin/windows-drag-helper.manifest.json",
  "LICENSE",
  "README.md",
];

for (const relativePath of requiredFiles) {
  await access(path.join(root, relativePath));
}
await verifyTrackedNativeHelper(root);

for (const [subpath, conditions] of Object.entries(packageJson.exports ?? {})) {
  if (typeof conditions === "string") {
    await access(path.join(root, conditions));
    continue;
  }
  for (const [condition, target] of Object.entries(conditions)) {
    if (typeof target !== "string") {
      throw new Error(`Invalid export target for ${subpath} ${condition}`);
    }
    await access(path.join(root, target));
  }
}

process.stdout.write(
  `PACKAGE_CHECK_OK ${packageJson.name}@${packageJson.version} `
  + `${requiredFiles.length} required files\n`,
);
