# Electron Dock

`@tools-qweer/electron-dock` 是一个面向 Electron 的 Windows 原生停靠库。
它让同一个持久 `WebContentsView` 在停靠区和真实 `BaseWindow` 浮窗之间迁移，
不会为了模拟浮动而销毁、重建或重载业务页面。

> **当前成熟度：Alpha / Technology Preview**
>
> `0.2.0-alpha.5` 已适合固定精确版本进行集成和反馈，但公共 API、跨版本迁移、
> 键盘无障碍和多屏人工验收尚未冻结。它不是稳定版，也不是 Qt
> `QDockWidget` 的完整跨平台替代。

## 为什么使用它

Electron 本身提供 `WebContentsView` 和原生窗口，却没有完整的 Dock 系统。
许多 Web Dock 方案通过重建页面或把浮窗留在同一 HTML 布局中实现近似效果，
这会丢失 WebGL、焦点、滚动位置和页面内状态。

Electron Dock 的边界是：

- 每个业务面板只有一个长期存活的 `WebContentsView`。
- 停靠与浮动只改变原生 View 的父级，`webContents.id` 保持不变。
- 浮窗是真实 Windows 原生窗口，可以使用系统标题栏移动。
- 库拥有布局树、Shell、Splitter、拖动预览和重挂载；应用继续拥有业务页面、
  IPC 权限、菜单、账号状态和宿主窗口生命周期。
- 可以挂入已有 `BrowserWindow`，不会重载宿主页、替换菜单或接管关闭策略。

## 支持矩阵

| 项目 | 当前支持 |
|---|---|
| 操作系统 | Windows x64 |
| Electron | `^43.1.1` |
| Node.js | `>=22.12` |
| Main 入口 | ESM |
| Core 入口 | 纯 ESM，不加载 Electron |
| Panel preload | CommonJS |
| macOS / Linux / Windows arm64 | 暂不支持 |

## Alpha.5 已具备的能力

- 挂入已有 `BrowserWindow`，或创建完整的独立 Dock 窗口。
- 水平/垂直嵌套分割、中心标签合并、四边局部分割和工作区外沿停靠。
- 停靠面板一次拖出为真实浮窗，浮窗再次拖回停靠区。
- 同一标签组内拖动标签换位：4 DIP 曼哈顿阈值、实时顺序预览、
  邻项平滑让位、`Esc`/取消回滚、释放后持久化。
- 标签普通点击与拖动手势由同一指针状态机判定；拖动换位后仍可直接切换
  任一标签，标签区域保持桌面 Dock 惯用的箭头指针。
- 标签切换、面板显隐、浮出/回停、Splitter 比例调整和布局重置。
- 版本化布局持久化、原子文件替换、损坏/未知版本回退。
- 结构化 Shell 外观 API，不需要访问私有 Shell 页面或注入 CSS。
- 精确到 Shell/Panel `WebContents` 与 main frame 的 IPC 分权。
- Windows 原生拖动 helper 的超时、异常退出、重启和清理。

当前不包含：

- 跨标签组拖动标签、标签撕出或动态注册/删除业务面板。
- Dockview 等第三方布局框架适配层。
- Qt `saveState()` 二进制格式兼容。
- 完整键盘导航、屏幕阅读器语义和跨平台窗口后端。

## 安装

当前公开渠道是不可变 GitHub Alpha 标签：

```powershell
npm install "github:tools-qweer/Electron-Dock#v0.2.0-alpha.5" electron@^43.1.1
```

Alpha 阶段请固定精确标签或版本，不要依赖 `main` 或其他会移动的分支。

npm 包名已经预留为 `@tools-qweer/electron-dock`，但首发 npm 发布尚未完成。
在 npm 可用前，不要把下面的命令写入生产安装流程：

```powershell
# npm 首发完成后才可使用
npm install @tools-qweer/electron-dock@alpha electron@^43.1.1
```

## 五分钟接入已有窗口

### 1. 创建 Panel preload

```js
// panel-preload.cjs
const {
  exposeElectronDockPreloadApi,
} = require("@tools-qweer/electron-dock/preload");

exposeElectronDockPreloadApi("electronDock");
```

公开 preload 只允许当前 Panel 读取自身状态，以及请求浮出/回停。布局树、
标签换位、Splitter 和拖动预览仍属于库内 Shell 的私有权限。

### 2. 在 Main 中挂入工作区

