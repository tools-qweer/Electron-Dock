# Contributing

Electron Dock currently targets Windows x64, Node.js 22.12+, and Electron 43.
Changes should preserve the same live `WebContentsView` while a panel moves
between docked and floating hosts.

## Local setup

```powershell
git clone https://github.com/tools-qweer/Electron-Dock.git
cd Electron-Dock
npm ci
npm run check
```

Run the interactive demo with:

```powershell
npm start
```

## Change boundaries

- Put pure layout state, geometry, validation, and persistence in `src/core`.
- Keep Electron lifecycle, windows, views, IPC authority, and native drag in
  `src/main`.
- Keep the consumer panel API narrow in `src/preload/public.ts`; Shell-only
  mutation authority belongs in the internal preload.
- Put Dock-owned presentation and pointer gestures in `src/renderer`.
- Do not make a consumer application depend on private renderer URLs, CSS
  class names, internal IPC channels, or persistence schema literals.

## Pull requests

A focused pull request should include:

- the user-observable behavior and root cause;
- unit tests for pure state and protocol boundaries;
- a real Electron smoke for window, pointer, persistence, or reparenting
  behavior where applicable;
- updated public documentation for API or behavior changes;
- an explicit note for anything that still requires manual validation.

Before requesting review, run:

```powershell
npm run release:check
```

Automated checks are evidence for repeatable invariants. They do not replace
manual validation of cursor anchoring, mixed-DPI movement, visual feedback, or
long-running resource stability.
