# Attach to an existing BrowserWindow

This example keeps the host page, title area, sidebar, window lifecycle, and
resize policy in the consumer application. Electron Dock is attached only to
the remaining content rectangle through the public `attachWorkspace()` API.

The two consumer panels share one tab group. You can reorder their tabs, float
either panel, redock it, resize the owner window, and confirm that the counter
and input value survive native reparenting.

## Run from a repository checkout

Use Windows x64, Node.js 22.12 or newer, and Electron 43:

```powershell
cd examples\attach-existing-window
npm install
npm start
```

The local `file:../..` dependency keeps this example runnable before an Alpha
is published to npm. When copying it into another project, replace that
dependency with an exact published Alpha version.

`preload.cjs` imports only the public
`@tools-qweer/electron-dock/preload` entry. The start script bundles that small
consumer preload because Electron runs panel preloads in a sandbox where
arbitrary package `require()` calls are unavailable at runtime.

The example deliberately does not use private renderer URLs, internal IPC
channels, implementation class names, or library CSS selectors.
