# @tools-qweer/electron-dock

Windows x64 原生 Electron 停靠组件。它让同一个持久
`WebContentsView` 面板在主窗口停靠区和真实 `BaseWindow` 浮窗之间迁移，
不通过销毁、重建或重载面板来模拟浮动。

当前版本是 `0.1.0-alpha.1`。它用于尽早验证集成边界，不代表公共 API 已
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
npm install 'github:tools-qweer/Electron-Dock#v0.1.0-alpha.1' electron@^43.1.1
```

发布到 npm 后也可使用：

```powershell
npm install @tools-qweer/electron-dock@alpha electron@^43.1.1
```

Alpha 阶段建议固定精确标签或版本，不要依赖会移动的分支。

## 最小接入

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
`getHostState`、`onHostChanged`、`floatPanel`、`redockPanel` 和
`readPanelSnapshot`。工作区布局、标签切换、分割线调整和拖动预览由库内
Shell preload 独占，不会暴露给业务面板。

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
`package:consumer:electron` 额外下载/启用 Electron 二进制，从已安装 tgz
创建一个 `show:false` 窗口、等待业务面板和 native helper 就绪，再完整
dispose；该真实桌面 smoke 留作 Windows 本地/有桌面 runner 验证。

`npm run build` 同时生成发布入口的 JavaScript/TypeScript 声明，以及现有
演示所需的 `dist/demo/index.js`、内部 preload、renderer 和 Windows 原生
拖动 helper。有系统 `.NET Framework` `csc.exe` 时，helper 会从
`native/windows-drag-helper.cs` 重新编译；精简 Windows 环境没有该编译器时，
构建会先校验仓库内 Windows x64 预编译 helper 与源码哈希清单，再复制到
`dist/native/`。因此从 GitHub 标签安装不要求目标机器必须存在 `csc.exe`。
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

每个业务面板拥有独立 `WebContentsView`。停靠和浮动只改变 View 的原生
父级，不销毁其 `webContents`。布局保存使用临时文件、flush、close 和
rename 原子替换；损坏或未知版本会回退默认布局。

## 已自动验证

- 布局树、中心标签合并、局部分割、根级停靠和最小尺寸不变量。
- 预览与提交共用同一个候选布局，浮窗客户区尺寸在允许时保持。
- 同一个 `WebContentsView` 完成“停靠 → 浮动 → 停靠”，页面状态与
  WebContents ID 不变。
- 独立 Electron 进程间的布局保存、恢复和损坏回退。
- 简单往返后没有残留 `BaseWindow`，主进程关闭会回收拖动 helper。

自动检查验证状态、几何、IPC、持久化和资源不变量，但不等于人工体验验收。

## Alpha 限制

- 公共 API、版本升级策略、框架适配层、可访问性和焦点遍历尚未稳定。
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
