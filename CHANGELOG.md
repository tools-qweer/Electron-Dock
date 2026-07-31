# Changelog

All notable changes to Electron Dock are documented in this file.

The project follows [Semantic Versioning](https://semver.org/) and publishes
immutable Alpha prereleases while its public API and Windows interaction
contract are still being validated.

## [0.2.0-alpha.5] - 2026-07-31

### Fixed

- Kept an ordinary tab click authoritative even though the stable tab-strip
  owns pointer capture, so tabs remain switchable before and after reordering.
- Added FLIP-based live tab displacement and cancellation animation instead of
  jumping directly between DOM positions.
- Restored desktop-style arrow cursors and source-like bottom-tab borders,
  spacing, and lower corner rounding.
- Extended the real Electron pointer smoke to verify animation, cursor style,
  persisted reorder, and a Story-to-Map click round trip after the drag.

## [0.2.0-alpha.4] - 2026-07-31

### Added

- Drag-to-reorder for tabs inside an existing merged Dock group. Reordering is
  committed through the library-owned layout authority and survives layout
  persistence without recreating panel `WebContents`.
- Public `serializeDockLayoutPersistence()` and
  `parseDockLayoutPersistence()` codecs, together with the persistence schema
  and version constants at the package root and `./core` entry points.
- Structured Shell appearance tokens with normalized, immutable defaults and a
  runtime `setShellAppearance()` update path. Arbitrary consumer CSS and access
  to the private Shell renderer remain intentionally unsupported.
- A runnable `attachWorkspace()` example for an existing `BrowserWindow`.
- Release, contribution, and security policy documents plus Windows package
  release gates.

### Changed

- The bundled Shell renderer is now emitted as an explicitly production,
  minified build and checked for development-only React signatures.
- The public panel preload returns stable panel state from `floatPanel()` and
  `redockPanel()` and no longer exposes the diagnostic
  `readPanelSnapshot()` hook. Layout mutation, tab reordering, splitter, and
  drag authority remain private to the library Shell preload.

## [0.2.0-alpha.3] - 2026-07-29

### Fixed

- Hardened the Windows native drag-helper lifecycle so a blocked, exited, or
  failed helper is isolated and can be restarted on the next drag.
- Restored floating-window interaction after cancellation, timeout, window
  blur, hide, or minimize paths.
- Kept the pointer anchored to the floating native caption during tear-off,
  avoiding the extra non-client vertical offset.

## [0.2.0-alpha.2] - 2026-07-29

### Fixed

- Made initial public panel state available before the consumer panel's first
  document script runs during `attachWorkspace()`.
- Kept temporary panel authorization closed until workspace initialization
  completes and revoked it on failed initialization or disposal.
- Exposed consistent active, requested-visible, actual-visible, host, and
  `WebContents` identity state to the host runtime and panel preload.

## [0.2.0-alpha.1] - 2026-07-29

### Added

- `attachWorkspace()` for mounting Electron Dock into a consumer-owned
  `BrowserWindow` without reloading its page, replacing its menu, intercepting
  its close flow, or taking ownership of the window.
- Public workspace controls for bounds, visibility, interaction, activation,
  panel visibility, float/redock, reset, snapshot, persistence flush, and
  independent disposal.
- Panel lifecycle callbacks that run before initial navigation for safe
  consumer IPC sender registration.
- Packed-consumer and real Electron attach smoke coverage.

## [0.1.0-alpha.1] - 2026-07-29

### Added

- Initial Windows x64 and Electron 43 Alpha.
- Pure layout tree and geometry core with tabs, splits, float/redock, minimum
  sizes, versioned persistence, and corrupted-layout fallback.
- `createWindow()` runtime for a complete library-owned Dock window.
- Persistent `WebContentsView` reparenting between the docked host and a real
  native `BaseWindow` without renderer reload.
- Narrow public panel preload, private Shell preload, native Windows drag
  helper, package contract checks, and end-to-end reparenting smoke tests.

[0.2.0-alpha.5]: https://github.com/tools-qweer/Electron-Dock/compare/v0.2.0-alpha.4...v0.2.0-alpha.5
[0.2.0-alpha.4]: https://github.com/tools-qweer/Electron-Dock/compare/v0.2.0-alpha.3...v0.2.0-alpha.4
[0.2.0-alpha.3]: https://github.com/tools-qweer/Electron-Dock/compare/v0.2.0-alpha.2...v0.2.0-alpha.3
[0.2.0-alpha.2]: https://github.com/tools-qweer/Electron-Dock/compare/v0.2.0-alpha.1...v0.2.0-alpha.2
[0.2.0-alpha.1]: https://github.com/tools-qweer/Electron-Dock/compare/v0.1.0-alpha.1...v0.2.0-alpha.1
[0.1.0-alpha.1]: https://github.com/tools-qweer/Electron-Dock/releases/tag/v0.1.0-alpha.1
