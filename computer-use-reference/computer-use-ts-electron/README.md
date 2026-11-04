# Computer Use：TypeScript + Electron 工程参考

基于 2026-11-04 引用会话《逆向分析 Codex computeruse》的工程化整理。这里交付的是**独立编写的参考工程与设计文档**；运行不依赖 ChatGPT.app、Codex REPL、Sky 服务或其受信身份。

先读 [工程化设计](docs/工程化设计.md)，再看 [接入与验收](docs/接入与验收.md)。逆向机制到模块的对应关系见 [来源与替换清单](docs/来源与替换清单.md)。实际验证范围见 [验证记录](validation/验证记录.md)。

## 快速运行

本次使用 Node 24.22.2、npm 11.19.1、TypeScript 7.0.2、Electron 45.2.1、esbuild 0.28.2；依赖有 lockfile。版本是本次验证样本，迁入现有项目时按该项目的 Electron 支持线选定并重新验证。

```sh
npm ci
npm run typecheck
npm test
npm run demo
npm start
```

默认选择 Mock Counter。点击“开始会话 → 读取 AX → AXPress”，右侧应从 `Count 0` 变为 `Count 1`；“取消会话”释放目标，旧引用作废。Mock 模式无需桌面控制权限，不修改其他应用。

`npm run demo` 是无界面的 Mock 会话闭环；`npm run test:electron` 则运行真实 Electron 的 Renderer → Preload → Main → Mock 闭环，并在 `build/` 输出报告和截图。后者需要可用的桌面登录会话。

## macOS 接入

要求 macOS 14.4+、Xcode Command Line Tools。

```sh
npm run native:build
resources/bin/mac-ax-bridge --self-test
npm start
```

先手动打开计算器，仅保留一个窗口；在界面选择 Calculator 并同意本次应用访问。若返回 `PERMISSION_REQUIRED`，在系统设置的辅助功能中为实际显示的调用主体正常授权，再取消旧会话、重新开始。开发期命令行 helper 与签名打包后的 TCC 归属可能不同，需要按实际授权条目复验。本例不自动打开设置、请求屏幕录制或修改系统权限。

读取实际树后选择本次返回的按钮，不要硬编码索引。动作后会重新读取树，需人工核对实际结果。helper 自检仅验证输入解析；本次真实桌面 AX 路径的验证情况以验证记录为准。

## 目录

```text
src/shared/            TS 契约、错误、严格运行时校验
src/main/              发送者检查、应用授权、目标租约、生命周期
src/preload/           五个具名桥接方法，打包为单个 CJS
src/renderer/          本地任务和观察界面
src/automation/        Driver 契约、快照与串行会话
src/drivers/mock.ts    无系统副作用的参考驱动
src/drivers/macos/     私有子进程 JSONL 客户端与 AX 适配
src/drivers/browser/   浏览器扩展契约说明，尚未实现
native/                公共 macOS AX API 的 Swift helper
tests/                 会话、校验、传输与 Electron 集成测试
packaging/             打包模板与发布注意项
docs/                  架构、迁入步骤、来源映射、验收
validation/            本次验证报告与界面截图
```

## 已实现的边界

- 单应用租约、单会话动作串行、快照引用检查、PID/启动时间/窗口变化拒绝。
- 入站 IPC、模型接入可复用的 action parser、原生响应三处运行时校验。
- 端到端截止时间、取消绕过队列、helper 退出后再释放租约、崩溃后显式新建会话。
- Main 中的应用白名单与授权对话框，受限 Preload，沙箱 Renderer。

第一版只提供 `observe / press / setValue`。截图、坐标输入、稳定索引差分、多窗口选择、浏览器驱动、自动感知用户接管、模型 API 和任意代码执行未接入；这些能力在契约或设计文档中明确区分。不要把 Mock 测试通过理解为原生 GUI、签名包或生产可靠性已验收。
