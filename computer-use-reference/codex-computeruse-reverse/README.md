# Codex Computer Use 本机逆向与复现资料

采样日期：2026-11-04，Asia/Shanghai。分析对象为本机 `/Applications/ChatGPT.app` 中的 Codex 桌面运行时。

建议先读 [技术文档](技术文档.md)，再按 [核心代码导读](核心代码导读.md) 阅读代码。

| 文件 | 用途 |
| --- | --- |
| [技术文档.md](技术文档.md) | 架构、调用链、IPC 协议、AX 与截图、权限、实测及复现路线 |
| [核心代码导读.md](核心代码导读.md) | 按功能定位真实核心代码，并提供简化后的解释片段 |
| [core/readable](core/readable/) | 18 个从安装包提取、格式化并按作用域改名的阅读版；约 1,900 行 |
| [core/formatted](core/formatted/) | 同一批模块，仅格式化，保留混淆变量名 |
| [core/browser-excerpts.txt](core/browser-excerpts.txt) | 浏览器 AX、CDP、多 Frame、WASM 与分帧的真实代码片段 |
| [core/host-excerpts.txt](core/host-excerpts.txt) | ASAR 中的原生服务托管与 socket peer 授权核心代码 |
| [evidence.json](evidence.json) | 原文件路径、SHA-256、代码映射及浏览器原文件字节定位 |
| [local-inspection.json](local-inspection.json) | 宿主/原生服务版本、原生符号和 ASAR 定位证据 |
| [source-validation.json](source-validation.json) | 18 个格式化版本的 AST 一致性检查和阅读版解析检查 |
| [reproduction-tests.mjs](reproduction-tests.mjs) | 使用安装包原版 JS、内存模拟 socket 的协议及权限包装测试 |
| [test-results.json](test-results.json) | 本机执行上述测试的结果与实际生成的请求示例 |
| [syntax-validation.json](syntax-validation.json) | 36 个提取 JS 文件的语法检查 |
| [dynamic-experiment.md](dynamic-experiment.md) | 本次正式 CUA 计算器实验的调用和关键观察记录 |
| [mac-ax-bridge.swift](mac-ax-bridge.swift) | 独立编写的 macOS 公共 API 最小原型；支持 AX 观察、AXPress、设值、窗口截图 |
| [native-prototype-validation.json](native-prototype-validation.json) | Swift 原型输入校验自检结果；本机另已编译通过 |
| [inspect-local.py](inspect-local.py) | 可重新执行的只读版本/哈希/符号/ASAR 采集脚本 |
| [extract-core.cjs](extract-core.cjs) | 可重新执行的 AST 提取、格式化、作用域改名和校验脚本 |

## 快速复验

在此目录运行：

```sh
node reproduction-tests.mjs
python3 inspect-local.py --out fresh-local-inspection.json
node extract-core.cjs ./regenerated
```

前两个脚本不会操作桌面。提取脚本只读取安装文件，并在当前目录的 `work/` 写入格式化工具的临时副本，在指定目录写结果。无需联网或安装依赖；它使用本机随应用附带的 Playwright/Babel。脚本中的应用路径和采样版本对应本次安装，更新或迁移后应检查路径。提取代码的原相对 import 没有重排，因此提取副本用于阅读；测试脚本直接导入安装目录中的原版模块。

## 独立原型

```sh
mkdir -p build/module-cache
swiftc -parse-as-library -module-cache-path build/module-cache mac-ax-bridge.swift -o build/mac-ax-bridge
build/mac-ax-bridge --self-test
build/mac-ax-bridge com.apple.calculator ./captures
```

最后一条进入串行 JSONL 服务。目标应用需先运行，并由操作者正常授予该原型所需的 macOS 权限。输入 `{"id":1,"method":"observe"}` 获得元素和 revision；再用刚刚返回的 revision 与 index 发送 `press` 或 `setValue`。截图命令是 `{"id":2,"method":"screenshot"}`。每次动作后重新观察。原型没有模型连接、Codex 宿主认证、后台坐标事件注入、锁屏操作或生产级授权界面，具体范围见技术文档。

代码提取材料来源于本机专有软件，仅作为本次分析资料；原型和测试文件已明确区分来源。
