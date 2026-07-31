import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import type { Rectangle } from "../core/types.js";
import type {
  DockSplitterGeometry,
  DockTabStripGeometry,
  DockTitleBarGeometry,
} from "../core/layout-geometry.js";
import type {
  DockHostKind,
  DragPreviewMessage,
  HostChangedMessage,
  WorkspaceStateMessage,
} from "../shared/protocol.js";
import {
  completeTabReorderSession,
  createTabReorderSession,
  reorderPanelIds,
  resolveTabFlipTranslations,
  updateTabReorderSession,
  type TabInlinePosition,
  type TabReorderSession,
} from "./tab-reorder.js";
import {
  applyShellAppearanceVariables,
  shellAppearanceFromSearch,
} from "./shell-appearance.js";

const parameters = new URLSearchParams(location.search);
const mode = parameters.get("mode") ?? "shell";
const initialShellAppearance = shellAppearanceFromSearch(location.search);
const shellHeaderHeight = Math.max(
  0,
  Number(parameters.get("shellHeaderHeight") ?? "44") || 0,
);
// Matches QStyleHints.startDragDistance() in the reference PyQt runtime.
// Qt uses Manhattan distance for drag activation rather than Euclidean
// distance, which matters most during diagonal movement.
const DOCK_DRAG_START_DISTANCE_DIP = 10;
const TAB_REORDER_ANIMATION_DURATION_MS = 150;
const TAB_REORDER_ANIMATION_EASING = "cubic-bezier(0.2, 0, 0, 1)";

document.documentElement.dataset.mode = mode;
if (mode === "shell") {
  // This runs before React mounts. Combined with the main-process load gate it
  // makes the configured shell appearance the first visible frame.
  applyShellAppearanceVariables(
    document.documentElement.style,
    initialShellAppearance,
  );
}

