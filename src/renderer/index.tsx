import React, {
  useEffect,
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

const parameters = new URLSearchParams(location.search);
const mode = parameters.get("mode") ?? "shell";
const shellHeaderHeight = Math.max(
  0,
  Number(parameters.get("shellHeaderHeight") ?? "44") || 0,
);
// Matches QStyleHints.startDragDistance() in the reference PyQt runtime.
// Qt uses Manhattan distance for drag activation rather than Euclidean
// distance, which matters most during diagonal movement.
const DOCK_DRAG_START_DISTANCE_DIP = 10;

document.documentElement.dataset.mode = mode;

function useWorkspaceState(): WorkspaceStateMessage | null {
  const [workspace, setWorkspace] = useState<WorkspaceStateMessage | null>(null);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.electronDock.onWorkspaceState((message) => {
      if (active) setWorkspace(message);
    });
    void window.electronDock.getWorkspaceState().then((message) => {
      if (active && message !== null) setWorkspace(message);
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
  return (
    <nav
      className="dock-tabs"
      style={rectangleStyle(geometry.bounds)}
      aria-label="面板标签"
    >
      {geometry.panelIds.map((panelId) => (
        <button
          key={panelId}
          type="button"
          className={
            panelId === geometry.activePanelId
              ? "dock-tab dock-tab--active"
              : "dock-tab"
          }
          onClick={() => {
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
