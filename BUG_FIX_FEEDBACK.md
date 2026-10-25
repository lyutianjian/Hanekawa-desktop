# Bug 修复核验与反馈报告

日期：2026-10-25（Asia/Taipei）  
对象：[BUG_SCAN_PLAN.md](/Users/miyano/Documents/code/Hanekawa/BUG_SCAN_PLAN.md) 的 B01–B46；R01–R04 单列。

> 后续状态：已根据本报告补修 7 项，验证结果见文末“反馈后的补修记录”。以下原核验结论保留为补修前的审计快照。

## 本轮结论

**修复已大范围落地，现有完整测试、类型检查和桌面构建均通过；但目前不能将 46 条全部结案。**

本轮重新核对当前代码和回归，而非照抄计划中的完成标记。发现 **5 条仍有未闭合路径（B24、B29、B31、B32、B39）**；另有 **2 条关键证据不足（B13、B28）**。B33–B36 已有代码和自动化回归，仍需真实 Electron/目标平台验收。B31/B32 同样保留真机验收要求。

| 本轮分类 | 数量 | 解释 |
| --- | ---: | --- |
| 本机核验通过 | 35 | 已检查修复实现，相关现有回归随全套通过；不表示所有平台或所有边界已测完。 |
| 修复不完整 | 5 | 4 条通过行为探针复现残留；B32 通过源码及实际事件回调模拟确认生命周期冲突，未做目标平台 E2E。 |
| 关键证据不足 | 2 | POSIX/模型 ID 变化部分已通过，但原计划要求的 Windows/同名 endpoint 来源分支未闭合。 |
| 自动化通过、真机待验 | 4 | B33–B36；这四条按主结论单列，避免与部分修复项重复计数。 |
| 合计 | 46 | P0 11 条、P1 28 条、P2 7 条。B29 的会话与设置部分合并计 1 条。 |

P0 B01–B11 的本机回归均通过，未在本轮核验中发现这些原触发路径仍然存在；P2 B40–B46 的实现及对应本机回归也通过。后续工作主要在 P1 剩余路径和平台验收。

## 核验范围、版本与方法

- 工作目录：/Users/miyano/Documents/code/Hanekawa；分支 main；HEAD：66427fc25566d6ff41b8f5579e2d0d0a4f310c49（66427fc，p0）。对照计划原基线 b0e7b1e，检查已提交改动及当前未提交修复。
- 核验快照：2026-10-25 13:48（Asia/Taipei）。当时已有 **83 个已跟踪修改文件、14 个未跟踪新增文件**；结论针对该工作树，不是只针对 HEAD，也不是“已发布版本”的证明。
- 环境：macOS / darwin 27.0.0、arm64、Node v24.21.0、npm 11.19.0。
- 以计划作为缺陷与验收依据；其中实施步骤没有被当成用户授权去继续修复。本轮未修改业务源码、正式测试、依赖或原计划，未 commit/push，未创建 PR。
- 检查所属模块的实现、相关类型与测试，重跑验证；对发现的疑点编写隔离审计探针，使用临时 HOME/项目、假页面/CDP、fake provider。没有读取真实会话作 fixture，也没有向真实模型服务发送请求。
- 保存了 [830 个既有文件的 SHA-256 清单](/Users/miyano/Documents/code/Hanekawa/archive/bug-fix-review-20261025-5MMbfj/source-manifest.json)、[核验时工作树状态](/Users/miyano/Documents/code/Hanekawa/archive/bug-fix-review-20261025-5MMbfj/worktree-status.txt) 和 [环境信息](/Users/miyano/Documents/code/Hanekawa/archive/bug-fix-review-20261025-5MMbfj/audit-environment.json)；收尾再次校验既有文件未变。

## 本轮实际运行结果

| 命令/检查 | 结果 | 证据 |
| --- | --- | --- |
| npm test -- --test-reporter=tap | **4315 / 4315 通过**；36 suites；0 失败、0 取消、0 跳过；约 17.26 秒 | [完整 TAP 日志](/Users/miyano/Documents/code/Hanekawa/archive/bug-fix-review-20261025-5MMbfj/full-tests.tap) |
| npm run typecheck | 通过，base/preload/renderer/domtest 四个程序 | [typecheck.log](/Users/miyano/Documents/code/Hanekawa/archive/bug-fix-review-20261025-5MMbfj/typecheck.log) |
| npm run build:desktop | 通过，TS、preload/renderer/theme-boot 和资源拷贝 | [build-desktop.log](/Users/miyano/Documents/code/Hanekawa/archive/bug-fix-review-20261025-5MMbfj/build-desktop.log) |
| npm run verify:sharp | 本机 Node 通过，sharp 0.35.4 解码 PNG 64×64 | [verify-sharp.log](/Users/miyano/Documents/code/Hanekawa/archive/bug-fix-review-20261025-5MMbfj/verify-sharp.log) |
| npm test -- --test-reporter=tap archive/bug-fix-review-20261025-5MMbfj/audit-probes.test.ts | 6 个顶层探针、10 项含子测试均通过；含 4 项行为残留和 1 项跨平台生命周期模拟 | [探针源码](/Users/miyano/Documents/code/Hanekawa/archive/bug-fix-review-20261025-5MMbfj/audit-probes.test.ts)、[探针日志](/Users/miyano/Documents/code/Hanekawa/archive/bug-fix-review-20261025-5MMbfj/audit-probes.tap) |
| git diff --check | 通过 | [diff-check.log](/Users/miyano/Documents/code/Hanekawa/archive/bug-fix-review-20261025-5MMbfj/diff-check.log) |

**审计探针的“通过”表示成功观察到残留问题，不能算作修复后的回归通过。** 正式全套 4315 项与额外 10 项探针分开统计。本轮全套没有出现计划基线提到的 rendererStyleTokens 失败；这只能说明当前快照该断言通过。

