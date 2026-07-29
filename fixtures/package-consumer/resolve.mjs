import { fileURLToPath } from "node:url";
import path from "node:path";

const expected = {
  root: path.join("dist", "public", "index.js"),
  core: path.join("dist", "core", "index.js"),
  preload: path.join("dist", "preload", "public.cjs"),
};

for (const [label, suffix] of Object.entries(expected)) {
  const specifier =
    label === "root"
      ? "@tools-qweer/electron-dock"
      : `@tools-qweer/electron-dock/${label}`;
  const resolved = fileURLToPath(import.meta.resolve(specifier));
  if (!resolved.endsWith(suffix)) {
    throw new Error(`${specifier} resolved unexpectedly: ${resolved}`);
  }
  process.stdout.write(`IMPORT_RESOLVE_OK ${label} ${resolved}\n`);
}
