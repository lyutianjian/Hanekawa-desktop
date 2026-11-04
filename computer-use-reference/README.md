# Computer Use 本地参考资料

实施计划与两套参考资料统一保存在本目录。两套资料已于 2026-11-04 从原工作目录移动到当前项目，正文、源码、实验记录、截图及原始 ZIP 均保留。移动前后逐文件校验 SHA-256，共 94 个原始文件，内容一致。

- [macOS 后续实施计划](COMPUTER_USE_MACOS_PLAN.md)

## 1. Codex Computer Use 逆向分析

| 入口 | 内容 |
| --- | --- |
| [资料说明](codex-computeruse-reverse/README.md) | 全部文件和复验方式 |
| [技术文档](codex-computeruse-reverse/技术文档.md) | 架构、AX、截图、差分、权限与复现边界 |
| [核心代码导读](codex-computeruse-reverse/核心代码导读.md) | 功能与提取模块的对应关系 |
| [可读核心代码](codex-computeruse-reverse/core/readable/) | 18 个按功能整理的阅读模块 |
| [原始变量格式化代码](codex-computeruse-reverse/core/formatted/) | 保留原变量的对照版本 |
| [动态实验](codex-computeruse-reverse/dynamic-experiment.md) | 实际计算器操作的观察记录 |
| [源码定位证据](codex-computeruse-reverse/evidence.json) | 源路径、哈希及代码映射 |
| [原始 ZIP](Codex_ComputerUse_逆向技术文档与核心代码.zip) | 移动时保持原样的完整资料包 |

## 2. TS + Electron 工程参考

| 入口 | 内容 |
| --- | --- |
| [工程说明](computer-use-ts-electron/README.md) | 示例工程的构建、运行、验证与边界 |
| [工程设计](computer-use-ts-electron/docs/工程化设计.md) | 接口、进程、队列、快照、取消与恢复 |
| [来源与替换清单](computer-use-ts-electron/docs/来源与替换清单.md) | 来源、独立实现与专属依赖替代 |
| [接入与验收](computer-use-ts-electron/docs/接入与验收.md) | 集成步骤和真实 macOS 验收场景 |
| [TypeScript 源码](computer-use-ts-electron/src/) | 契约、自动化层、驱动与示例界面 |
| [Swift 参考驱动](computer-use-ts-electron/native/MacAXBridge.swift) | 独立编写的公共 AX API 示例 |
| [验证记录](computer-use-ts-electron/validation/验证记录.md) | 类型、模拟测试和 Electron 验证结果 |
| [原始 ZIP](TS_Electron_ComputerUse_工程参考.zip) | 移动时保持原样的完整工程包 |

## 3. 使用约定

- 所有导航使用本项目内的相对文件路径，不依赖会话深度链接。
- 原始资料中的机器路径、哈希、版本和实验数据保留为历史证据。更新软件后重新验证，不把旧采样当成当前事实。
- 参考工程的验证结果不代表 Hanekawa 当前原生功能已通过真实 GUI 验收。
- 原始提取代码用于分析对照；Hanekawa 的生产实现独立编写，不将其作为运行依赖。
- 此目录与实施计划随当前分支提交到 Git，供跨机开发使用；不作为产品运行依赖，不进入发布安装包。