## 逐项核验

### P0（B01–B11）

| 编号 | 问题 | 本轮结论 | 核验说明与回归证据 |
| --- | --- | --- | --- |
| B01 | 损坏配置被覆盖 | 通过 | 配置读取区分不存在、损坏与读取失败，失败时保留内存和原文件；[配置文件读写](/Users/miyano/Documents/code/Hanekawa/src/config/file.ts)。<br>回归：[config](/Users/miyano/Documents/code/Hanekawa/test/config.test.ts)、[settingsPersistence](/Users/miyano/Documents/code/Hanekawa/test/settingsPersistence.test.ts)。 |
| B02 | 符号链接祖先拒绝合法写入 | 通过 | 写入绑定真实目标，允许合法的祖先链接，继续拒绝目标文件链接及越界写入；[目标路径校验](/Users/miyano/Documents/code/Hanekawa/src/tools/pathSafety.ts)。<br>回归：[fileToolSymlinkSafety](/Users/miyano/Documents/code/Hanekawa/test/fileToolSymlinkSafety.test.ts)、[writeTargetBinding](/Users/miyano/Documents/code/Hanekawa/test/writeTargetBinding.test.ts)。 |
| B03 | 原子写丢权限、残留临时文件 | 通过 | 唯一临时文件、保留已有 mode，写入/chmod/rename 失败清理；[共用写入实现](/Users/miyano/Documents/code/Hanekawa/src/tools/textFile.ts)。<br>回归：[fileToolLineEndings](/Users/miyano/Documents/code/Hanekawa/test/fileToolLineEndings.test.ts)。 |
| B04 | UTF-16LE Write 丢 BOM | 通过 | 编码、BOM、CRLF 元数据随读写保留，无重复 BOM；[编码处理](/Users/miyano/Documents/code/Hanekawa/src/tools/textFile.ts)。<br>回归：[fileToolLineEndings](/Users/miyano/Documents/code/Hanekawa/test/fileToolLineEndings.test.ts)。 |
| B05 | 隐藏权限卡接收快捷键、抢焦点 | 通过 | 窗口覆盖层参与键盘和焦点判定；[键盘路由](/Users/miyano/Documents/code/Hanekawa/src/desktop/renderer/model/keymap.ts)。结论限本机模型/DOM 回归。<br>回归：[rendererShellModel](/Users/miyano/Documents/code/Hanekawa/test/rendererShellModel.test.ts)、[rendererComposerView](/Users/miyano/Documents/code/Hanekawa/test/rendererComposerView.test.ts)。 |
| B06 | 项目配置污染全局、借用凭证 | 通过 | 全局模型和 endpoint 来源收敛到可信配置；项目配置不自动导入；[ConfigService](/Users/miyano/Documents/code/Hanekawa/src/config/service.ts)。<br>回归：[config](/Users/miyano/Documents/code/Hanekawa/test/config.test.ts)、[configMigration](/Users/miyano/Documents/code/Hanekawa/test/configMigration.test.ts)、[runtimeBootstrap](/Users/miyano/Documents/code/Hanekawa/test/runtimeBootstrap.test.ts)。 |
| B07 | GUI 启动 PATH 不完整 | 通过 | 启动前执行一次有界登录 shell PATH 探测，异常保留原 PATH；[GUI PATH](/Users/miyano/Documents/code/Hanekawa/src/desktop/guiPath.ts)。Finder/安装产物启动仍需验收。<br>回归：[desktopGuiPath](/Users/miyano/Documents/code/Hanekawa/test/desktopGuiPath.test.ts)、[desktopMain](/Users/miyano/Documents/code/Hanekawa/test/desktopMain.test.ts)。 |
| B08 | 退出重入绕过异步收尾 | 通过 | 退出状态分 idle/draining/ready，多次退出在 drain 完成前都被拦截；[退出状态机](/Users/miyano/Documents/code/Hanekawa/src/desktop/quitCoordinator.ts)。未做 Windows/Linux 实机退出。<br>回归：[desktopMain](/Users/miyano/Documents/code/Hanekawa/test/desktopMain.test.ts)。 |
| B09 | rewind 使已发送队列消息复活 | 通过 | rewind 与消息队列共用串行边界，淘汰被截断的已发送项并保留真正待发送项；[队列协调](/Users/miyano/Documents/code/Hanekawa/src/runtime/messageQueue.ts)。<br>回归：[messageQueue](/Users/miyano/Documents/code/Hanekawa/test/messageQueue.test.ts)、[protocolHost](/Users/miyano/Documents/code/Hanekawa/test/protocolHost.test.ts)。 |
| B10 | 运行中 retarget/clear 跨会话污染 | 通过 | 准备阶段即标记 busy；切换统一经 guard 和 RuntimeSlot 替换，记录归属固定；[会话切换](/Users/miyano/Documents/code/Hanekawa/src/runtime/sessionSwitch.ts)。<br>回归：[sessionController](/Users/miyano/Documents/code/Hanekawa/test/sessionController.test.ts)、[sessionSwitch](/Users/miyano/Documents/code/Hanekawa/test/sessionSwitch.test.ts)、[protocolHost](/Users/miyano/Documents/code/Hanekawa/test/protocolHost.test.ts)。 |
| B11 | HTTP 状态子串误触发重试 | 通过 | 结构化状态优先，消息仅识别完整状态标记及明确限流词；[错误分类](/Users/miyano/Documents/code/Hanekawa/src/config/retry.ts:256)。<br>回归：[retry](/Users/miyano/Documents/code/Hanekawa/test/retry.test.ts)。 |

### P1（B12–B39）

