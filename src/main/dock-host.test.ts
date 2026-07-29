import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({
  views: [] as Array<{
    readonly webContents: {
      readonly listeners: Map<string, (...args: any[]) => void>;
      windowOpenHandler: (() => unknown) | null;
      on(name: string, listener: (...args: any[]) => void): void;
      setWindowOpenHandler(handler: () => unknown): void;
    };
  }>,
}));

vi.mock("electron", () => {
  class WebContentsView {
    readonly webContents = {
      id: electronState.views.length + 1,
      listeners: new Map<string, (...args: any[]) => void>(),
      windowOpenHandler: null as (() => unknown) | null,
      on(name: string, listener: (...args: any[]) => void): void {
        this.listeners.set(name, listener);
      },
      setWindowOpenHandler(handler: () => unknown): void {
        this.windowOpenHandler = handler;
      },
    };

    constructor() {
      electronState.views.push(this);
    }
  }

  return {
    BaseWindow: class {},
    BrowserWindow: class {},
    WebContentsView,
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    },
  };
});

import { DockPanelHost } from "./dock-host.js";

beforeEach(() => {
  electronState.views.length = 0;
});

describe("DockPanelHost consumer navigation policy", () => {
  it("allows same-origin navigation and blocks cross-origin navigation", () => {
    createHost({
      url: "https://app.example.test/panels/one",
    });
    const webContents = electronState.views[0]!.webContents;
    const navigate = webContents.listeners.get("will-navigate")!;
    const sameOriginEvent = { preventDefault: vi.fn() };
    const crossOriginEvent = { preventDefault: vi.fn() };

    navigate(sameOriginEvent, "https://app.example.test/panels/two?tab=1");
    navigate(crossOriginEvent, "https://attacker.example.test/");

    expect(sameOriginEvent.preventDefault).not.toHaveBeenCalled();
    expect(crossOriginEvent.preventDefault).toHaveBeenCalledOnce();
  });

  it("allows only explicitly allowlisted additional HTTP(S) origins", () => {
    createHost({
      url: "https://app.example.test/panel",
      allowedNavigationOrigins: ["https://login.example.test/callback"],
    });
    const redirect = electronState.views[0]!.webContents.listeners.get(
      "will-redirect",
    )!;
    const allowedEvent = { preventDefault: vi.fn() };
    const deniedEvent = { preventDefault: vi.fn() };

    redirect(allowedEvent, "https://login.example.test/complete");
    redirect(deniedEvent, "https://other.example.test/complete");

    expect(allowedEvent.preventDefault).not.toHaveBeenCalled();
    expect(deniedEvent.preventDefault).toHaveBeenCalledOnce();
  });

  it("denies popups and rejects unsafe allowlist entries", () => {
    createHost({
      url: "https://app.example.test/panel",
    });
    expect(electronState.views[0]!.webContents.windowOpenHandler?.()).toEqual({
      action: "deny",
    });

    expect(() => {
      createHost({
        url: "https://app.example.test/panel",
        allowedNavigationOrigins: ["file:///C:/sensitive.html"],
      });
    }).toThrow(/credential-free HTTP\(S\) origins/);
  });
});

function createHost(
  content: {
    readonly url: string;
    readonly allowedNavigationOrigins?: readonly string[];
  },
): DockPanelHost {
  const mainWindow = {
    isDestroyed: () => false,
  } as unknown as BrowserWindow;
  return new DockPanelHost({
    panelId: "panel",
    title: "Panel",
    mainWindow,
    preloadPath: "internal-preload.cjs",
    rendererHtmlPath: "renderer.html",
    content,
  });
}