```ts
import { app, BrowserWindow } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createElectronDockRuntime,
  type ElectronDockPanelWebContentsCreatedEvent,
} from "@tools-qweer/electron-dock";
import {
  createDockLayout,
  createTabsNode,
} from "@tools-qweer/electron-dock/core";

await app.whenReady();

const owner = new BrowserWindow({
  width: 1280,
  height: 800,
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
});
await owner.loadFile(path.join(import.meta.dirname, "host.html"));

const runtime = createElectronDockRuntime();
const authorizedPanels = new Map<number, string>();
const panelPreload = path.join(
  import.meta.dirname,
  "panel-preload.cjs",
);

const workspace = await runtime.attachWorkspace({
  id: "main-workspace",
  window: owner,
  // 宿主内容区坐标，不是屏幕坐标。
  bounds: { x: 220, y: 48, width: 1060, height: 752 },
  panels: [
    {
      id: "outline",
      title: "组件层级",
      minimumWidth: 180,
      content: {
        url: pathToFileURL(
          path.join(import.meta.dirname, "outline.html"),
        ).href,
        preload: panelPreload,
      },
    },
    {
      id: "scene",
      title: "场景",
      minimumWidth: 420,
      content: {
        url: pathToFileURL(
          path.join(import.meta.dirname, "scene.html"),
        ).href,
        preload: panelPreload,
        backgroundThrottling: false,
      },
    },
  ],
  initialLayout: createDockLayout(
    createTabsNode("tabs-main", ["outline", "scene"], "scene"),
  ),
  layoutFilePath: path.join(
    app.getPath("userData"),
    "dock-layout.json",
  ),
  onPanelWebContentsCreated(
    event: ElectronDockPanelWebContentsCreatedEvent,
  ) {
    // 在首次 loadURL() 前同步发生，可在这里登记精确 IPC sender。
    authorizedPanels.set(event.webContents.id, event.panelId);
  },
  onPanelWebContentsDisposed({ webContentsId }) {
    authorizedPanels.delete(webContentsId);
  },
});

owner.on("resize", () => {
  const [width, height] = owner.getContentSize();
  workspace.setBounds({
    x: 220,
    y: 48,
    width: Math.max(1, width - 220),
    height: Math.max(1, height - 48),
  });
});

owner.once("closed", () => {
  // 宿主仍拥有自己的关闭策略；库只回收它创建的资源。
  void runtime.dispose();
});
```

仓库内还有一个可直接运行的
[`attachWorkspace` 示例](examples/attach-existing-window/README.md)。

## Shell 外观

不要扫描库内 Shell URL、访问私有 `WebContents` 或向 `.dock-*` 类注入 CSS。
当前版本提供结构化外观合同：

```ts
const workspace = await runtime.attachWorkspace({
  // ...其他选项
  shellAppearance: {
    colors: {
      colorScheme: "dark",
      shellBackground: "#101111",
      foreground: "#b8b8b8",
      mutedForeground: "#7e8381",
    },
    font: {
      family: '"Microsoft YaHei UI", "Segoe UI", sans-serif',
      size: 13,
      weight: 400,
    },
    titleBar: {
      background: "#1a1a1a",
      foreground: "#eeeeee",
      borderWidth: 0,
      bottomBorderColor: "#3a3d3c",
      bottomBorderWidth: 1,
      fontSize: 12,
      fontWeight: 400,
      lineHeight: 28,
    },
    tabBar: {
      background: "#101111",
      borderWidth: 0,
      topBorderColor: "#3a3d3c",
      topBorderWidth: 1,
    },
    tab: {
      hoverBackground: "#292929",
      activeBackground: "#15473e",
      activeForeground: "#00ffcc",
    },
    splitter: {
      background: "#101111",
      hoverBackground: "#3a3d3c",
    },
  },
});

// 动态更新不会重建布局或业务 WebContents。
workspace.setShellAppearance({
  titleBar: { background: "#172331" },
  tab: { activeForeground: "#42c8ff" },
});

// 恢复库默认外观。
workspace.setShellAppearance(null);
```

输入会被规范化到固定 token 集；任意 CSS、选择器和脚本都不会进入 Shell。
初始外观在 Shell 首次显示前应用，避免先闪过默认主题。
需要在不加载 Electron 的 Node 工具或测试中预先规范化外观时，请从纯
`@tools-qweer/electron-dock/core` 入口导入
`normalizeElectronDockShellAppearance()` 和
`DEFAULT_ELECTRON_DOCK_SHELL_APPEARANCE`。

## 布局持久化

最简单的方式是传入 `layoutFilePath`，库会使用临时文件、flush、close 和
rename 完成原子替换。也可以提供应用自己的存储适配器：

```ts
import {
  parseDockLayoutPersistence,
  serializeDockLayoutPersistence,
  type AtomicLayoutTextStorage,
} from "@tools-qweer/electron-dock";

const storage: AtomicLayoutTextStorage = {
  async readText() {
    return await configurationStore.read("dockLayout");
  },
  async writeTextAtomically(value) {
    // 此方法必须由宿主保证原子提交。
    await configurationStore.replaceAtomically("dockLayout", value);
  },
};

// 在 attachWorkspace() 或 createWindow() 的选项中传入 storage；
// 它优先于 layoutFilePath。
const serialized = serializeDockLayoutPersistence(workspace.snapshot().layout);
const parsed = parseDockLayoutPersistence(serialized);
if (parsed !== null) {
  console.log(parsed.layout);
}
```

解析损坏 JSON、未知 schema 或未知版本时返回 `null`，不会抛出。布局写入错误
会保留到 `flush()`、`dispose()` 或库拥有窗口的 `close()`，不会被成功结果
掩盖。