| 编号 | 问题 | 本轮结论 | 核验说明与回归证据 |
| --- | --- | --- | --- |
| B12 | 取消压缩计入熔断 | 通过 | 取消原样上抛，不计失败、不走文本 fallback；真实连续失败仍熔断；[自动压缩](/Users/miyano/Documents/code/Hanekawa/src/harness/compact.ts)。<br>回归：[compact](/Users/miyano/Documents/code/Hanekawa/test/compact.test.ts)、[sessionController](/Users/miyano/Documents/code/Hanekawa/test/sessionController.test.ts)。 |
| B13 | hook 超时未终止进程树 | 证据不足 | POSIX 实际子进程测试通过；Windows 的父先退出分支仍有风险且用例明确跳过，不能关闭跨平台验收。详见下文。<br>回归：[hooks](/Users/miyano/Documents/code/Hanekawa/test/hooks.test.ts)。 |
| B14 | 三个并发 enqueue 破坏串行 | 通过 | 调用时立即预约 promise tail，前一个失败不堵住后续；五个混合 run/runTool 验证最大并发为 1；[串行入口](/Users/miyano/Documents/code/Hanekawa/src/harness/loop.ts)。<br>回归：[loop](/Users/miyano/Documents/code/Hanekawa/test/loop.test.ts)、[loopAbort](/Users/miyano/Documents/code/Hanekawa/test/loopAbort.test.ts)。 |
| B15 | 权限/pre-hook 异常留下悬空 tool_use | 通过 | 已持久化 use 的业务失败结算失败结果；持久化错误上抛且不重复补写；[工具结算](/Users/miyano/Documents/code/Hanekawa/src/harness/toolRunner.ts)。<br>回归：[toolRunner](/Users/miyano/Documents/code/Hanekawa/test/toolRunner.test.ts)。 |
| B16 | 准备文件快照期间 Stop 无效 | 通过 | AbortController 在 prepare 前建立；快照完成后检查取消，不启动 provider；[回合准备与取消](/Users/miyano/Documents/code/Hanekawa/src/runtime/sessionController.ts)。<br>回归：[sessionController](/Users/miyano/Documents/code/Hanekawa/test/sessionController.test.ts)。 |
| B17 | 并发打开同一会话创建重复 pane | 通过 | 按 sessionId 复用 opening promise；关闭 workspace 后处置晚到 scope；[会话打开](/Users/miyano/Documents/code/Hanekawa/src/runtime/sessionWorkspace.ts)。<br>回归：[sessionWorkspace](/Users/miyano/Documents/code/Hanekawa/test/sessionWorkspace.test.ts)、[desktopShellHost](/Users/miyano/Documents/code/Hanekawa/test/desktopShellHost.test.ts)。 |
| B18 | wake 回草稿、丢弃后锁不释放 | 通过 | 按 turn origin 决定草稿恢复，pending wake 丢弃回执归还 notes、计数并解锁；[wake 结算](/Users/miyano/Documents/code/Hanekawa/src/runtime/coordination/wakeEngine.ts)。<br>回归：[sessionController](/Users/miyano/Documents/code/Hanekawa/test/sessionController.test.ts)、[wakeEngine](/Users/miyano/Documents/code/Hanekawa/test/wakeEngine.test.ts)、[protocolHost](/Users/miyano/Documents/code/Hanekawa/test/protocolHost.test.ts)。 |
| B19 | startThread 失败资源回滚不完整 | 通过 | 资源创建整体进入补偿边界，各项清理独立尝试，启动计数在 finally 结算；[线程启动](/Users/miyano/Documents/code/Hanekawa/src/runtime/coordination/service.ts)。<br>回归：[coordinationService](/Users/miyano/Documents/code/Hanekawa/test/coordinationService.test.ts)、[threadWorktree](/Users/miyano/Documents/code/Hanekawa/test/threadWorktree.test.ts)、[sessions](/Users/miyano/Documents/code/Hanekawa/test/sessions.test.ts)。 |
| B20 | 通道关闭后新命令一直 pending | 通过 | hostGone 立即拒绝新命令，post 同步异常也结算 pending reply；[命令发送](/Users/miyano/Documents/code/Hanekawa/src/runtime/protocol/client.ts)。<br>回归：[protocolClient](/Users/miyano/Documents/code/Hanekawa/test/protocolClient.test.ts)、[protocolHost](/Users/miyano/Documents/code/Hanekawa/test/protocolHost.test.ts)。 |
| B21 | 后台 stop/MCP 初始化资源泄漏 | 通过 | MCP 列工具或注册失败关闭已连接 manager，并撤回半注册工具；stopAll 单项失败不阻止其他项；[MCP 初始化](/Users/miyano/Documents/code/Hanekawa/src/runtime/mcp.ts)。原“stop 失败跳过 MCP 关闭”不是本轮新增确认的缺陷。<br>回归：[mcpStartup](/Users/miyano/Documents/code/Hanekawa/test/mcpStartup.test.ts)、[backgroundTasks](/Users/miyano/Documents/code/Hanekawa/test/backgroundTasks.test.ts)、[runtimeBootstrap](/Users/miyano/Documents/code/Hanekawa/test/runtimeBootstrap.test.ts)。 |
| B22 | Grep/Glob 超量输出先整体缓冲 | 通过 | rg 输出流式计数，仅保留结果窗口，Glob fallback 也流式枚举；超过旧 10 MiB 上限的回归通过；[输出收集](/Users/miyano/Documents/code/Hanekawa/src/tools/rgStream.ts)。<br>回归：[grepSearch](/Users/miyano/Documents/code/Hanekawa/test/grepSearch.test.ts)。 |
| B23 | Grep fallback 的 glob/隐藏文件语义 | 通过 | 无目录 glob 按 basename 匹配，遍历包含隐藏源码；现有跨后端 fixture 通过；[fallback 搜索](/Users/miyano/Documents/code/Hanekawa/src/tools/GrepTool/GrepTool.ts)。该结论不扩大到所有边缘 pattern。<br>回归：[grepSearch](/Users/miyano/Documents/code/Hanekawa/test/grepSearch.test.ts)。 |
| B24 | home 搜索扫入内部会话数据 | 修复不完整 | 普通 home 路径已排除；home 软链接可绕过两种 Grep 后端的排除，Glob fallback 也未复用同一排除。补充探针已复现。<br>回归：[grepSearch](/Users/miyano/Documents/code/Hanekawa/test/grepSearch.test.ts)。 |
| B25 | 本地 HTTP 被升级、响应体无字节上限 | 通过 | 保留 loopback HTTP，按实际字节流限制 5 MiB；本地服务、多字节、取消、失败不缓存回归通过；[HTTP 抓取](/Users/miyano/Documents/code/Hanekawa/src/tools/WebFetchTool/WebFetchTool.ts)。<br>回归：[webFetch](/Users/miyano/Documents/code/Hanekawa/test/webFetch.test.ts)。 |
| B26 | Config 模型默认值写错来源 | 通过 | 模型字段通过 runtime 注入端口写 ConfigService/config.json，保存失败恢复内存并返回失败；[模型配置端口](/Users/miyano/Documents/code/Hanekawa/src/runtime/modelConfigPort.ts)。并发保存限制见 B29。<br>回归：[configTool](/Users/miyano/Documents/code/Hanekawa/test/configTool.test.ts)、[config](/Users/miyano/Documents/code/Hanekawa/test/config.test.ts)。 |
| B27 | general 路由被默认 inherit 遮挡 | 通过 | 移除 specific 默认物化，显式 inherit 仍保留；保存/重载用例通过；[路由默认值](/Users/miyano/Documents/code/Hanekawa/src/config/routing.ts)。<br>回归：[modelRouting](/Users/miyano/Documents/code/Hanekawa/test/modelRouting.test.ts)。 |
| B28 | opaque thinking 来源校验 | 证据不足 | 不同/未知 model 字符串已在最终 payload 过滤；同名模型换 endpoint 的来源证明仍不足。新增核心回归实际在 config.test.ts。<br>回归：[config](/Users/miyano/Documents/code/Hanekawa/test/config.test.ts)、[requestPrep](/Users/miyano/Documents/code/Hanekawa/test/requestPrep.test.ts)、[anthropicProvider](/Users/miyano/Documents/code/Hanekawa/test/anthropicProvider.test.ts)。 |
| B29 | repairRecords/配置读改写竞争 | 修复不完整 | 会话 repair 整段持锁及 settings mutation 已修；独立 ConfigService 保存全量旧快照仍覆盖彼此改动，两个 save 都会成功。补充探针已复现。<br>回归：[sessionRepair](/Users/miyano/Documents/code/Hanekawa/test/sessionRepair.test.ts)、[settingsPersistence](/Users/miyano/Documents/code/Hanekawa/test/settingsPersistence.test.ts)。 |
| B30 | gitignore 特殊文件名过滤失败 | 通过 | check-ignore 输入输出改为 NUL 分隔，不 trim；Unicode、空白及嵌入分隔符回归通过；[忽略匹配](/Users/miyano/Documents/code/Hanekawa/src/utils/gitIgnore.ts)。<br>回归：[gitIgnore](/Users/miyano/Documents/code/Hanekawa/test/gitIgnore.test.ts)。 |
| B31 | Browser 等待缺取消/超时 | 修复不完整 | 常规 evaluator/sender 已有 bounds；emulation 直接调用 session.send 绕过，取消后晚到回复还会发送后续命令。补充 host 探针已复现；真实页面另待验。<br>回归：[browserBounds](/Users/miyano/Documents/code/Hanekawa/test/browserBounds.test.ts)、[browserInput](/Users/miyano/Documents/code/Hanekawa/test/browserInput.test.ts)、[browserWait](/Users/miyano/Documents/code/Hanekawa/test/browserWait.test.ts)、[browserSettle](/Users/miyano/Documents/code/Hanekawa/test/browserSettle.test.ts)。 |
| B32 | renderer 崩溃无恢复入口 | 修复不完整 | 恢复状态机和原生对话框已落地；重建销毁最后窗口会进入 Windows/Linux 的 app.quit 逻辑。源码和实际回调模拟确认冲突，未做目标平台 Electron E2E。<br>回归：[desktopRendererRecovery](/Users/miyano/Documents/code/Hanekawa/test/desktopRendererRecovery.test.ts)。 |
| B33 | Dock 重开异常/无 lane 空操作 | 真机待验 | 重开入口去重、捕获异常，等待旧项目关闭并补 draft lane；[窗口重开](/Users/miyano/Documents/code/Hanekawa/src/desktop/main.ts:440)。本机自动化通过，Dock 实际恢复链未执行。<br>回归：[desktopShellHost](/Users/miyano/Documents/code/Hanekawa/test/desktopShellHost.test.ts)。 |
| B34 | second-instance 将安装目录当项目 | 真机待验 | 仅 --cwd= 表示显式项目，普通二次启动聚焦/重开；[启动意图](/Users/miyano/Documents/code/Hanekawa/src/desktop/launchArgs.ts)。Windows 打包快捷方式尚未验收。<br>回归：[desktopLaunchArgs](/Users/miyano/Documents/code/Hanekawa/test/desktopLaunchArgs.test.ts)。 |
| B35 | 活动 pane dispose 残留共享浮层 | 真机待验 | 活动 pane 复用 deactivate，所有等待请求按既有 fallback 结算；后台 pane 不清其他 pane 浮层；[pane 销毁](/Users/miyano/Documents/code/Hanekawa/src/desktop/renderer/paneSession.ts)。DOM 测试通过。<br>回归：[rendererPaneDispose](/Users/miyano/Documents/code/Hanekawa/test/rendererPaneDispose.test.ts)。 |
| B36 | 隐藏子代理页继续全量轮询 | 真机待验 | 显式可见性控制 timer，epoch 丢弃隐藏后的晚到回复；[轮询生命周期](/Users/miyano/Documents/code/Hanekawa/src/desktop/renderer/dom/subagentPanelView.ts)。fake timer/DOM 回归通过。<br>回归：[rendererSubagentPanelView](/Users/miyano/Documents/code/Hanekawa/test/rendererSubagentPanelView.test.ts)。 |
| B37 | 非 Git/无源码基线线程为空 | 通过 | 采用计划中的最小前置检查，要求非空项目先提交源码；不自动 git add 用户文件；[worktree 基线](/Users/miyano/Documents/code/Hanekawa/src/services/coordination/threadWorktree.ts)。这不代表已实现非 Git 项目一键代码线程。<br>回归：[threadWorktree](/Users/miyano/Documents/code/Hanekawa/test/threadWorktree.test.ts)、[coordination.integration](/Users/miyano/Documents/code/Hanekawa/test/coordination.integration.test.ts)。 |
| B38 | 文本压缩 fallback 不可取消、持久重试 | 通过 | signal 传至 provider/retry，改为 interactive 有界策略，提交前检查取消；[文本压缩](/Users/miyano/Documents/code/Hanekawa/src/harness/compact.ts)。<br>回归：[compact](/Users/miyano/Documents/code/Hanekawa/test/compact.test.ts)、[sessionController](/Users/miyano/Documents/code/Hanekawa/test/sessionController.test.ts)、[retry](/Users/miyano/Documents/code/Hanekawa/test/retry.test.ts)。 |
| B39 | 压缩前先裁旧上下文 | 修复不完整 | system/指令/tool schema 已纳入；preload 在实际 build 才加入，未进入压缩判定，补充探针观察到 parent-history 被裁且没有 compact 请求。<br>回归：[loop](/Users/miyano/Documents/code/Hanekawa/test/loop.test.ts)、[contextBuilder](/Users/miyano/Documents/code/Hanekawa/test/contextBuilder.test.ts)、[prompts](/Users/miyano/Documents/code/Hanekawa/test/prompts.test.ts)。 |

