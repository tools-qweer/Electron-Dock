import { describe, expect, it } from "vitest";
import { deriveDockWorkspacePanelStatus } from "./dock-workspace-host.js";

describe("Dock workspace panel state semantics", () => {
  it("keeps requested visibility true for an inactive, non-rendered tab", () => {
    expect(deriveDockWorkspacePanelStatus({
      host: "docked",
      requestedVisible: true,
      dockedActive: false,
      rendered: false,
    })).toEqual({
      active: false,
      requestedVisible: true,
      visible: false,
    });
  });

  it("separates a user-hidden panel from an inactive tab", () => {
    expect(deriveDockWorkspacePanelStatus({
      host: "docked",
      requestedVisible: false,
      dockedActive: false,
      rendered: false,
    })).toEqual({
      active: false,
      requestedVisible: false,
      visible: false,
    });
  });
});