## 公开 API 速览

### 包根入口

- `createElectronDockRuntime()`；返回的 runtime 提供
  `attachWorkspace()` / `createWindow()`
- `ElectronDockWorkspace` / `ElectronDockWindow`
- `ElectronDockShellAppearance`
- `normalizeElectronDockShellAppearance()` /
  `DEFAULT_ELECTRON_DOCK_SHELL_APPEARANCE`
- `serializeDockLayoutPersistence()` / `parseDockLayoutPersistence()`
- 布局、Panel、矩形和快照类型

### `ElectronDockWorkspace`

| 方法 | 用途 |
|---|---|
| `setBounds()` | 更新工作区在宿主内容区中的位置和大小 |
| `setVisible()` | 隐藏/显示 Shell 与业务面板 |
| `setInteractionEnabled()` | 暂停/恢复 Dock 写交互 |
| `setShellAppearance()` | 动态替换结构化外观；`null` 恢复默认 |
| `snapshot()` / `onDidChange()` | 读取或订阅布局、几何、Panel 与外观状态 |
| `activatePanel()` | 激活指定 Panel |
| `setPanelVisible()` | 设置稳定的用户显隐偏好 |
| `float()` / `redock()` | 由宿主显式浮出或停靠 |
| `reset()` | 恢复初始布局 |
| `flush()` | 等待持久化队列并传播错误 |
| `dispose()` | 回收库资源，不销毁消费者拥有的窗口 |

Panel 快照中的 `requestedVisible` 是稳定偏好；`visible` 是当前实际呈现状态。
因此非活动标签可能 `requestedVisible: true`、`visible: false`。

### `@tools-qweer/electron-dock/core`

纯算法入口，不加载 Electron 或 React。除布局构建、校验和迁移 API 外，还
导出布局持久化编解码器与 Shell 外观规范化函数，适合 Node 工具和单元测试。

### `@tools-qweer/electron-dock/preload`

- `createElectronDockPreloadApi()`
- `exposeElectronDockPreloadApi()`
- `getPanelState()` / `onPanelStateChanged()`
- `floatPanel()` / `redockPanel()`

`floatPanel()` 与 `redockPanel()` 成功后返回稳定 Panel 状态；工作区不可见或
交互被禁用时，Panel 发起的写请求会被 Main 拒绝。

## 打包

如果应用启用 ASAR，必须把 native helper 解包，例如：

```yaml
asarUnpack:
  - node_modules/@tools-qweer/electron-dock/dist/native/**
```

也可以在运行时资源选项中显式传入已解包 helper 路径。缺少可执行 helper
会直接报错，不会静默降级为近似拖动。

包内回退 helper 固定为 Windows x64，并通过源码哈希、二进制哈希和 PE
Machine `0x8664` 校验。目前尚未提供代码签名。

## 安全模型

- 导入包本身不会创建窗口、注册生命周期或暴露 preload API。
- Main 是布局、重挂载和拖动状态的唯一权威。
- Shell 与 Panel 使用不同 preload；业务 Panel 无法取得 Shell 写权限。
- IPC 校验精确 `WebContents`、main frame、页面身份和交互状态。
- `onPanelWebContentsCreated` 在首次导航前同步触发，便于消费者建立自己的
  sender 白名单。
- Shell 外观只接受规范化 token，不接受任意 CSS。

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要先创建公开 Issue。

## 开发与验证

```powershell
git clone https://github.com/tools-qweer/Electron-Dock.git
cd Electron-Dock
npm ci
npm run release:check
```

常用命令：

```powershell
npm start
npm test
npm run typecheck
npm run smoke:reparent
npm run package:consumer
npm run package:consumer:electron
npm run pack:dry-run
```

`package:consumer` 会真实 `npm pack`，把 tgz 安装到临时消费者中，再验证包根、
`./core`、`./preload` 的类型和导入边界。Electron 消费 smoke 还验证挂入已有
窗口、状态保持、sender 预登记、外观更新、浮出/回停和独立回收。

自动检查能证明状态、几何、IPC、持久化和资源不变量，但不能替代真实拖动手感、
混合 DPI、多屏与长时间操作的人工验收。

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，维护者发布流程见
[docs/RELEASING.md](docs/RELEASING.md)。

## 当前 Alpha 限制与稳定版门槛

以下工作完成前不会宣称稳定：

- 100% / 125% / 150% / 200% 混合 DPI、多屏与热插拔人工验证。
- 连续 100 次浮出/停靠的手感、响应和资源稳定性人工验证。
- 公共 API 与跨版本迁移策略冻结。
- 完整焦点遍历、键盘操作和屏幕阅读器语义。
- native helper 签名与更广平台支持。

更详细的证据边界、兼容合同和人工步骤见：

- [可行性状态](docs/FEASIBILITY_STATUS.md)
- [Windows 行为兼容合同](docs/COMPATIBILITY_CONTRACT.md)
- [发布流程](docs/RELEASING.md)
- [更新记录](CHANGELOG.md)

## License

[MIT](LICENSE)