### P2（B40–B46）

| 编号 | 问题 | 本轮结论 | 核验说明与回归证据 |
| --- | --- | --- | --- |
| B40 | Glob notice 被画成文件 | 通过 | 只识别空行分隔的完整尾部 notice，放入 truncatedNote；保留普通同前缀文件名；[Glob 解析](/Users/miyano/Documents/code/Hanekawa/src/desktop/renderer/model/searchResults.ts)。<br>回归：[rendererSearchResults](/Users/miyano/Documents/code/Hanekawa/test/rendererSearchResults.test.ts)。 |
| B41 | 行内代码实体字面量被解码 | 通过 | codespan 直接采用 token.text，正文实体解码保持；[行内代码](/Users/miyano/Documents/code/Hanekawa/src/desktop/renderer/model/markdown.ts)。<br>回归：[rendererMarkdown](/Users/miyano/Documents/code/Hanekawa/test/rendererMarkdown.test.ts)、[markdownMath](/Users/miyano/Documents/code/Hanekawa/test/markdownMath.test.ts)。 |
| B42 | 中断回合 token 错挂旧页脚 | 通过 | 实时 token 携带 turnId，仅赋给同一回合 footer；[页脚归属](/Users/miyano/Documents/code/Hanekawa/src/desktop/renderer/model/turnFooter.ts)。<br>回归：[rendererTurnFooter](/Users/miyano/Documents/code/Hanekawa/test/rendererTurnFooter.test.ts)、[rendererTranscriptView](/Users/miyano/Documents/code/Hanekawa/test/rendererTranscriptView.test.ts)。 |
| B43 | stream retry 重复未提交思考 | 通过 | retry 移除当前 liveThinkingId 对应临时条目，保留已提交历史；[流事件模型](/Users/miyano/Documents/code/Hanekawa/src/desktop/renderer/model/transcript.ts)。<br>回归：[rendererTranscriptModel](/Users/miyano/Documents/code/Hanekawa/test/rendererTranscriptModel.test.ts)、[rendererThinking](/Users/miyano/Documents/code/Hanekawa/test/rendererThinking.test.ts)。 |
| B44 | 缺失 cache-write 被显示为零 | 通过 | 仅在字段存在时显示缓存写入，显式 0 仍显示；底层计数未实体化缺失字段；[usage 展示](/Users/miyano/Documents/code/Hanekawa/src/desktop/renderer/model/usage.ts)。<br>回归：[rendererUsage](/Users/miyano/Documents/code/Hanekawa/test/rendererUsage.test.ts)、[usage](/Users/miyano/Documents/code/Hanekawa/test/usage.test.ts)。 |
| B45 | token 跨单位舍入不自然 | 通过 | 999500 起提升到 M，去掉无意义 .0；精确数值保持；[token 格式](/Users/miyano/Documents/code/Hanekawa/src/desktop/renderer/model/usage.ts)。<br>回归：[rendererUsage](/Users/miyano/Documents/code/Hanekawa/test/rendererUsage.test.ts)。 |
| B46 | NotebookEdit 丢 EOL/末尾换行 | 通过 | 接入共用 textFile，按原状态保留 BOM、CRLF、尾换行及 mode，失败保留原文件；[Notebook 写入](/Users/miyano/Documents/code/Hanekawa/src/tools/NotebookEditTool/NotebookEditTool.ts:405)。修复已在 HEAD 内，不能只看未提交 diff 判定缺失。<br>回归：[notebookEdit](/Users/miyano/Documents/code/Hanekawa/test/notebookEdit.test.ts)、[fileToolLineEndings](/Users/miyano/Documents/code/Hanekawa/test/fileToolLineEndings.test.ts)。 |

