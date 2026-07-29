import { spawn } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "fixtures", "package-consumer");
const runElectron = process.argv.includes("--electron");
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "electron-dock-package-consumer-"),
);
const packDirectory = path.join(temporaryRoot, "pack");
const consumerDirectory = path.join(temporaryRoot, "consumer");

try {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error(
      "Electron Dock package consumers require Windows x64; received "
      + `${process.platform} ${process.arch}`,
    );
  }

  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    cp(fixture, consumerDirectory, { recursive: true }),
  ]);

  await runNpm(
    ["pack", "--json", "--pack-destination", packDirectory],
    root,
  );
  const archives = (await readdir(packDirectory)).filter((entry) =>
    entry.endsWith(".tgz")
  );
  if (archives.length !== 1) {
    throw new Error(
      `Expected exactly one package archive; received ${archives.join(", ")}`,
    );
  }
  const archivePath = path.join(packDirectory, archives[0]);

  const rootPackage = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const electronVersion = rootPackage.devDependencies?.electron;
  const typescriptVersion = rootPackage.devDependencies?.typescript;
  if (
    typeof electronVersion !== "string"
    || typeof typescriptVersion !== "string"
  ) {
    throw new Error(
      "package.json must pin Electron and TypeScript development versions",
    );
  }

  await runNpm(
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--save-dev",
      "--save-exact",
      archivePath,
      `electron@${electronVersion}`,
      `typescript@${typescriptVersion}`,
    ],
    consumerDirectory,
  );

  await runNpm(["run", "typecheck"], consumerDirectory);
  await runNpm(["run", "resolve"], consumerDirectory);
  await runNpm(["run", "runtime:core"], consumerDirectory);
  await verifyInstalledPayload(consumerDirectory);

  if (runElectron) {
    await installElectronBinary(consumerDirectory);
    await runElectronConsumer(consumerDirectory, temporaryRoot);
  }

  const archive = await stat(archivePath);
  process.stdout.write(
    "PACKAGE_CONSUMER_OK "
    + `archive=${path.basename(archivePath)} bytes=${archive.size} `
    + "types=root/core/preload imports=root/core/preload "
    + `electron=${runElectron ? "passed" : "skipped"}\n`,
  );
} finally {
  await rm(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 4,
    retryDelay: 250,
  });
}

async function verifyInstalledPayload(consumerRoot) {
  const packageRoot = path.join(
    consumerRoot,
    "node_modules",
    "@tools-qweer",
    "electron-dock",
  );
  const required = [
    "dist/native/windows-drag-helper.exe",
    "dist/preload/internal.cjs",
    "dist/renderer/index.html",
    "dist/renderer/index.js",
    "dist/renderer/styles.css",
  ];
  for (const relativePath of required) {
    const installedPath = path.join(packageRoot, relativePath);
    await access(installedPath);
    const installed = await stat(installedPath);
    if (!installed.isFile() || installed.size === 0) {
      throw new Error(`Installed package asset is invalid: ${relativePath}`);
    }
  }

  const nativeHeader = await readFile(
    path.join(packageRoot, required[0]),
  );
  if (nativeHeader[0] !== 0x4d || nativeHeader[1] !== 0x5a) {
    throw new Error("Installed native helper does not have an MZ header");
  }
}

async function runElectronConsumer(consumerRoot, temporaryDirectory) {
  const executable = path.join(
    consumerRoot,
    "node_modules",
    "electron",
    "dist",
    "electron.exe",
  );
  await access(executable);
  const userData = path.join(temporaryDirectory, "electron-user-data");
  const result = await runCommand(
    executable,
    [consumerRoot, `--user-data-dir=${userData}`],
    consumerRoot,
    {},
    { capture: true, timeoutMs: 45_000 },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (!result.stdout.includes("ELECTRON_CONSUMER_OK ")) {
    throw new Error(
      "Electron package consumer exited without ELECTRON_CONSUMER_OK",
    );
  }
}

async function installElectronBinary(consumerRoot) {
  const installScript = path.join(
    consumerRoot,
    "node_modules",
    "electron",
    "install.js",
  );
  await access(installScript);
  await runCommand(process.execPath, [installScript], consumerRoot);
}

async function runNpm(args, cwd, extraEnv = {}) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath !== undefined && npmExecPath.length > 0) {
    await runCommand(
      process.execPath,
      [npmExecPath, ...args],
      cwd,
      extraEnv,
    );
    return;
  }
  await runCommand(
    process.platform === "win32" ? "npm.cmd" : "npm",
    args,
    cwd,
    extraEnv,
  );
}

async function runCommand(
  command,
  args,
  cwd,
  extraEnv = {},
  options = {},
) {
  const capture = options.capture === true;
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      ...extraEnv,
    },
    shell: false,
    stdio: capture
      ? ["ignore", "pipe", "pipe"]
      : ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  if (capture) {
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
  }

  let timedOut = false;
  const timeout = options.timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (timeout !== undefined) clearTimeout(timeout);
  if (timedOut || code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed `
      + `(code=${String(code)}, timedOut=${String(timedOut)})`
      + (capture ? `\nstdout:\n${stdout}\nstderr:\n${stderr}` : ""),
    );
  }
  return { stdout, stderr };
}
