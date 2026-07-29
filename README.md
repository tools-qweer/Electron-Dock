# @tools-qweer/electron-dock

Windows x64 原生 Electron 停靠组件。它让同一个持久
`WebContentsView` 面板在主窗口停靠区和真实 `BaseWindow` 浮窗之间迁移，
不通过销毁、重建或重载面板来模拟浮动。

当前版本是 `0.2.0-alpha.1`。它用于尽早验证集成边界，不代表公共 API 已
稳定，也不代表 Qt Dock 的完整交互已经通过人工验收。

## 支持范围

- Windows x64。
- Node.js 22.12 或更高版本。
- Electron 43（peer dependency 当前为 `^43.1.1`）。
- ESM 主进程入口和纯 ESM 布局内核。
- CommonJS preload 入口，便于直接用于 Electron 的 `preload` 路径。

macOS、Linux X11、Wayland、Windows arm64 和 ia32 不在此 alpha 的支持
范围内。

## 安装

从首个 GitHub Alpha 标签安装：

```powershell
npm install 'github:tools-qweer/Electron-Dock#v0.2.0-alpha.1' electron@^43.1.1
```

发布到 npm 后也可使用：

```powershell
npm install @tools-qweer/electron-dock@alpha electron@^43.1.1
```

Alpha 阶段建议固定精确标签或版本，不要依赖会移动的分支。

## 挂入已有 BrowserWindow

`attachWorkspace()` 是面向真实应用的接入入口。它只在消费者已有窗口的
内容区内添加库拥有的 Shell、Overlay 和业务面板 `WebContentsView`，不会
重载窗口自身页面、修改菜单、拦截关闭流程或销毁宿主窗口：

```ts
import { app, BrowserWindow } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createElectronDockRuntime } from "@tools-qweer/electron-dock";
import {
  createDockLayout,
  createTabsNode,
} from "@tools-qweer/electron-dock/core";

await app.whenReady();

const owner = new BrowserWindow({ width: 1280, height: 800 });
await owner.loadURL("file:///your-existing-shell.html");

const runtime = createElectronDockRuntime();
const panelSenders = new Map<number, {
  panelId: string;
  role: "panel";
  generation: number;
}>();
const workspace = await runtime.attachWorkspace({
  id: "main-workspace",
  window: owner,
  bounds: { x: 220, y: 72, width: 1060, height: 728 },
  panels: [{
    id: "navigator",
    title: "导航",
    content: {
      url: pathToFileURL(
        path.join(import.meta.dirname, "renderer", "navigator.html"),
      ).href,
    },
  }],
  initialLayout: createDockLayout(
    createTabsNode("tabs-main", ["navigator"]),
  ),
  layoutFilePath: path.join(app.getPath("userData"), "dock-layout.json"),
  onPanelWebContentsCreated({ panelId, role, generation, webContents }) {
    // 此回调发生在面板第一次 loadURL() 前，可安全登记 IPC sender。
    panelSenders.set(webContents.id, { panelId, role, generation });
  },
  onPanelWebContentsDisposed({ webContentsId }) {
    panelSenders.delete(webContentsId);
  },
});

// 宿主布局变化时，以内容区坐标更新工作区。
workspace.setBounds({ x: 240, y: 72, width: 1040, height: 728 });

owner.once("closed", () => {
  // 宿主仍拥有自己的关闭策略；库只回收它创建的资源。
  void workspace.dispose();
});
```

`attachWorkspace()` 返回的控制面包括 `setBounds`、`setVisible`、
`setInteractionEnabled`、`snapshot`、`onDidChange`、`activatePanel`、
`setPanelVisible`、`float`、`redock`、`reset`、`flush` 和 `dispose`。
面板快照包含 `host`、`active`、`requestedVisible`、`visible` 和
`webContentsId`。`requestedVisible` 是 `setPanelVisible()` 控制的稳定菜单
偏好；`visible` 表示当前是否实际呈现，因此非活动标签的 `visible` 为 false，
但 `requestedVisible` 仍为 true。业务
preload 也可通过 `getPanelState()` / `onPanelStateChanged()` 读取同一状态。
`setPanelVisible` 保留面板原布局位置，但当前 Alpha 不替宿主持久化窗口菜单
偏好；应用可从 `snapshot` / `onDidChange` 维护自己的偏好状态。

布局写入失败会由 `flush()`、`dispose()` 或拥有窗口的 `close()` 原样抛出，
不会被成功结果掩盖。损坏、未知版本或缺失布局仍按兼容策略回退默认布局。

## 创建独立 Dock 窗口

