import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const HELPER_NAME = "windows-drag-helper.exe";
const MANIFEST_NAME = "windows-drag-helper.manifest.json";
const PE_MACHINE_AMD64 = 0x8664;

export async function buildNativeHelper(root, dist) {
  if (process.platform !== "win32") return;

  const paths = helperPaths(root);
  const manifest = await verifyTrackedNativeHelper(root);
  const compiler = compilerPath();
  const compilerInfo = await stat(compiler).catch(() => null);
  const nativeDist = path.join(dist, "native");
  await mkdir(nativeDist, { recursive: true });
  const output = path.join(nativeDist, HELPER_NAME);
  const sourceInfo = await stat(paths.source);
  const fallbackInfo = await stat(paths.fallback);
  const outputInfo = await stat(output).catch(() => null);
  const compilerAvailable = compilerInfo?.isFile() === true;
  const newestInputMtime = compilerAvailable
    ? sourceInfo.mtimeMs
    : Math.max(sourceInfo.mtimeMs, fallbackInfo.mtimeMs);

  if (
    !compilerAvailable
    && outputInfo !== null
    && outputInfo.mtimeMs >= newestInputMtime
  ) {
    return;
  }

  const temporaryOutput = path.join(
    nativeDist,
    `windows-drag-helper-${process.pid}.exe`,
  );
  await rm(temporaryOutput, { force: true });
  try {
    if (compilerAvailable) {
      await compileHelper(compiler, paths.source, temporaryOutput, root);
    } else {
      await copyFile(paths.fallback, temporaryOutput);
      process.stdout.write(
        `Native helper: using verified Windows x64 fallback `
        + `(${manifest.binarySha256.slice(0, 12)}...)\n`,
      );
    }
    await verifyX64PortableExecutable(temporaryOutput);
    await replaceOutput(temporaryOutput, output);
  } catch (error) {
    await rm(temporaryOutput, { force: true });
    throw error;
  }
}

export async function refreshNativeHelperFallback(root) {
  if (process.platform !== "win32") {
    throw new Error("The tracked native helper can only be built on Windows");
  }
  const compiler = compilerPath();
  const compilerInfo = await stat(compiler).catch(() => null);
  if (compilerInfo?.isFile() !== true) {
    throw new Error(
      `Cannot refresh the tracked native helper because csc.exe is missing: ${compiler}`,
    );
  }

  const paths = helperPaths(root);
  await mkdir(path.dirname(paths.fallback), { recursive: true });
  const temporaryOutput = path.join(
    path.dirname(paths.fallback),
    `windows-drag-helper-${process.pid}.exe`,
  );
  await rm(temporaryOutput, { force: true });
  try {
    await compileHelper(compiler, paths.source, temporaryOutput, root);
    await verifyX64PortableExecutable(temporaryOutput);
    await replaceOutput(temporaryOutput, paths.fallback);
    const manifest = {
      schemaVersion: 1,
      target: "win32-x64",
      source: "../windows-drag-helper.cs",
      binary: HELPER_NAME,
      sourceSha256: await sha256(paths.source),
      binarySha256: await sha256(paths.fallback),
    };
    const temporaryManifest = `${paths.manifest}.${process.pid}.tmp`;
    await writeFile(
      temporaryManifest,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    await replaceOutput(temporaryManifest, paths.manifest);
    process.stdout.write(
      `TRACKED_NATIVE_HELPER_REFRESHED ${manifest.binarySha256}\n`,
    );
  } catch (error) {
    await rm(temporaryOutput, { force: true });
    throw error;
  }
}

function helperPaths(root) {
  return {
    source: path.join(root, "native", "windows-drag-helper.cs"),
    fallback: path.join(root, "native", "bin", HELPER_NAME),
    manifest: path.join(root, "native", "bin", MANIFEST_NAME),
  };
}

function compilerPath() {
  const frameworkRoot = process.env.WINDIR ?? "C:\\Windows";
  return path.join(
    frameworkRoot,
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  );
}

async function compileHelper(compiler, source, output, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      compiler,
      [
        "/nologo",
        "/optimize+",
        "/target:exe",
        "/platform:x64",
        `/out:${output}`,
        source,
      ],
      {
        cwd,
        windowsHide: true,
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(
        new Error(`Native helper build failed with exit code ${String(code)}`),
      );
    });
  });
}

export async function verifyTrackedNativeHelper(root) {
  const paths = helperPaths(root);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(paths.manifest, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read the tracked native helper manifest: ${paths.manifest}`,
      { cause: error },
    );
  }
  if (
    manifest?.schemaVersion !== 1
    || manifest.target !== "win32-x64"
    || manifest.source !== "../windows-drag-helper.cs"
    || manifest.binary !== HELPER_NAME
    || typeof manifest.sourceSha256 !== "string"
    || typeof manifest.binarySha256 !== "string"
  ) {
    throw new Error(`Invalid tracked native helper manifest: ${paths.manifest}`);
  }

  const [sourceSha256, binarySha256] = await Promise.all([
    sha256(paths.source),
    sha256(paths.fallback),
  ]);
  if (
    sourceSha256 !== manifest.sourceSha256.toLowerCase()
    || binarySha256 !== manifest.binarySha256.toLowerCase()
  ) {
    throw new Error(
      "The tracked Windows native helper does not match its source/manifest. "
      + "Run `npm run native:refresh-fallback` on Windows with csc.exe available.",
    );
  }
  await verifyX64PortableExecutable(paths.fallback);
  return manifest;
}

export async function readPortableExecutableMachine(filePath) {
  const bytes = await readFile(filePath);
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new Error(`Native helper is not a valid MZ executable: ${filePath}`);
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (
    peOffset < 0
    || peOffset + 6 > bytes.length
    || bytes[peOffset] !== 0x50
    || bytes[peOffset + 1] !== 0x45
    || bytes[peOffset + 2] !== 0
    || bytes[peOffset + 3] !== 0
  ) {
    throw new Error(`Native helper has an invalid PE header: ${filePath}`);
  }
  return bytes.readUInt16LE(peOffset + 4);
}

async function verifyX64PortableExecutable(filePath) {
  const machine = await readPortableExecutableMachine(filePath);
  if (machine !== PE_MACHINE_AMD64) {
    throw new Error(
      `Windows drag helper must target PE AMD64 (0x8664); received `
      + `0x${machine.toString(16).padStart(4, "0")} at ${filePath}. `
      + "Run `npm run native:refresh-fallback` with Framework64 csc.exe.",
    );
  }
}

async function sha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function replaceOutput(temporaryOutput, output) {
  try {
    await rm(output, { force: true });
    await rename(temporaryOutput, output);
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? String(error.code)
      : "unknown";
    throw new Error(
      `Unable to replace the Windows drag helper (${code}). `
      + "Close the running demo and build again.",
      { cause: error },
    );
  }
}
