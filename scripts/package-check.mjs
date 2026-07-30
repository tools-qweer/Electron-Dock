import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { verifyTrackedNativeHelper } from "./build-native-helper.mjs";

const root = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const packageLock = JSON.parse(
  await readFile(path.join(root, "package-lock.json"), "utf8"),
);

const expected = {
  name: "@tools-qweer/electron-dock",
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

const alphaVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alpha\.(0|[1-9]\d*)$/u;
if (
  typeof packageJson.version !== "string"
  || !alphaVersionPattern.test(packageJson.version)
) {
  throw new Error(
    "package.json version must be a valid SemVer alpha prerelease; received "
    + JSON.stringify(packageJson.version),
  );
}
if (
  packageLock.version !== packageJson.version
  || packageLock.packages?.[""]?.version !== packageJson.version
) {
  throw new Error(
    "package-lock.json root versions must match package.json version "
    + packageJson.version,
  );
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
if (packageJson.peerDependencies.electron !== "^43.1.1") {
  throw new Error("The current alpha must declare Electron ^43.1.1");
}
if (packageJson.engines?.node !== ">=22.12") {
  throw new Error("The current alpha must require Node.js >=22.12");
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
  "examples/attach-existing-window/package.json",
  "examples/attach-existing-window/main.mjs",
  "examples/attach-existing-window/preload.cjs",
  "examples/attach-existing-window/host.html",
  "examples/attach-existing-window/panel.html",
  "examples/attach-existing-window/README.md",
  ".github/workflows/release.yml",
  "docs/RELEASING.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
];

for (const relativePath of requiredFiles) {
  await access(path.join(root, relativePath));
}
const requiredPackageFileEntries = [
  "docs/",
  "examples/",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
];
for (const entry of requiredPackageFileEntries) {
  if (!packageJson.files?.includes(entry)) {
    throw new Error(`package.json files must include ${entry}`);
  }
}
await verifyReleaseDocuments(root, packageJson.version);
await verifyAttachExample(root);
await verifyTrackedNativeHelper(root);
await verifyRendererBundle(root);

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

async function verifyRendererBundle(projectRoot) {
  const rendererPath = path.join(
    projectRoot,
    "dist",
    "renderer",
    "index.js",
  );
  const renderer = await readFile(rendererPath, "utf8");
  const expectedMarker =
    "/* electron-dock-renderer-build: production,minified */";
  if (!renderer.startsWith(expectedMarker)) {
    throw new Error(
      "Renderer bundle is missing the production/minified build marker",
    );
  }

  const developmentSignatures = [
    "react.development.js",
    "react-dom-client.development.js",
    "react-jsx-runtime.development.js",
    "Download the React DevTools for a better development experience",
    "Each child in a list should have a unique",
  ];
  const matchedSignature = developmentSignatures.find((signature) =>
    renderer.includes(signature)
  );
  if (matchedSignature !== undefined) {
    throw new Error(
      "Renderer bundle contains a React development signature: "
      + matchedSignature,
    );
  }

  // The production shell is intentionally small. This ceiling is generous
  // enough for normal growth while still catching an accidentally unminified
  // React renderer before publication.
  const maximumBytes = 768 * 1024;
  const byteLength = Buffer.byteLength(renderer);
  if (byteLength > maximumBytes) {
    throw new Error(
      `Renderer bundle is unexpectedly large (${byteLength} bytes; `
      + `maximum ${maximumBytes})`,
    );
  }
}

async function verifyReleaseDocuments(projectRoot, version) {
  const changelog = await readFile(
    path.join(projectRoot, "CHANGELOG.md"),
    "utf8",
  );
  if (!changelog.includes(`## [${version}]`)) {
    throw new Error(
      `CHANGELOG.md must include a section for package version ${version}`,
    );
  }
}

async function verifyAttachExample(projectRoot) {
  const exampleRoot = path.join(
    projectRoot,
    "examples",
    "attach-existing-window",
  );
  const examplePackage = JSON.parse(
    await readFile(path.join(exampleRoot, "package.json"), "utf8"),
  );
  if (
    examplePackage.private !== true
    || examplePackage.main !== "main.mjs"
    || typeof examplePackage.scripts?.start !== "string"
  ) {
    throw new Error(
      "The attach-existing-window example must be private and runnable",
    );
  }

  const source = await Promise.all([
    readFile(path.join(exampleRoot, "main.mjs"), "utf8"),
    readFile(path.join(exampleRoot, "preload.cjs"), "utf8"),
  ]).then((files) => files.join("\n"));
  if (
    !source.includes('"@tools-qweer/electron-dock"')
    || !source.includes('"@tools-qweer/electron-dock/preload"')
  ) {
    throw new Error(
      "The attach example must consume Electron Dock through public exports",
    );
  }
  const privateSignatures = [
    "/dist/",
    "/src/",
    "DockWorkspaceHost",
    "ElectronDockInternal",
    "electron-dock://",
  ];
  const privateSignature = privateSignatures.find((signature) =>
    source.includes(signature)
  );
  if (privateSignature !== undefined) {
    throw new Error(
      "The attach example depends on a private Electron Dock detail: "
      + privateSignature,
    );
  }
}