主进程在 `app.whenReady()` 后显式创建运行时。导入包本身不会注册 IPC、
监听 Electron 生命周期或创建窗口：

```ts
import { app } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createElectronDockRuntime } from "@tools-qweer/electron-dock";

await app.whenReady();

const runtime = createElectronDockRuntime();
await runtime.createWindow({
  id: "main",
  panels: [
    {
      id: "navigator",
      title: "导航",
      content: {
        url: pathToFileURL(
          path.join(import.meta.dirname, "renderer", "navigator.html"),
        ).href,
      },
    },
    {
      id: "editor",
      title: "编辑器",
      content: {
        url: pathToFileURL(
          path.join(import.meta.dirname, "renderer", "editor.html"),
        ).href,
      },
    },
  ],
  initialLayout: {
    version: 1,
    nextNodeSequence: 2,
    root: {
      type: "split",
      id: "split-1",
      axis: "horizontal",
      ratio: 0.25,
      first: {
        type: "tabs",
        id: "tabs-1",
        panelIds: ["navigator"],
        activePanelId: "navigator",
      },
      second: {
        type: "tabs",
        id: "tabs-2",
        panelIds: ["editor"],
        activePanelId: "editor",
      },
    },
    floating: [],
  },
  layoutFilePath: path.join(app.getPath("userData"), "dock-layout.json"),
});

app.on("window-all-closed", () => {
  void runtime.dispose().finally(() => app.quit());
});
```

面板 `url` 必须是完整 URL；加载本地页面时使用 `pathToFileURL(...).href`。
库拥有 Dock Shell、布局树、持久 `WebContentsView` 和浮窗；业务页面、业务
状态及业务 IPC 仍由宿主应用拥有。

需要在业务页面中调用面板宿主 API 时，在宿主自己的 preload 中显式安装
窄化 IPC API：

```js
const {
  exposeElectronDockPreloadApi,
} = require("@tools-qweer/electron-dock/preload");

exposeElectronDockPreloadApi("electronDock");
```

导入 preload 子路径本身没有全局副作用；只有显式调用安装函数才会写入
`contextBridge`。公开 preload 只提供业务面板自身有效的
`getPanelState`、`onPanelStateChanged`、兼容用
`getHostState` / `onHostChanged`、`floatPanel`、`redockPanel` 和
`readPanelSnapshot`。工作区隐藏或交互禁用时，面板自行发起的
float/redock 会被主进程拒绝。工作区布局、标签切换、分割线调整和拖动预览
由库内 Shell preload 独占，不会暴露给业务面板。

如果宿主应用启用 ASAR，需要把
`node_modules/@tools-qweer/electron-dock/dist/native/**` 配置到
electron-builder 的 `asarUnpack`，或在创建工作区时显式传入已解包的 helper
路径。缺少可执行 helper 时，资源解析会直接报错，不会静默退化为近似拖动。

具体导出以对应入口的 TypeScript 声明为准。alpha 阶段请固定精确版本；在
进入稳定版本前，入口导出、构造参数和持久化迁移策略都可能改变。

纯布局算法可从 `@tools-qweer/electron-dock/core` 导入，不会加载 Electron
主进程模块。

## 本仓库开发

```powershell
cd 'E:\tools\Electron Dock'
npm ci
npm run typecheck
npm test
npm run build
npm run package:check
npm run package:consumer
npm run pack:dry-run
```

运行内置演示和真实 Electron 重挂载 smoke：

```powershell
npm start
npm run smoke:reparent
npm run smoke:attach
npm run package:consumer:electron
```

Electron 43 的 npm 包不再通过普通安装生命周期自动下载桌面可执行文件。
`npm start` 与 `smoke:reparent` 会先运行 `electron:ensure`：已安装时直接复用，
缺失时调用 Electron 包自带的官方安装器。首次运行因此需要访问 Electron
发行文件下载源。

`package:consumer` 会真实执行 `npm pack`，把 tgz 安装到系统临时目录中的
最小 TypeScript/Electron fixture，再验证根入口、`./core`、`./preload`
的 NodeNext 类型和导入解析，以及发布包内 native helper、renderer 和内部
preload；结束后始终清理临时目录。CI 运行这一无 GUI 门禁。
`package:consumer:electron`（也即 `smoke:attach`）额外下载/启用 Electron
二进制，从已安装 tgz 挂入消费者已有的 `show:false` 窗口，验证宿主页
WebContents、页面状态、菜单和关闭监听均未改变；随后覆盖 bounds、交互
开关、显隐、浮出/停靠、WebContents ID 保持、面板 sender 预登记和独立
dispose，最后再验证 `createWindow()` 兼容路径。该真实桌面 smoke 由
Windows CI 和本地门禁执行。

