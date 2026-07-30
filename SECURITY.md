# Security policy

## Supported versions

Electron Dock is currently an Alpha for Windows x64 and Electron 43. Only the
latest published Alpha receives security fixes. Older Alpha tags are immutable
integration snapshots and may be superseded without backports.

## Reporting a vulnerability

Please use
[GitHub's private vulnerability reporting](https://github.com/tools-qweer/Electron-Dock/security/advisories/new)
for this repository. Do not include vulnerability details in a public issue.
If the private-report form is unavailable, open a public issue containing only
a request for a private maintainer contact channel.

Include:

- the affected Electron Dock version and Electron version;
- a minimal reproduction;
- the expected and observed trust boundary;
- whether the issue requires a compromised panel renderer, shell renderer, or
  main process;
- any known workaround.

The project will acknowledge a complete report as soon as practical, validate
the affected boundary, and publish a fixed immutable version when confirmed.

## Security boundary

The library keeps layout mutation authority in its private Shell preload and
validates IPC senders by exact `WebContents`, main frame, and workspace state.
Consumer panels receive only the documented panel-scoped preload API.

Electron Dock does not make untrusted business content safe by itself.
Consumers remain responsible for their panel navigation policy, permissions,
remote content, business IPC, secrets, and application updates.
