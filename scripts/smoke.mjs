import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const electronBinary = process.platform === "win32"
  ? path.join(root, "node_modules", "electron", "dist", "electron.exe")
  : path.join(root, "node_modules", ".bin", "electron");
const smokeUserData = path.join(
  os.tmpdir(),
  `electron-native-dock-smoke-${process.pid}`,
);

try {
  const writeRun = await runElectronPhase("write");
  const reparentMarker = findMarker(writeRun.stdout, "REPARENT_SMOKE ");
  if (writeRun.code !== 0 || reparentMarker === undefined) {
    reportFailure(writeRun);
    throw new Error(
      `Electron reparent smoke failed with exit code ${String(writeRun.code)}`,
    );
  }
  const reparent = JSON.parse(
    reparentMarker.slice("REPARENT_SMOKE ".length),
  );
  for (const key of [
    "sameWebContents",
    "floated",
    "redocked",
    "windowLeakFree",
    "rendererStateStable",
    "rendererStateWasMutated",
    "rendererHostTransitionsAreCorrect",
    "mainMenuHidden",
    "floatingMenuHidden",
    "panelCountCorrect",
    "panelWebContentsUnique",
    "tabSwitchCorrect",
    "inactiveWebContentsPreserved",
    "splitResizeCorrect",
    "edgePreviewSlotIsEmpty",
    "localPreviewMatchesCommit",
    "workspacePreviewMatchesCommit",
    "localAndWorkspaceKeepFloatingWidth",
    "minimumConstrainedRoundTripStable",
    "defaultFloatKeepsDockedContentSize",
    "persistenceSeeded",
  ]) {
    if (reparent[key] !== true) {
      throw new Error(
        `Electron reparent assertion ${key} failed: ${JSON.stringify(reparent)}`,
      );
    }
  }

  const restoreRun = await runElectronPhase("restore");
  const persistenceMarker = findMarker(
    restoreRun.stdout,
    "PERSISTENCE_SMOKE ",
  );
  if (restoreRun.code !== 0 || persistenceMarker === undefined) {
    reportFailure(restoreRun);
    throw new Error(
      `Electron persistence smoke failed with exit code ${String(restoreRun.code)}`,
    );
  }
  const persistence = JSON.parse(
    persistenceMarker.slice("PERSISTENCE_SMOKE ".length),
  );
  if (!Object.values(persistence).every((value) => value === true)) {
    throw new Error(
      `Electron persistence assertions failed: ${JSON.stringify(persistence)}`,
    );
  }

  process.stdout.write(`${reparentMarker}\n`);
  process.stdout.write(`${persistenceMarker}\n`);
} finally {
  await rm(smokeUserData, { recursive: true, force: true });
}

async function runElectronPhase(phase) {
  const child = spawn(
    electronBinary,
    [
      path.join("dist", "demo", "index.js"),
      "--native-dock-smoke",
      `--native-dock-smoke-phase=${phase}`,
      `--user-data-dir=${smokeUserData}`,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const timeout = setTimeout(() => {
    child.kill();
  }, 30_000);
  const code = await new Promise((resolve) => {
    child.once("exit", resolve);
  });
  clearTimeout(timeout);
  return { code, stdout, stderr };
}

function findMarker(stdout, prefix) {
  return stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith(prefix));
}

function reportFailure(run) {
  process.stderr.write(run.stdout);
  process.stderr.write(run.stderr);
}