`npm run build` 同时生成发布入口的 JavaScript/TypeScript 声明，以及现有
演示所需的 `dist/demo/index.js`、内部 preload、renderer 和 Windows 原生
拖动 helper。有系统 `.NET Framework` `csc.exe` 时，helper 会从
`native/windows-drag-helper.cs` 重新编译；精简 Windows 环境没有该编译器时，
构建会先校验仓库内 Windows x64 预编译 helper 与源码哈希清单，再复制到
`dist/native/`。因此从 GitHub 标签安装不要求目标机器必须存在 `csc.exe`。
编译固定使用 `/platform:x64`；单元测试、包合同检查和 tgz 消费者都会解析
PE header，要求 Machine 为 AMD64 `0x8664`，不接受 AnyCPU/I386 helper。
`npm run package:check` 验证发布元数据、导出目标和关键产物；`prepack`
会重新执行构建和包合同检查。

修改 C# helper 源码后，需要在具备 `csc.exe` 的 Windows x64 环境运行：

```powershell
npm run native:refresh-fallback
```

该命令会原子更新 `native/bin/windows-drag-helper.exe` 及其 manifest；源码、
预编译二进制和哈希清单应在同一次提交中更新。

## 当前架构

- `src/core`：与 Electron、React 无关的布局树、几何和状态变换。
- `src/main`：主进程布局状态、`BaseWindow`、持久
  `WebContentsView`、原生拖动协调和原子布局存储。
- `src/preload`：业务面板使用收窄的公开 IPC；库内 Shell preload 独占布局、
  resize 和 drag 权限。
- `src/renderer`：演示用 Shell、Panel 和拖动 Overlay。
- `native/windows-drag-helper.cs`：Windows 系统移动/坐标桥；构建时使用
  Windows 自带 C# 编译器生成 helper。
- `native/bin/windows-drag-helper.exe`：GitHub 标签安装缺少 `csc.exe` 时使用
  的仓库内 Windows x64 回退；同目录 manifest 将它绑定到对应 C# 源码。

每个工作区拥有独立 Shell `WebContentsView`，每个业务面板也拥有独立
`WebContentsView`。停靠和浮动只改变面板 View 的原生父级，不销毁其
`webContents`。布局保存使用临时文件、flush、close 和 rename 原子替换；
写入错误向宿主传播，损坏或未知版本会回退默认布局。

## 已自动验证

- 布局树、中心标签合并、局部分割、根级停靠和最小尺寸不变量。
- 预览与提交共用同一个候选布局，浮窗客户区尺寸在允许时保持。
- 同一个 `WebContentsView` 完成“停靠 → 浮动 → 停靠”，页面状态与
  WebContents ID 不变。
- 独立 Electron 进程间的布局保存、恢复和损坏回退。
- 简单往返后没有残留 `BaseWindow`，主进程关闭会回收拖动 helper。
- 真实 tgz 消费者可挂入现有 `BrowserWindow`；挂入和独立回收均不改变宿主
  WebContents、页面状态、菜单、关闭监听或窗口生命期。

自动检查验证状态、几何、IPC、持久化和资源不变量，但不等于人工体验验收。

## Alpha 限制

- 公共 API、版本升级策略、框架适配层、可访问性和焦点遍历尚未稳定。
- `0.2.x` 已支持挂入已有 `BrowserWindow`，但宿主必须在自身布局变化时
  调用 `setBounds()`；尚无 Dockview 等第三方布局框架的兼容适配层。
- 真实鼠标锚点、浮出/贴边手感和视觉贴合仍需人工确认。
- 混合 DPI（100%/125%/150%/200%）、跨屏拖动和显示器热插拔尚未完成
  发布级人工验收。
- 连续 100 次拖出/停靠的响应、抖动和资源稳定性尚未完成发布级人工验收。
- native helper 与仓库内回退二进制仅面向 Windows x64；有 `csc.exe` 时优先
  从源码构建，缺少时使用经过源码/二进制双哈希校验的预编译回退。
- 这不是 `QMainWindow` / `QDockWidget` 的跨平台替代，也不兼容 Qt 的
  二进制 `saveState()` 格式。

更完整的证据边界与待验收步骤见
[`docs/FEASIBILITY_STATUS.md`](docs/FEASIBILITY_STATUS.md) 和
[`docs/COMPATIBILITY_CONTRACT.md`](docs/COMPATIBILITY_CONTRACT.md)。

## License

[MIT](LICENSE)
