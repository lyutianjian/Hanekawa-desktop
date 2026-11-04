# 自有 AppKit 原生闭环、权限归属与故障修复

日期：2026-11-04，Asia/Taipei。分支 `codex/rebuild-computer-use`，起始 HEAD `9feebcad428ae680cf6028c1e1e2de7a774033aa`。开始时已有大量 Computer 相关未提交实现，本批在其上继续修改，没有回滚或提交这些内容。

结构化证据：[全部尝试与最终结果](CU-NATIVE-CLOSURE-2026-11-04.json)。记录包含五次失败的阶段、错误、构建哈希和最终完整通过结果；不保存截图、输入正文或用户剪贴板。

## 环境与权限

- Apple Silicon arm64，macOS 27.2，Node 24.21.0，Electron 45.2.1，Swift 6.4.2。
- 原生协议保持 `hanekawa-computer/3`。
- 初次正式 Electron → ComputerHost → helper 检查为 Accessibility=false、Screen Recording=true。
- 用户确认 Electron 开关已开启后，helper 仍返回 false。只读系统 TCC 日志明确记录 responsible identifier 为 `com.openai.codex`、路径为 `/Applications/ChatGPT.app`。用户正常开启该宿主权限后，新进程的正式 helper 返回两项权限均为 true。没有修改 TCC 数据库或权限绕过。
- 此结论只适用于本次由 Codex 启动的开发链路，不代表安装包、终端启动或其他机器的权限归属相同。完整 Hanekawa 与安装包三态验收仍未完成。

## 本批修复

### 1. 权限失效不再遗留绑定和应用占用（CU-303）

原宿主遇到 `PERMISSION_REQUIRED` 时只清快照，仍保留 helper 和应用租约，后续排队请求还会送到旧 helper。新增回归先在原实现复现，再将权限失效纳入统一回收路径。观察、截图、组合读取及动作前失败均回收绑定，拒绝排队中的旧绑定调用；其他会话可显式重新绑定。动作确认之后的观察失败继续保留 `delivered_unverified`，不重发动作。

证据为协议模拟，不是实际撤销系统权限实验。真实首次授权的恢复检查见上节。

### 2. 长列表不会优先耗尽全部文本输出预算（CU-103）

真实 fixture 在替换按钮后，将新按钮放在长列表之后。原先按深度优先顺序消耗文本预算，导致新按钮没有出现在模型输出中。现在先按深度分配 28,000 字符预算，保留浅层控件和各分支入口，再按原遍历顺序输出，保留原索引；提示明确说明后代可能在行间省略。换行和截断提示也计入预算。

新增纯模型回归复现长列表后的按钮丢失；修复后真实 fixture 的插入、重排、控件替换和新按钮点击通过。截断仍为不完整观察，不作为差分基线，也没有承诺每个节点都能在一份输出中显示。

### 3. 动作通信超时与读取超时分开（CU-101 / CU-202）

原遍历给 AX 元素设置的 250ms 通信超时被动作沿用。真实 AppKit sheet 关闭时 AXPress 返回 `-25204 / cannotComplete`，宿主正确保留了 unknown，测试停止，没有重发。动作前将目标元素的通信超时设为 1 秒后，sheet 关闭和完整菜单链路通过；读取仍使用原有短超时，总体仍受宿主 deadline 和取消约束。这不是动作后的固定等待，也没有增加自动重试。

### 4. 初始化 AppKit，修复首次截图崩溃（CU-104）

真实调用在 `SCContentFilter(desktopIndependentWindow:)` 中 SIGABRT。对应 crash report 为 `hanekawa-computer-2026-11-04-224856.ips`，栈包含 `SLSGetDisplaysWithRect → SCContentFilter → AppSession.screenshot`。

独立最小程序只枚举窗口并创建过滤器，不实际截图：未初始化 AppKit 时以 134 退出，stderr 为 `Assertion failed: (did_initialize), function CGS_REQUIRE_INIT, file CGInitialization.c, line 44.`；在首次调用前加入 `NSApplication.shared` 后正常退出。生产 helper 据此初始化 AppKit，并设置 `.prohibited`，不创建窗口或主动激活。无 GUI 自检分支在这之前退出。

