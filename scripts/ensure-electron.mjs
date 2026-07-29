import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const electronPackagePath = require.resolve("electron/package.json");
const electronPackageRoot = path.dirname(electronPackagePath);

if (!installedElectronPath()) {
  const installerPath = path.join(electronPackageRoot, "install.js");
  const result = spawnSync(process.execPath, [installerPath], {
    cwd: electronPackageRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Electron installer exited with status ${String(result.status)}.`,
    );
  }
}

const electronPath = installedElectronPath();
if (!electronPath) {
  throw new Error(
    "Electron's package is installed, but its executable is still missing.",
  );
}

console.log(`ELECTRON_READY ${electronPath}`);

function installedElectronPath() {
  const pathFile = path.join(electronPackageRoot, "path.txt");
  if (!existsSync(pathFile)) return null;
  const relativePath = readFileSync(pathFile, "utf8").trim();
  if (relativePath.length === 0) return null;
  const executablePath = path.join(electronPackageRoot, "dist", relativePath);
  return existsSync(executablePath) ? executablePath : null;
}