## 需要继续处理的 5 项

### B29：全局配置仍可能丢失其他项目的修改

- **已修部分：** [repairRecords](/Users/miyano/Documents/code/Hanekawa/src/sessions/service.ts:378) 的读取、修复、重写已在同一 JSONL 锁内；[setLocalPermissionEntries](/Users/miyano/Documents/code/Hanekawa/src/config/settings.ts:450) 也已改成锁内 mutation。
- **残留根因：** [ConfigService.save](/Users/miyano/Documents/code/Hanekawa/src/config/service.ts:321) 虽然锁内重读了磁盘，却删除已读到的 models/endpoints/routing 等已知字段，再写入本实例的完整旧快照。文件锁阻止同时写字节，无法保留另一个实例刚保存的不同字段。[每项目创建 ConfigService](/Users/miyano/Documents/code/Hanekawa/src/runtime/bootstrap.ts:126) 使多实例成为实际产品路径。
- **本轮复现：** 两个 ConfigService 先 load，分别添加 model-a/model-b，再 Promise.all(save)。两个调用都成功，重新 load 只剩 model-b，model-a 丢失。没有使用真实用户配置。
- **修复反馈：** 保存应表达本次修改，并在 owning 配置层锁内应用到最新值，或明确拒绝过期版本；回归须用两个独立实例、两个不同字段，并保留显式删除语义。只把 save 包一层锁不够。
- **证据：** [审计探针](/Users/miyano/Documents/code/Hanekawa/archive/bug-fix-review-20261025-5MMbfj/audit-probes.test.ts) 的 B29 用例；[实际输出](/Users/miyano/Documents/code/Hanekawa/archive/bug-fix-review-20261025-5MMbfj/audit-probes.tap)。

