# Computer Use 本轮收尾记录（2026-11-05）

按用户要求停止继续开发，当前改动提交用于后续接续。M0 / CU-004 保持部分完成；访达消歧、完整产品与安装包验收尚未完成。详细数值、成功和失败记录见 [结构化证据](CU-PROGRESS-2026-11-05.json)，当前状态见 [实施计划](COMPUTER_USE_MACOS_PLAN.md)。

当前 checkout 缺少历史计划所引用的部分早期实施/验证文档；本日证据独立保存，不依赖这些缺失文件。历史缺失引用清单见 JSON。

## 已完成的本批改进

- 分离应用发现元数据和进程身份。绑定要求稳定的 PID、内核出生秒/微秒及真实可执行路径；每个原有检查点继续校验。AppKit 注册暂缺只有在精确身份一致时复用绑定对象；身份读取失败、终止或变化会撤销绑定，后续良好采样不能复活旧引用。
- 修复依据来自用户不操作键鼠期间的真实复现：AppKit 查询为空，内核出生身份和可执行目标仍与绑定一致。修复前连续三轮为通过、失败、通过；没有自动重发已送达的输入。
- 连续坐标点击使用生产事件对派发函数，每对前校验目标。部分派发后再失败报告 `unknown`，零次派发前可报告 `not_delivered`；鼠标 down/up 之间没有可失败步骤。无 GUI 注入测试直接覆盖该生产函数。
- 自有 fixture 默认紧凑列表，独立保留 80 行截断场景。完整 full/diff 还原、插入/重排/同名控件替换、旧引用拒绝和截断后的基线恢复均为强制断言，不能跳过。无变化 diff 的引用使用还原索引及当次快照前缀。
- 增加仅含数字、匹配标记和不透明标识的失败诊断；不另存正文、安全字段、可执行路径或 AX 全文。事件字符属性只在 keyDown/keyUp 读取；flagsChanged 仅记录合法数值。
- 访达 harness 分别检查 label/value，共享原 3000ms 只读等待预算；再从可见唯一目标读取完整子树、独立核对磁盘。不扩大产品输出预算，不把截断窗口当成完整窗口，也不改变生产 matcher 的同节点 AND 语义。

## 实际验证结果

| 检查 | 结果与边界 |
| --- | --- |
| 修复后自有 AppKit 原生闭环 | 同一 helper 连续 3/3 通过，每轮 25 项阶段检查；包含 full/diff、Unicode、快捷键、菜单/sheet、截图坐标、取消和重启 |
| 计算器 | 3/3；AX 为 46，三张 PNG 均已目视确认 `12+34=46`，保留 [一张当前图片](validation-assets/calculator-46-2026-11-05.png) |
| 文本编辑 | 3/3；中英文、emoji、组合字符和换行保存到专用目录后重开核对 |
| 访达最终版本 | 第一轮通过；第二轮出现同名 AXTextField 与 AXStaticText 两候选，按安全条件拒绝；第三轮未执行。窗口、进程占用和临时资料已清理 |
| 核心窄回归 | 98/98，通过真实无 GUI 退出/重启、同 PID exec 变化拒绝及鼠标部分投递检查 |
| 访达及相关回归 | 31/31 和 19/19，未将重叠测试相加为新的总数 |
| 类型检查、桌面构建、脚本语法与差异检查 | 通过；后续 harness 改动未改变 helper |
| 最终全量 | 4,888 项：4,883 通过、3 失败、2 跳过、0 取消；没有全绿结论 |

全量失败为：既有 `rendererOverlayView` 固定定位集合断言、`coordination.integration` 自动唤醒超时，以及本次全量中新出现的 Computer 延迟条件稳定等待时序失败（`timed_out` 而非 `settled`）。后两项单独复验各 1/1 通过；保留全量与单独运行的差异，不将其抹为通过。renderer 样式和相应测试相对 HEAD 未变；没有修改无关 renderer。

此前曾出现 Cmd+A 选区超时和截图坐标计数校验失败；后续三轮完整原生测试通过，但没有证明这些表现与 AppKit 注册缺失同根因。新增采样器的 `/private` 路径别名问题属于诊断夹具问题，已修正。一次构建期间缺 helper 的误跑属于验收环境失败。

辅助功能与屏幕录制已由用户正常授权，正式 Electron → 生产 Host → helper 均检测为 true。早期未授权状态仅为历史经过。本批不代表完整 Hanekawa/安装包权限三态、自然语言模型任务、签名公证或其他系统/架构/显示器矩阵已经通过。

## 基线、复跑与清理

基点 `af085b1243f3bcad5239af27058c192505b94529`，分支 `codex/rebuild-computer-use`；macOS 27.2 / arm64，Node v24.22.2，Electron 45.2.1，Swift 6.4.2。原生协议仍为 `hanekawa-computer/4`，最终 helper SHA-256：`d4acf532f645442d5c019796e14422ce6e9a47f2c061097474ccb7b421171271`；源码哈希见 JSON。

```bash
npm run typecheck
npm run build:desktop
npm test
npm test -- test/computerFinderNameWait.test.ts test/computerWait.test.ts
npm run test:computer:native
npm run test:computer:apps -- --scenario=calculator --repetitions=3
npm run test:computer:apps -- --scenario=textedit --repetitions=3
npm run test:computer:apps -- --scenario=finder --repetitions=3
```

GUI 复跑只使用专用新建资料，并需避免人工键鼠输入干扰；访达当前有已知候选歧义，不能预期三轮均通过。

保留本报告、数值 JSON、一张计算器 PNG、可重跑脚本与测试。清理本轮临时探针、编译缓存、原始日志、任务提示词和重复图片；构建产物与依赖保留，不删除 CLI 配置/模型/独立会话数据。已有 `pelican-bike.html` 删除与本批无关，保留且不纳入提交。
