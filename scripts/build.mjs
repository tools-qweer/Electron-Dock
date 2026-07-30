import { spawn } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { buildNativeHelper } from "./build-native-helper.mjs";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const publicPreloadEntry = path.join(root, "src/preload/public.ts");
const internalPreloadEntry = path.join(root, "src/preload/index.ts");
const rendererBuildMarker =
  "/* electron-dock-renderer-build: production,minified */";

await Promise.all([
  rm(path.join(dist, "demo"), { recursive: true, force: true }),
  rm(path.join(dist, "main"), { recursive: true, force: true }),
  rm(path.join(dist, "preload"), { recursive: true, force: true }),
  rm(path.join(dist, "renderer"), { recursive: true, force: true }),
  rm(path.join(dist, "public"), { recursive: true, force: true }),
  rm(path.join(dist, "core"), { recursive: true, force: true }),
  rm(path.join(dist, "types"), { recursive: true, force: true }),
]);
await mkdir(path.join(dist, "demo"), { recursive: true });
await mkdir(path.join(dist, "preload"), { recursive: true });
await mkdir(path.join(dist, "renderer"), { recursive: true });
await mkdir(path.join(dist, "public"), { recursive: true });
await mkdir(path.join(dist, "core"), { recursive: true });
await buildNativeHelper(root, dist);

await build({
  entryPoints: [path.join(root, "src/public/index.ts")],
  outfile: path.join(dist, "public/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["electron"],
  sourcemap: true,
});

await build({
  entryPoints: [path.join(root, "src/core/index.ts")],
  outfile: path.join(dist, "core/index.js"),
  bundle: true,
  platform: "neutral",
  format: "esm",
  target: "es2023",
  sourcemap: true,
});

await build({
  entryPoints: [publicPreloadEntry],
  outfile: path.join(dist, "preload/public.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: false,
});

await build({
  entryPoints: [path.join(root, "src/main/index.ts")],
  outfile: path.join(dist, "demo/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["electron"],
  sourcemap: true,
});

await build({
  entryPoints: [internalPreloadEntry],
  outfile: path.join(dist, "preload/index.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: true,
});

await build({
  entryPoints: [internalPreloadEntry],
  outfile: path.join(dist, "preload/internal.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: true,
});

await build({
  entryPoints: [path.join(root, "src/renderer/index.tsx")],
  outfile: path.join(dist, "renderer/index.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome142",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  minify: true,
  legalComments: "none",
  banner: {
    js: rendererBuildMarker,
  },
  sourcemap: true,
});

await cp(
  path.join(root, "src/renderer/index.html"),
  path.join(dist, "renderer/index.html"),
);
await cp(
  path.join(root, "src/renderer/styles.css"),
  path.join(dist, "renderer/styles.css"),
);

await runTypeDeclarationBuild();

async function runTypeDeclarationBuild() {
  const compiler = path.join(root, "node_modules", "typescript", "bin", "tsc");
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [compiler, "-p", path.join(root, "tsconfig.types.json"), "--pretty", "false"],
      {
        cwd: root,
        windowsHide: true,
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Type declaration build failed with exit code ${String(code)}`));
    });
  });
}
