import { existsSync } from "node:fs";
import path from "node:path";

export interface ElectronDockResourceOptions {
  readonly nativeHelperPath?: string;
}

export interface ElectronDockResources {
  readonly rendererHtmlPath: string;
  readonly internalPreloadPath: string;
  readonly nativeHelperPath: string;
}

export function resolveElectronDockResources(
  options: ElectronDockResourceOptions = {},
): ElectronDockResources {
  const distRoot = path.resolve(import.meta.dirname, "..");
  const nativeHelperPath = options.nativeHelperPath
    ?? unpackedAsarPath(
      path.join(distRoot, "native", "windows-drag-helper.exe"),
    );
  if (!existsSync(nativeHelperPath)) {
    throw new Error(
      "Electron Dock native helper was not found at "
      + `${nativeHelperPath}. If the app is packaged with ASAR, add `
      + "`node_modules/@tools-qweer/electron-dock/dist/native/**` "
      + "to electron-builder asarUnpack, or pass nativeHelperPath explicitly.",
    );
  }
  return {
    rendererHtmlPath: path.join(distRoot, "renderer", "index.html"),
    internalPreloadPath: path.join(distRoot, "preload", "internal.cjs"),
    nativeHelperPath,
  };
}

function unpackedAsarPath(resourcePath: string): string {
  const marker = `${path.sep}app.asar${path.sep}`;
  return resourcePath.includes(marker)
    ? resourcePath.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`)
    : resourcePath;
}