### B31：设备模拟绕过 Browser 的取消和超时入口

- **已修部分：** pageEvaluator/cdpSender 与 wait/settle 的常规路径已使用 withinBounds，现有新增回归全部通过。
- **残留根因：** [applyEmulation](/Users/miyano/Documents/code/Hanekawa/src/desktop/browser/emulation.ts:101)、[restoreEmulation](/Users/miyano/Documents/code/Hanekawa/src/desktop/browser/emulation.ts:122)、resetEmulation 直接 await session.send，未传 signal/deadline。[emulate](/Users/miyano/Documents/code/Hanekawa/src/desktop/browser/host.ts:364) 的取消检查在整组操作之后，[emulatedPage](/Users/miyano/Documents/code/Hanekawa/src/desktop/browser/host.ts:557) 也先等待恢复模拟。
- **本轮复现：** 实际 DesktopBrowserHost（仅 Electron tab 容器替换成 fixture）在第一个 CDP 命令悬挂时执行 Stop，60 ms 后仍 pending；解除第一个命令后，又发出两条模拟命令，最后才返回 OPERATION_ABORTED。60 ms 用于观察取消失效，不是对 15 秒默认超时的计时验收；无 deadline 的结论来自调用链。
- **修复反馈：** 所有模拟和恢复调用统一经过有界、可取消入口；每条后续命令前检查本次操作仍有效，并覆盖 lease 清理。不能只再增加一个外层 Promise.race 后继续后台发送命令。
- **证据：** [审计探针](/Users/miyano/Documents/code/Hanekawa/archive/bug-fix-review-20261025-5MMbfj/audit-probes.test.ts) 的 B31 用例及 [浏览器 host 测试 bundle](/Users/miyano/Documents/code/Hanekawa/archive/bug-fix-review-20261025-5MMbfj/browserHost.audit.mjs)。真实 alert/死循环、调试器断开和下一次操作恢复仍需 Electron 验收。

### B32：恢复窗口会碰到 Windows/Linux 的正常退出逻辑

- **已修部分：** render-process-gone 处理、原生恢复选择、有界重试和专用协调会话恢复入口已落地，纯状态机测试通过。
- **残留根因：** [重建窗口](/Users/miyano/Documents/code/Hanekawa/src/desktop/main.ts:574) 先 destroy 旧窗口；[window-all-closed](/Users/miyano/Documents/code/Hanekawa/src/desktop/main.ts:365) 在非 macOS 下无条件 app.quit，没有识别恢复正在替换最后一个窗口的阶段。RendererRecovery.isRecovering 虽已提供，main 尚未在这个退出入口使用。
- **本轮证据：** 读取 main 中实际注册的 window-all-closed 回调，在 win32/linux 条件下与恢复状态机联合模拟；用户选择恢复时，关闭旧窗口仍触发一次 app.quit。**这是源码和回调模拟证据，不是 Windows/Linux Electron 实测**，最终退出/竞争表现尚待目标平台确认。
- **修复反馈：** 明确恢复替换窗口期间与正常关闭最后窗口的区别；补主进程生命周期集成回归，验证恢复不会进入 quit drain，正常关闭和主动退出仍能完成。之后做目标平台崩溃恢复验收。

### B39：fork 的 preload 仍在压缩判定之外

- **已修部分：** 完整 system、AGENTS/MEMORY 和 tool schema 已统一计入固定开销，普通会话的新增回归通过。
- **残留根因：** [固定开销计算](/Users/miyano/Documents/code/Hanekawa/src/harness/loop.ts:1895) 以 records: [] 计算 system/schema 成本；自动压缩只看自身 prepared records，[构建实际请求](/Users/miyano/Documents/code/Hanekawa/src/harness/loop.ts:1950) 才把 preloadRecords 加入。后续补压缩仅检查 pinned overflow，普通历史被裁不会触发补救。
- **真实入口：** [fork preload 注入](/Users/miyano/Documents/code/Hanekawa/src/tools/AgentTool/AgentTool.ts:548) 在不能继承原请求前缀时会走该路径，默认父历史预载预算为 50000 token；并非仅供测试使用的参数。fork 自身历史增长后会消耗同一个模型窗口。
- **本轮复现：** 20k 窗口，自身旧历史约 12k、parent preload 约 12k，自身未达自动阈值。fake provider 实际收到的请求没有 parent-history；请求次数为 1、没有 compact-request，也未写 compact_boundary。历史已在构建阶段被裁掉。
- **修复反馈：** 在裁剪前按完整实际请求（含 preload/inherited prefix/临时内容与图片口径）判断是否需要压缩；对不能压缩或压缩失败的情况明确报告裁剪。回归要断言实际请求 ID，而不只核对阈值。