最终生产路径中 AX+PNG 组合观察、独立 revision/时间和窗口来源、像素到点换算后的实际点击均通过。没有使用 Codex 专有服务或二进制。

### 5. 构建先验证再发布 helper（CU-401）

Swift 在目标目录内的独立暂存目录编译，设置执行权限并运行 `--self-test` 后才重命名为正式产物；编译、自检退出、输出损坏或断言失败时清除旧资源和半成品。编译和自检分别有 120 秒、30 秒限制。新增故障注入测试覆盖成功路径及五类失败，正式桌面构建和实际原生运行另行通过。

未完成干净 checkout 安装、安装包资源验收、签名和公证，CU-401 不整体完成。

## 自有 GUI 测试的修正与结果（CU-003）

测试应用补上标准 Edit → Select All 菜单，使用正常 AppKit responder chain 验证 cmd+a。测试驱动重新绑定后重新取得 A/B 窗口句柄，避免把上一个绑定的 w1/w2 用在新绑定上；实测重绑前 A=w2/B=w1，重绑后 A=w1/B=w2。两项均为测试设施修正，不是产品自动修复窗口身份的承诺。

最终 `npm run test:computer:native` 退出 0，一次完整真实闭环通过：

- 双窗口发现、显式选择、旧引用拒绝、安全字段脱敏。
- 中文、英文、emoji、组合字符和换行的 AXValue 与真实键盘输入；按文本选择、上下文消歧、局部替换、cmd+a 和实际焦点拒绝。
- 长 emoji 字段读回、列表插入/重排、控件替换和后续按钮点击。
- 延迟条件 matched、永久不满足 timed_out、异步 sheet。
- 应用菜单 → sheet → 输入 → 明确确认，仅修改指定窗口。
- 组合 AX/截图、点/像素坐标换算后的点击，仅修改指定窗口。
- 执行中取消、旧绑定失效、应用重启后拒绝旧绑定及显式重新绑定。
- 测试应用进程回收、helper disposal 以及临时目录清理。

仍保留 unverified：初始窗口的文本输出受预算截断，原生完整差分基线断言跳过；不能将协议差分测试解释成真实完整差分已通过。最终报告包含该标记，退出 0 没有将它删掉。

CU-003 自有测试设施及完整动作分支完成。一次最终闭环不等于 CU-004 第一组真实业务应用、重复次数或 M0 里程碑完成；计算器、文本编辑、访达尚未在本批验收。

## 其他验证

| 命令 / 检查 | 结果 |
| --- | --- |
| 原始权限撤销回归 | 修复前失败，修复后 6 项通过 |
| Computer / 权限 / 构建定向回归 | 108 项通过；随后新增截断回归，相关 Host + Observation 60 项通过 |
| `npm run typecheck` | 通过 |
| `npm run build:desktop` | 最终构建通过，自动运行原生无 GUI 自检 |
| `npm test`（正常权限环境） | 4,826 项：4,823 通过、2 跳过、1 失败 |
| 未修改 HEAD 的遮罩测试 | 同一 `.session-drag-preview` 固定定位断言失败，已用临时 HEAD 快照复现 |
| `verify:computer:electron -- --verify-lifecycle` | 最终 helper 双权限 true；注入锁屏/休眠事件的接线通过，没有实际锁屏或休眠 |
| `git diff --check` / 脚本语法检查 | 通过 |

最初沙箱内全量测试还出现回环端口 `listen EPERM`；已在正常环境重新执行，不将沙箱限制算为代码回归。遮罩失败未在本批修改。

## 参考与剩余范围

只读参考本目录 Codex 阅读材料 C08（传输断线/关闭）及 C10（权限、用户接管、锁屏等错误类别）。采用的是错误与连接生命周期分离、失败后不盲目重发的原则；生产修复独立实现。本批没有新增本机 Codex 二进制采样，也没有推导其未恢复的原生截图或后台输入实现。

M0 仍未完成。后续优先执行 CU-004 的三个真实应用基准，再验证完整差分、实际用户接管、Electron 控件和安装包权限/签名；后台输入、持久 JS、应用启动、纯文本粘贴和拖动没有在本批开放。