function useWorkspaceState(): WorkspaceStateMessage | null {
  const [workspace, setWorkspace] = useState<WorkspaceStateMessage | null>(null);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.electronDock.onWorkspaceState((message) => {
      if (active) {
        applyShellAppearanceVariables(
          document.documentElement.style,
          message.shellAppearance,
        );
        setWorkspace(message);
      }
    });
    void window.electronDock.getWorkspaceState().then((message) => {
      if (active && message !== null) {
        applyShellAppearanceVariables(
          document.documentElement.style,
          message.shellAppearance,
        );
        setWorkspace(message);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return workspace;
}

function rectangleStyle(bounds: Rectangle): React.CSSProperties {
  return {
    left: bounds.x,
    top: bounds.y,
    width: Math.max(0, bounds.width),
    height: Math.max(0, bounds.height),
  };
}

function Shell(): React.JSX.Element {
  const workspace = useWorkspaceState();
  const panelTitles = useMemo(() => new Map(
    workspace?.panels.map((panel) => [panel.id, panel.title]) ?? [],
  ), [workspace?.panels]);

  return (
    <main
      className={[
        "dock-shell",
        workspace?.interactionEnabled === false
          ? "dock-shell--interaction-disabled"
          : "",
      ].filter(Boolean).join(" ")}
      style={{
        "--dock-shell-header-height": `${shellHeaderHeight}px`,
      } as React.CSSProperties}
    >
      {shellHeaderHeight > 0 ? (
        <header className="dock-topbar">
          <strong>Electron Dock</strong>
          <span>Windows 原生多面板停靠运行时</span>
        </header>
      ) : null}
      <section className="dock-surface" aria-label="停靠工作区">
        {workspace === null ? (
          <div className="dock-loading">正在载入工作区…</div>
        ) : (
          <>
            {workspace.geometry.titleBars.map((titleBar) => (
              <DockTitleBar
                key={titleBar.tabsNodeId}
                geometry={titleBar}
                title={panelTitles.get(titleBar.panelId) ?? titleBar.panelId}
              />
            ))}
            {workspace.geometry.tabStrips.map((tabStrip) => (
              <DockTabStrip
                key={tabStrip.tabsNodeId}
                geometry={tabStrip}
                panelTitles={panelTitles}
              />
            ))}
            {workspace.geometry.splitters.map((splitter) => (
              <DockSplitter
                key={splitter.splitNodeId}
                geometry={splitter}
              />
            ))}
          </>
        )}
      </section>
    </main>
  );
}

interface DockTitleBarProps {
  readonly geometry: DockTitleBarGeometry;
  readonly title: string;
}

function DockTitleBar({
  geometry,
  title,
}: DockTitleBarProps): React.JSX.Element {
  const beginDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const element = event.currentTarget;
    const pointerId = event.pointerId;
    const start = { x: event.clientX, y: event.clientY };
    const anchor = {
      x: Math.max(0, event.clientX - geometry.bounds.x),
      y: Math.max(0, event.clientY - geometry.bounds.y),
    };
    let finished = false;

    const cleanup = (): void => {
      if (finished) return;
      finished = true;
      element.removeEventListener("pointermove", handleMove);
      element.removeEventListener("pointerup", handleRelease);
      element.removeEventListener("pointercancel", handleRelease);
      if (element.hasPointerCapture(pointerId)) {
        element.releasePointerCapture(pointerId);
      }
    };
    const handleMove = (pointerEvent: PointerEvent): void => {
      if (pointerEvent.pointerId !== pointerId || finished) return;
      const distance = Math.abs(pointerEvent.clientX - start.x)
        + Math.abs(pointerEvent.clientY - start.y);
      if (distance < DOCK_DRAG_START_DISTANCE_DIP) return;
      cleanup();
      window.electronDock.beginPanelDrag({
        panelId: geometry.panelId,
        anchor,
      });
    };
    const handleRelease = (pointerEvent: PointerEvent): void => {
      if (pointerEvent.pointerId === pointerId) cleanup();
    };

    element.setPointerCapture(pointerId);
    element.addEventListener("pointermove", handleMove);
    element.addEventListener("pointerup", handleRelease);
    element.addEventListener("pointercancel", handleRelease);
  };

  return (
    <header
      className="dock-titlebar"
      style={rectangleStyle(geometry.bounds)}
      onPointerDown={beginDrag}
      title={`拖动“${title}”`}
    >
      <span>{title}</span>
      <span className="dock-grip" aria-hidden="true">⠿</span>
    </header>
  );
}

interface DockTabStripProps {
  readonly geometry: DockTabStripGeometry;
  readonly panelTitles: ReadonlyMap<string, string>;
}

function DockTabStrip({
  geometry,
  panelTitles,
}: DockTabStripProps): React.JSX.Element {
  const stripRef = useRef<HTMLElement>(null);
  const sessionRef = useRef<TabReorderSession | null>(null);
  const previewOrderRef = useRef<readonly string[] | null>(null);
  const pendingOrderRef = useRef<readonly string[] | null>(null);
  const pendingTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef<string | null>(null);
  const cancelDragRef = useRef<(() => void) | null>(null);
  const flipOriginRef = useRef<readonly TabInlinePosition[] | null>(null);
  const tabAnimationsRef = useRef(new Map<string, Animation>());
  const [previewOrder, setPreviewOrder] = useState<readonly string[] | null>(
    null,
  );
  const [draggingPanelId, setDraggingPanelId] = useState<string | null>(null);
  const displayedPanelIds = previewOrder ?? geometry.panelIds;

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const before = flipOriginRef.current;
    flipOriginRef.current = null;
    if (
      strip === null
      || before === null
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const elements = new Map(
      Array.from(strip.querySelectorAll<HTMLElement>(".dock-tab"))
        .flatMap((element) => {
          const panelId = element.dataset.panelId;
          return panelId === undefined ? [] : [[panelId, element] as const];
        }),
    );
    const after = readTabInlinePositions(strip);
    for (const { panelId, translateX } of resolveTabFlipTranslations(
      before,
      after,
    )) {
      const element = elements.get(panelId);
      if (element === undefined) continue;
      tabAnimationsRef.current.get(panelId)?.cancel();
      const animation = element.animate(
        [
          { transform: `translateX(${String(translateX)}px)` },
          { transform: "translateX(0)" },
        ],
        {
          duration: TAB_REORDER_ANIMATION_DURATION_MS,
          easing: TAB_REORDER_ANIMATION_EASING,
        },
      );
      tabAnimationsRef.current.set(panelId, animation);
      const forget = (): void => {
        if (tabAnimationsRef.current.get(panelId) === animation) {
          tabAnimationsRef.current.delete(panelId);
        }
      };
      animation.addEventListener("finish", forget, { once: true });
      animation.addEventListener("cancel", forget, { once: true });
    }
  }, [displayedPanelIds]);

  useEffect(() => {
    const pending = pendingOrderRef.current;
    if (pending === null || !samePanelOrder(pending, geometry.panelIds)) return;
    pendingOrderRef.current = null;
    previewOrderRef.current = null;
    if (pendingTimerRef.current !== null) {
      window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    setPreviewOrder(null);
  }, [geometry.panelIds]);

  useEffect(() => () => {
    cancelDragRef.current?.();
    if (pendingTimerRef.current !== null) {
      window.clearTimeout(pendingTimerRef.current);
    }
    for (const animation of tabAnimationsRef.current.values()) {
      animation.cancel();
    }
    tabAnimationsRef.current.clear();
  }, []);

  const captureFlipOrigin = (): void => {
    const strip = stripRef.current;
    flipOriginRef.current = strip === null
      ? null
      : readTabInlinePositions(strip);
  };

  const beginReorder = (
    event: React.PointerEvent<HTMLButtonElement>,
    panelId: string,
  ): void => {
    if (event.button !== 0 || sessionRef.current !== null) return;
    const sourceIndex = displayedPanelIds.indexOf(panelId);
    const strip = stripRef.current;
    if (sourceIndex < 0 || strip === null) return;

    // Keep pointer capture on the stable strip. The dragged button changes
    // position during the preview render and Chromium releases capture when
    // the captured element is moved in the DOM.
    const captureOwner = strip;
    const pointerId = event.pointerId;
    let session = createTabReorderSession(
      panelId,
      event.clientX,
      event.clientY,
      sourceIndex,
    );
    let finished = false;
    const initialOrder = [...displayedPanelIds];
    sessionRef.current = session;
    previewOrderRef.current = initialOrder;

    const cleanup = (cancelled: boolean): void => {
      if (finished) return;
      finished = true;
      captureOwner.removeEventListener("pointermove", handleMove);
      captureOwner.removeEventListener("pointerup", handleRelease);
      captureOwner.removeEventListener("pointercancel", handleCancel);
      captureOwner.removeEventListener(
        "lostpointercapture",
        handleLostCapture,
      );
      window.removeEventListener("keydown", handleKeyDown, true);
      cancelDragRef.current = null;
      sessionRef.current = null;
      setDraggingPanelId(null);
      if (captureOwner.hasPointerCapture(pointerId)) {
        captureOwner.releasePointerCapture(pointerId);
      }

      const completion = completeTabReorderSession(session, cancelled);
      if (completion.targetIndex === null) {
        previewOrderRef.current = null;
        captureFlipOrigin();
        setPreviewOrder(null);
      } else {
        const committedOrder = previewOrderRef.current ?? initialOrder;
        pendingOrderRef.current = committedOrder;
        window.electronDock.reorderTab({
          tabsNodeId: geometry.tabsNodeId,
          panelId,
          targetIndex: completion.targetIndex,
        });
        if (pendingTimerRef.current !== null) {
          window.clearTimeout(pendingTimerRef.current);
        }
        pendingTimerRef.current = window.setTimeout(() => {
          if (pendingOrderRef.current !== committedOrder) return;
          pendingOrderRef.current = null;
          previewOrderRef.current = null;
          pendingTimerRef.current = null;
          captureFlipOrigin();
          setPreviewOrder(null);
        }, 750);
      }

      const activatesClick = !cancelled && !session.started;
      if (activatesClick) {
        window.electronDock.setActivePanel({
          tabsNodeId: geometry.tabsNodeId,
          panelId,
        });
      }
      if (completion.suppressClick || activatesClick) {
        suppressClickRef.current = panelId;
        window.setTimeout(() => {
          if (suppressClickRef.current === panelId) {
            suppressClickRef.current = null;
          }
        }, 0);
      }
    };

    const handleMove = (pointerEvent: PointerEvent): void => {
      if (pointerEvent.pointerId !== pointerId || finished) return;
      const tabCenters = Array.from(
        strip.querySelectorAll<HTMLElement>(".dock-tab"),
        (tab) => {
          const bounds = tab.getBoundingClientRect();
          return bounds.left + bounds.width / 2;
        },
      );
      const previous = session;
      session = updateTabReorderSession(
        session,
        pointerEvent.clientX,
        pointerEvent.clientY,
        tabCenters,
      );
      sessionRef.current = session;
      if (!previous.started && session.started) {
        setDraggingPanelId(panelId);
        window.electronDock.setActivePanel({
          tabsNodeId: geometry.tabsNodeId,
          panelId,
        });
      }
      if (session.currentIndex !== previous.currentIndex) {
        const nextOrder = reorderPanelIds(
          previewOrderRef.current ?? initialOrder,
          panelId,
          session.currentIndex,
        );
        previewOrderRef.current = nextOrder;
        captureFlipOrigin();
        setPreviewOrder(nextOrder);
      }
      if (session.started) pointerEvent.preventDefault();
    };

    const handleRelease = (pointerEvent: PointerEvent): void => {
      if (pointerEvent.pointerId === pointerId) cleanup(false);
    };
    const handleCancel = (pointerEvent: PointerEvent): void => {
      if (pointerEvent.pointerId === pointerId) cleanup(true);
    };
    const handleLostCapture = (pointerEvent: PointerEvent): void => {
      if (pointerEvent.pointerId === pointerId) cleanup(true);
    };
    const handleKeyDown = (keyboardEvent: KeyboardEvent): void => {
      if (keyboardEvent.key !== "Escape") return;
      keyboardEvent.preventDefault();
      keyboardEvent.stopPropagation();
      cleanup(true);
    };

    cancelDragRef.current = () => cleanup(true);
    captureOwner.setPointerCapture(pointerId);
    captureOwner.addEventListener("pointermove", handleMove);
    captureOwner.addEventListener("pointerup", handleRelease);
    captureOwner.addEventListener("pointercancel", handleCancel);
    captureOwner.addEventListener("lostpointercapture", handleLostCapture);
    window.addEventListener("keydown", handleKeyDown, true);
  };

  return (
    <nav
      ref={stripRef}
      className="dock-tabs"
      style={rectangleStyle(geometry.bounds)}
      aria-label="面板标签"
    >
      {displayedPanelIds.map((panelId) => (
        <button
          key={panelId}
          type="button"
          data-panel-id={panelId}
          className={[
            "dock-tab",
            panelId === geometry.activePanelId
              ? "dock-tab--active"
              : "",
            panelId === draggingPanelId
              ? "dock-tab--reordering"
              : "",
          ].filter(Boolean).join(" ")}
          aria-pressed={panelId === geometry.activePanelId}
          onPointerDown={(event) => {
            beginReorder(event, panelId);
          }}
          onClick={(event) => {
            if (suppressClickRef.current === panelId) {
              suppressClickRef.current = null;
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            window.electronDock.setActivePanel({
              tabsNodeId: geometry.tabsNodeId,
              panelId,
            });
          }}
        >
          {panelTitles.get(panelId) ?? panelId}
        </button>
      ))}
    </nav>
  );
}

function samePanelOrder(
  first: readonly string[],
  second: readonly string[],
): boolean {
  return first.length === second.length
    && first.every((panelId, index) => panelId === second[index]);
}

function readTabInlinePositions(
  strip: HTMLElement,
): readonly TabInlinePosition[] {
  return Array.from(
    strip.querySelectorAll<HTMLElement>(".dock-tab"),
  ).flatMap((element) => {
    const panelId = element.dataset.panelId;
    if (panelId === undefined) return [];
    return [{
      panelId,
      left: element.getBoundingClientRect().left,
    }];
  });
}

interface DockSplitterProps {
  readonly geometry: DockSplitterGeometry;
}

function DockSplitter({
  geometry,
}: DockSplitterProps): React.JSX.Element {
  const splitterRef = useRef<HTMLDivElement>(null);

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const splitter = splitterRef.current;
    if (splitter === null) return;
    const pointerId = event.pointerId;
    splitter.setPointerCapture(pointerId);

    const update = (pointerEvent: PointerEvent): void => {
      if (pointerEvent.pointerId !== pointerId) return;
      const horizontal = geometry.axis === "horizontal";
      const containerStart = horizontal
        ? geometry.containerBounds.x
        : geometry.containerBounds.y;
      const containerLength = horizontal
        ? geometry.containerBounds.width
        : geometry.containerBounds.height;
      const splitterThickness = horizontal
        ? geometry.bounds.width
        : geometry.bounds.height;
      const available = Math.max(1, containerLength - splitterThickness);
      const cursor = horizontal ? pointerEvent.clientX : pointerEvent.clientY;
      const ratio = Math.min(
        0.9,
        Math.max(
          0.1,
          (cursor - containerStart - splitterThickness / 2) / available,
        ),
      );
      window.electronDock.setSplitRatio({
        splitNodeId: geometry.splitNodeId,
        ratio,
      });
    };
    const finish = (pointerEvent: PointerEvent): void => {
      if (pointerEvent.pointerId !== pointerId) return;
      update(pointerEvent);
      splitter.removeEventListener("pointermove", update);
      splitter.removeEventListener("pointerup", finish);
      splitter.removeEventListener("pointercancel", finish);
      if (splitter.hasPointerCapture(pointerId)) {
        splitter.releasePointerCapture(pointerId);
      }
    };

    splitter.addEventListener("pointermove", update);
    splitter.addEventListener("pointerup", finish);
    splitter.addEventListener("pointercancel", finish);
  };

  return (
    <div
      ref={splitterRef}
      className={`dock-splitter dock-splitter--${geometry.axis}`}
      style={rectangleStyle(geometry.bounds)}
      role="separator"
      aria-orientation={
        geometry.axis === "horizontal" ? "vertical" : "horizontal"
      }
      onPointerDown={startResize}
    />
  );
}

function Panel(): React.JSX.Element {
  const panelId = parameters.get("panelId") ?? "unknown";
  const [host, setHost] = useState<DockHostKind>("docked");
  const [webContentsId, setWebContentsId] = useState(-1);
  const [counter, setCounter] = useState(0);
  const [inputValue, setInputValue] = useState("状态必须保留");
  const scrollerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const contextIdRef = useRef<string>(crypto.randomUUID());
  const webglRef = useRef<WebGL2RenderingContext | null>(null);
  const webglSignatureRef = useRef("uninitialized");

  useEffect(() => {
    let active = true;
    const applyHostState = (message: HostChangedMessage): void => {
      if (!active || message.panelId !== panelId) return;
      setHost(message.host);
      setWebContentsId(message.webContentsId);
    };
    const unsubscribe = window.electronDock.onHostChanged(applyHostState);
    void window.electronDock.getHostState().then((message) => {
      if (message !== null) applyHostState(message);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [panelId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const gl = canvas.getContext("webgl2");
    webglRef.current = gl;
    if (gl === null) {
      webglSignatureRef.current = "webgl2-unavailable";
      return;
    }
    gl.clearColor(0.02, 0.72, 0.58, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    webglSignatureRef.current = Array.from(pixel).join("-");
  }, []);

  window.__electronDockReadSnapshot = () => ({
    panelId,
    webContentsId,
    host,
    counter,
    inputValue,
    scrollTop: scrollerRef.current?.scrollTop ?? 0,
    webglContextId: contextIdRef.current,
    webglSignature: webglSignatureRef.current,
    webglContextLost: webglRef.current?.isContextLost() ?? false,
  });
  window.__electronDockMutateForSmoke = () => {
    setCounter(37);
    setInputValue("smoke-state");
    // Background or fully occluded Electron windows may throttle
    // requestAnimationFrame for longer than the smoke deadline. The scroll
    // container already exists here, so apply the mutation synchronously and
    // repeat it on the next painted frame when one is available.
    if (scrollerRef.current !== null) {
      scrollerRef.current.scrollTop = 180;
    }
    requestAnimationFrame(() => {
      if (scrollerRef.current !== null) {
        scrollerRef.current.scrollTop = 180;
      }
    });
  };

  return (
    <main className="panel-content">
      <section className="state-proof">
        <label>
          输入状态
          <input
            value={inputValue}
            onChange={(event) => {
              setInputValue(event.target.value);
            }}
          />
        </label>
        <div className="counter-row">
          <button
            type="button"
            onClick={() => {
              setCounter((value) => value + 1);
            }}
          >
            计数 +1
          </button>
          <output>{counter}</output>
        </div>
        <canvas ref={canvasRef} width={240} height={64} />
      </section>
      <div ref={scrollerRef} className="scroll-proof">
        {Array.from({ length: 24 }, (_value, index) => (
          <div key={index}>持久内容行 {index + 1}</div>
        ))}
      </div>
    </main>
  );
}

function Overlay(): React.JSX.Element {
  const [preview, setPreview] = useState<DragPreviewMessage | null>(null);

  useEffect(() => window.electronDock.onDragPreview((message) => {
    setPreview(message.active ? message : null);
  }), []);

  const previewBounds = preview?.previewBounds ?? null;
  const visible = previewBounds !== null;

  return (
    <main className="dock-overlay" aria-hidden={!visible}>
      {visible ? (
        <div
          className={[
            "dock-placement-preview",
            preview?.target?.position === "center"
              ? "dock-placement-preview--tab-merge"
              : "",
          ].filter(Boolean).join(" ")}
          style={rectangleStyle(previewBounds)}
        />
      ) : null}
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root");

const content = mode === "panel"
  ? <Panel />
  : mode === "overlay"
    ? <Overlay />
    : <Shell />;
createRoot(root).render(content);