### B24：内部数据排除依赖路径拼写，两个后端也不完整一致

- **已修部分：** canonical home 普通宽泛 Grep 已排除项目运行数据和 worktree，普通隐藏源码继续可搜。
- **残留根因：** [relativeInside](/Users/miyano/Documents/code/Hanekawa/src/tools/searchExclusions.ts:34) 只 path.resolve，没有把 home 的软链接解析成真实身份；搜索目标是 home-link 时，真实 runtime 根不再被判为其子目录。[Glob fallback](/Users/miyano/Documents/code/Hanekawa/src/tools/GlobTool/GlobTool.ts:134) 也没有使用 rg 路径的 runtimeDataExclusions。
- **本轮复现：** 同一隔离 home，直接 Grep 不返回 private.jsonl；从指向 home 的软链接搜索，rg 和 fallback 都返回内部 sessions/private.jsonl。另以 .myagent/**/* 比较 Glob，rg 只返回项目配置，fallback 同时返回内部 session 文件。
- **修复反馈：** 用现有 canonical path helper 统一根目录身份，并让两种后端采用相同的相对排除规则；仍要保留显式内部目录读取及正常项目配置查询的权限边界。

## 另需补足的 2 项证据

### B13：POSIX 已验证，Windows 不能据此结案

[hooks](/Users/miyano/Documents/code/Hanekawa/test/hooks.test.ts) 的真实后代进程超时/取消用例在本机运行通过，但 [该用例](/Users/miyano/Documents/code/Hanekawa/test/hooks.test.ts:8) 明确 skip win32。[Windows 分支](/Users/miyano/Documents/code/Hanekawa/src/tools/processTree.ts:8) 在 shell 已退出时直接 return；这正是“父进程退出但孙进程仍占管道”的原触发条件之一。后续销毁本调用的管道可以结束等待，却不能证明后代已被终止。

反馈：保留本机通过结论，Windows 的进程树清理标为未完成验收；补真实 shell/child/grandchild、父先退出和 TERM/强杀路径证据。没有在本轮伪称 Windows 已复现或已通过。

### B28：模型字符串相等，尚不能覆盖同名 endpoint 的来源变化

[eligibleThinkingBlocks](/Users/miyano/Documents/code/Hanekawa/src/config/providers/anthropicPayload.ts:120) 已可靠过滤不同/未知 message.model；[新增最终 payload 回归](/Users/miyano/Documents/code/Hanekawa/test/config.test.ts:1196) 验证同模型、跨模型、未知来源及文本/工具配对。这部分修复成立。

但实现只比较 message.model 与 request.model。计划明确要求检查的“相同模型标识换底层 endpoint/兼容服务”等情形，目前没有能证明来源的 endpoint 信息或对应最终 payload 回归。现有名称相等测试不足以证明该分支安全；本轮没有向真实服务请求并验证 400。建议把该条描述收窄为“模型 ID 变化路径已修”，在补足来源与配置变化证据后再整条结案。

## 真机验收清单

以下不因自动化全绿而自动关闭。B31/B32 应先处理上述残留，再做真机验收。

| 条目 | 验收场景 | 完成标准 |
| --- | --- | --- |
| B31 | Electron 真实 alert、长脚本、页面销毁、CDP 断开；设备模拟中 Stop | 工具及时结算，取消后不发后续动作，能恢复下一次操作；不把结束等待描述为脚本已被终止。 |
| B32 | Windows/Linux/macOS 强制 renderer 崩溃后选择恢复；恢复再失败 | 有恢复入口，无意外 quit/死循环；已持久化会话可重新打开并继续，无重复 lane、悬挂权限请求。 |
| B33 | macOS 最后窗口关闭后点 Dock；项目仍在关闭；连续 activate；bootstrap 失败 | 恰好一个可操作窗口，按现有规则新建 draft，异常可见且可重试，无未处理拒绝。 |
| B34 | Windows 安装产物快捷方式二次启动；有/无合法 --cwd= | 无显式项目只聚焦/正常重开，不把安装目录登记进项目列表；显式目录正常打开。 |
| B35 | 真实窗口关闭最后活动 pane，分别带 rewind/权限请求；再关闭后台 pane | 共享浮层和等待请求均结算；其他活动 pane 的浮层、焦点不被误清。 |
| B36 | 子代理页隐藏数秒、在途回复晚到、反复切换/恢复/关闭 | 隐藏后无新增 transcript 轮询，晚到回复不重绘，恢复及时刷新且无重复 timer。 |
| B07/B08/B13 | Finder/Dock 启动 PATH；各目标 OS 退出重入；Windows hook 进程树 | 在真实启动/退出环境验证工具解析和资源清理；本机 Node 回归不能代替安装产物验收。 |

## 发布准备 R01–R04 的现状

这 4 项独立于 46 条 bug；本轮只核对，没有安装打包器、改依赖或申请凭证。

| 条目 | 当前核验 | 反馈 |
| --- | --- | --- |
| R01 安装器/身份 | package.json 仍无完整 productName/appId/build 分发配置。 | 待产品决策及实施；desktop build 成功不能等同可安装发布。 |
| R02 sharp | 本机 Node 实跑 sharp 0.35.4，成功解码 64×64 PNG。 | 仅证明本机 Node；Electron runtime、实际安装产物及其他目标架构仍待验证。 |
| R03 latest | 仍有 6 个 runtime、2 个 dev 依赖声明 latest；lockfile 存在。 | 版本声明尚未收敛；保留 npm ci 可复现基础，不将 latest 等同每次 CI 必然升级。 |
| R04 dist/React | 本轮 build 后旧 dist/tui/** 仍存在；react/@types/react 仍在声明，src/scripts 未找到其直接 import/require。 | 旧输出清理未落实；移除依赖前仍需核对动态/类型引用，不能仅凭字符串搜索删除。 |

## 对原计划及后续修复的反馈

1. 建议将 BUG_SCAN_PLAN.md 的总述从“P0/P1/P2 均已修复完成”改为“修复已落地，本轮核验仍有残留与验收项”；保留原扫描、当前修复和目标平台验收的不同证据等级。本轮没有改写这份原计划。
2. B28 的新增核心回归路径应指向 test/config.test.ts；B39 的 loop 实际请求回归也应列入，不能只列 contextBuilder/usage。
3. 优先处理 B29 数据覆盖，其次 B31 取消后的动作和 B32 平台退出冲突，再补 B39、B24；B13 Windows 与 B28 来源证明应同时安排补验。此顺序是修复反馈，不表示本轮已获得或执行代码变更。
4. 把本轮探针迁入正式回归时，改为断言正确行为并证明修复前失败；当前探针有意断言残留问题存在，其“通过”不应贴到修复完成记录上。
5. 修复后重跑对应定向回归；共享路径完成后再做 typecheck、全套测试、desktop build 和以上平台验收。当前未提交源码和新增文件需随修复一并管理，不能只保留已跟踪 diff。


## 交付与留存

本报告：[BUG_FIX_FEEDBACK.md](/Users/miyano/Documents/code/Hanekawa/BUG_FIX_FEEDBACK.md)。全部证据位于 /Users/miyano/Documents/code/Hanekawa/archive/bug-fix-review-20261025-5MMbfj/（archive/ 为仓库既有忽略目录）。探针 bundle 只用于隔离核验，不属于产品实现；重建方式见 [证据说明](/Users/miyano/Documents/code/Hanekawa/archive/bug-fix-review-20261025-5MMbfj/README.md)。正式测试和审计探针都通过项目 npm test runner 执行，以继承临时 HOME/清理机制。

## 反馈后的补修记录（2026-10-25）

按用户要求处理上述 5 项残留及 2 项证据缺口，实机验收交由用户执行；R01–R04 不在本轮范围。B28 来源字段与 B13 Windows Job Object 方案已获得用户确认。

| 条目 | 本次实现与正式回归 |
| --- | --- |
| B29 | ConfigService 在文件锁内比较上次读取的磁盘快照，拒绝过期保存，保留显式删除与未知字段；两个独立实例竞争及删除防复活回归通过。 |
| B31 | 模拟、替换、恢复和重置的每次 CDP 调用均受取消/超时约束，后续命令检查操作所有权，失败释放 lease；实际 DesktopBrowserHost 配合假 tab/CDP 的回归通过。 |
| B32 | 恢复替换最后窗口期间不触发普通关窗退出；主动退出优先。读取 main 实际事件回调与恢复/退出协调器联合验证通过，未声称 Windows/Linux Electron 实测。 |
| B39 | 裁剪前计算完整请求，包括 preload、inherited prefix、临时内容、图片与工具定义；需要时补一次压缩，紧接着的请求携带新边界。失败裁剪会提示，最新真实指令始终保留，容量不足则报错；实际请求 ID、图片口径和失败提示回归通过。 |
| B24 | 使用现有 canonical path helper 统一搜索根身份，Glob/Grep 的 rg 与 fallback 共用运行数据排除；home 软链接、正常源码/配置及显式内部目录权限回归通过。 |
| B28 | 新回复持久化可选 thinkingSource 来源哈希，最终 payload 仅对相同模型/服务地址重放签名；API Key 轮换不改变来源。旧文件不改写，未知来源只省略签名；正文、工具配对、重载及最终请求回归通过。 |
| B13 | Windows 新增系统 PowerShell Job Object supervisor，命令创建前纳入 Job，覆盖父先退出后的整树清理，无新增 npm 依赖。POSIX 的超时、取消、父先退出、忽略 TERM 后强杀回归在本机通过；Windows 整树清理及 I/O/退出码专用测试已加入，待目标机运行。 |

验证环境：macOS / darwin、arm64、Node v24.21.0；HEAD 仍为 66427fc25566d6ff41b8f5579e2d0d0a4f310c49，结果针对当前未提交工作树。

| 检查 | 本次结果 | 证据 |
| --- | --- | --- |
| 定向回归 | 491 项，489 通过，2 跳过，0 失败 | [focused-tests.tap](/Users/miyano/Documents/code/Hanekawa/archive/bug-fix-followup-20261025-b4YqJk/focused-tests.tap) |
| 全套测试 | 4338 项，4336 通过，2 跳过，0 失败、0 取消，36 suites | [full-tests.tap](/Users/miyano/Documents/code/Hanekawa/archive/bug-fix-followup-20261025-b4YqJk/full-tests.tap) |
| npm run typecheck | base / preload / renderer / domtest 均通过 | [typecheck.log](/Users/miyano/Documents/code/Hanekawa/archive/bug-fix-followup-20261025-b4YqJk/typecheck.log) |
| npm run build:desktop | 通过 | [build-desktop.log](/Users/miyano/Documents/code/Hanekawa/archive/bug-fix-followup-20261025-b4YqJk/build-desktop.log) |
| git diff --check | 通过 | [证据说明](/Users/miyano/Documents/code/Hanekawa/archive/bug-fix-followup-20261025-b4YqJk/README.md) |

两项跳过均为 Windows hook 专用回归；执行命令为 `npm test -- test/hooks.test.ts`。B31–B36、Windows hook 及其他既定平台验收仍按上方清单由用户执行。本次没有打开真实 Electron 窗口、发送真实模型请求或使用真实聊天数据作为测试 fixture，没有提交或推送代码。
