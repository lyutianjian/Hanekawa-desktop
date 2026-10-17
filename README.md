# Hanekawa / MyAgent

Hanekawa（包名 `myagent`）是一个轻量的自托管编程 agent，带 Electron 桌面应用。支持 Anthropic 与 OpenAI 兼容 API、会话持久化、自动上下文压缩、技能（skills）、子代理、MCP、钩子（hooks）、按权限放行的工具、图片输入、项目调度和内置浏览器。

## 环境要求

- Node.js 22 及以上
- npm
- 使用模型需要一个 Anthropic 或 OpenAI 兼容的 API Key；启动和配置本身不需要

## 安装与启动

```bash
npm install
npm run build:desktop
npm run start:desktop
```

`build:desktop` 用 `tsc` 编译主进程，用 esbuild 打包 preload 和渲染进程，再把渲染进程资源复制到 `dist/`。`start:desktop` 让 Electron 运行这份 `dist/`，所以改了源码要重新构建。

## 配置

### 模型与服务商

没有可用的默认模型时，应用启动后会自动打开 **模型与服务商** 配置页，并弹出添加服务商的窗口。可以先关掉它浏览会话和历史，之后从 **配置模型** 入口重新打开。

配置页只列服务商（名称、协议、模型数）。点「添加服务商」先选一个预设，再在同一个窗口里填名称、API 协议、API Key、Base URL，并在下方的模型表格里添加模型：「获取模型列表」从服务商拉取可选模型，勾选即加入表格，也可以「添加模型」手动填写模型 ID。新服务商至少要有一个模型。展开模型行可以设置「支持扩展思考」「支持图片输入」、上下文长度、最大输出 Token、每个思考档位是否支持，以及可折叠的「价格」。显示名就是模型在配置里的键名，不填时用模型 ID；与别的服务商下的模型同名时需要填一个不同的显示名。改服务商名或显示名会同步更新引用它的路由。一次「保存」提交整个窗口的改动。

默认模型在「路由」卡顶部选择；未选默认模型时，第一个保存成功、可解析的模型会成为默认模型。手写配置里没有归属到已配置服务商的模型，列在「未归属服务商的模型」一行里，只能编辑模型本身。配置无需重启即可生效：所有已打开的项目都会收到全局服务商变更，正在运行的回合结束后才替换运行时。删掉最后一个模型会让应用回到待配置状态。配置完成前尝试发送的消息会保留草稿和附件。

应用会创建并保存 `~/.myagent/config.json`，所有项目共用。缺少模型、模型引用失效或服务商配置不完整时，配置入口始终可用。启动时不测试网络连通性或远端鉴权，请求出错会在使用模型时报告。

也可以手动编辑 `~/.myagent/config.json`：

```json
{
  "models": {
    "claude": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-20250514",
      "apiKey": "sk-ant-..."
    },
    "openai-compatible": {
      "provider": "openai",
      "model": "deepseek-chat",
      "apiKey": "sk-...",
      "baseUrl": "https://api.deepseek.com/v1"
    }
  },
  "defaultModel": "claude",
  "fallbackModel": "openai-compatible",
  "agent": {
    "system": "You are Hanekawa, a desktop programming assistant."
  }
}
```

`provider` 有三种：`anthropic`（Anthropic Messages）、`openai`（OpenAI Chat Completions，各家兼容服务通用）和 `openai-responses`（OpenAI Responses，OpenAI 官方推荐；GPT-6 Astra、GPT-6.1 Sol 只能在 Responses 下调用工具）。

`config.json` 只有全局一份。旧版项目里的 `.myagent/config.json` 会在首次加载时迁入全局配置并归档。

### 设置文件的层级

权限、MCP、钩子、技能开关等设置分三层，按顺序合并：

| 层 | 位置 | 说明 |
|---|---|---|
| 用户 | `~/.myagent/settings.json` | 对所有项目生效 |
| 项目 | `<项目>/.myagent/settings.json` | 随仓库共享；其中的 `permissions.mode` 和 `mcp.trustedServers` 会被忽略并给出提示 |
| 本地 | `~/.myagent/projects/<key>/settings.local.json` | 个人的每项目设置，不放在项目目录里 |

权限规则、钩子等按层拼接，MCP 信任取并集；`skills.disabled` 例外，按层整体替换。

项目里的 `.myagent/` 只存放你手动放进去的共享配置（设置、技能、agent 定义、规则、MCP）。会话及其他运行时数据（溢出的工具输出、图片附件、计划文件）以及个人的每项目设置（`settings.local.json`、`agents.local/`）都在 `~/.myagent/projects/<key>/` 下，`<key>` 由项目路径推导，所以应用自己写的东西永远不会出现在项目里。重命名或移动项目会得到新 key 和空历史，旧历史留在旧 key 下。如果旧版本把会话或本地设置留在了项目的 `.myagent/` 里，下次打开时会被迁走：每个文件先复制、校验，再删除原件；清空的 `.myagent/` 会被删除；搬不走的保持原样，并在启动时警告。

### 指令文件

Hanekawa 每次请求都会把指令文件放在对话开头的一条 `<system-reminder>` 里（和记忆索引在一起），而不是系统提示：仓库里的指令文件是用户层面的内容，不该拿到 harness 规则的权威。

1. `~/.myagent/AGENTS.md`：你对所有项目的个人指令，可在设置的「个性化 › 自定义指令」里编辑。系统提示总会写明这个文件的位置（为空时也写），你让模型改它时，它可以直接改：主对话中，在 `default`、`auto`、`bypass` 模式下读、写、编辑这个文件都不弹询问；plan 模式和只读模式照常拒绝，删除照常询问，子代理照常走权限判定；这个文件本身是符号链接时不豁免。deny 规则照样生效，ask 规则照样询问（`bypass` 除外）。
2. 从工作目录向上走到文件系统根目录，每一级取 `CLAUDE.md`，没有时用 `AGENTS.md`。

每一级目录只取两个指令文件中的**一个**：同时维护 `AGENTS.md` 和 `CLAUDE.md` 的仓库，否则每次请求都会重复发送同一份指南。文件按从外到内读取，越近的越靠后、优先级越高。

这些文件在项目打开时读一次，会话运行时构建时固定下来，和钩子一样。会话中途修改它们，会在下次重新加载设置时生效——在设置页保存任意内容就会触发一次，指令变了就重建运行时。例外是 `~/.myagent/AGENTS.md`：每个会话开始时（新会话、`/clear`、`/resume`）各读一次，所以无论是模型改的、在「自定义指令」里保存的还是你在编辑器里改的，下一个新会话就能看到；已打开的会话保持开始时那一份，重新加载设置也不变。

### 自动记忆

模型可以记下跨会话保留的笔记：你的纠正和偏好、代码里看不出的项目背景、外部资料的位置。它们是普通 Markdown 文件，存放在 `~/.myagent/projects/<key>/memory/`（每个工作目录一份，主目录单独一份），每个文件带一小段 frontmatter，另有索引 `MEMORY.md`，每条笔记一行。可以用任何编辑器打开或修改，也可以让模型忘掉某条。

- **加载**：会话运行时首次构建时读取索引，放进对话开头那条指令 `<system-reminder>`（记忆的用法说明在系统提示里）；`/clear` 和 `/resume` 会重新读取，切换模型或重载设置不会。会话中途写下的笔记在下一个会话可见。索引截断在 200 行或 25,000 字节。
- **审批**：主对话中，直接读写、删除记忆目录里的 `*.md` 在任何权限模式下（包括 plan）都不弹询问。deny 规则照样生效，ask 规则照样询问（`bypass` 除外）。该目录也算工作区，所以对它执行只读 shell 命令（`ls`、`cat`、`grep`）无需询问；在里面写入或删除的 shell 命令照常询问。
- **开关**：设置里写 `"autoMemory": false`，之后打开的会话就不再启用：没有提示段、没有审批豁免、不创建目录。已有笔记保留。
- **不覆盖的范围**：子代理既看不到也不使用记忆；记忆文件不参与 `/rewind`。在桌面端移除项目会连同其他数据一起删除它的记忆。

### 路由

`routing` 把特定角色交给特定模型。每个值是 `models` 中的 key，或 `"inherit"`（跟随主循环的模型）：

```json
{
  "routing": {
    "main": "inherit",
    "plan": "claude",
    "compact": "openai-compatible",
    "subagent": {
      "general": "inherit",
      "explore": "openai-compatible"
    }
  }
}
```

没有单独配置的 `subagent` 类型回落到 `subagent.general`，再回落到 `inherit`。所有项默认 `inherit`，所以单模型配置完全不需要 `routing`。

> **不兼容变更。** `fast` / `balanced` / `powerful` 档位以及把它们映射到模型的 `profiles` 层已经删除，`routing` 直接写模型 key。仍在使用旧写法的配置可以正常启动并打印警告：写成档位的 `routing` 项按 `"inherit"` 处理，`defaultModel` 写成档位时回落到第一个可解析的模型。随档位一起消失的还有两个行为——plan 模式不再自动升级模型，压缩不再自动降级模型。需要的话用 `routing.plan` / `routing.compact`（或独立的 `compactModel`）设回来。

### 扩展思考

扩展思考默认开启：请求携带服务商的自适应思考配置，`/effort <low|medium|high|xhigh|max>` 调整模型投入多少思考。

并非每个模型都支持每个等级，有些端点遇到不支持的等级会直接拒绝而不是向下取整。`supportedEfforts` 列出模型接受的等级——对应设置页服务商窗口里每个模型的「思考档位」开关，不填表示五个都支持。集合外的等级在选择器里显示为不可用，并降到下方最近的受支持等级：

```json
"models": {
  "big": { "provider": "anthropic", "model": "claude-opus-5", "supportedEfforts": ["low", "high"] }
}
```

设置页「通用 › 扩展思考」关闭后，请求不再携带 `thinking` 参数；开关写进项目的 `settings.local.json`，并重建当前会话的运行时。它在构建运行时时读取，因此也覆盖子代理。

单个模型可以单独关掉：服务商窗口里模型的「支持扩展思考」开关，即模型配置上的 `"thinking": {"type": "disabled"}`。关掉的模型不论全局开关如何都不带思考参数；重新打开时，手写的 `thinking` 预算会保留。

```json
{ "thinking": false }
```

### 模型上下文窗口

服务商支持的上下文窗口不是默认的 200,000 token 时，在模型上显式设置 `contextWindow`：

```json
{
  "models": {
    "mimo-v2.5": {
      "endpoint": "xiaomi",
      "model": "mimo-v2.5",
      "contextWindow": 1000000
    }
  }
}
```

不填时先回落到 `agent.contextManagement.contextWindow`，再回落到 200,000。这个值决定上下文预算、历史选择、压缩阈值、ToolSearch 阈值和状态显示；Hanekawa 不会根据模型名推断它。

### 模型价格

模型行的「价格」里填每百万 token 的单价：输入、输出、缓存写入、缓存命中，币种 USD 或 CNY，对应配置里的 `pricing`（`inputPerMillionTokens`、`outputPerMillionTokens`、`cacheWriteInputPerMillionTokens`、`cacheReadInputPerMillionTokens`、`currency`）。四项都空表示不计价；填了任何一项就必须填输入和输出；缓存两项留空时按输入单价计。

每次请求返回时按实际服务它的模型计价——主对话、备用模型、压缩、子代理各按各的价格——再累加到会话开销；之后改价格不影响已经算过的部分，不同币种分开累计。开销随用量写进会话的 metrics 文件，重新打开会话时恢复。输入框下方用量读数的悬停卡片里显示「会话开销」，`/cost` 读同一个数；用到未设置价格的模型时注明未计入，早于开销记录的旧会话注明不含早期请求。

### 设置页

桌面端的设置页（侧栏底部的 `⚙ 设置`，或 macOS 上 ⌘、其他平台 Ctrl+,）覆盖上述配置，分为 模型与服务商、技能和 MCP、权限、Agent、通用、个性化、外观 七类。各页写入的文件不同，页面上会标明即将修改的文件：

| 内容 | 写入位置 |
|---|---|
| 模型与服务商、子代理路由、上下文管理 | `~/.myagent/config.json` |
| 权限规则、默认权限模式、扩展思考、1 小时提示词缓存、MCP 服务器与信任、技能开关、项目调度 | `~/.myagent/projects/<key>/settings.local.json`（每项目一份，不在项目目录里） |
| 个性化 › 自定义指令 | `~/.myagent/AGENTS.md` |
| 技能和 MCP › 导入技能 | 复制到 `<项目>/.myagent/skills/` |
| 外观 › 界面主题 | 只存在应用本地 |

需要知道的几点：

- 权限规则跨层**拼接**、MCP 信任取**并集**，所以设置页只能编辑 `settings.local.json` 里的条目。继承自 `~/.myagent/settings.json` 或项目 `settings.json` 的规则以只读方式列出；在 `~/.myagent/settings.json` 授予的 MCP 信任无法在页面上撤销，要去那个文件里删。
- 六个上下文管理数值在项目启动时读取一次，修改后重启生效。
- 默认权限模式只影响之后新开的会话；项目调度的模型和思考等级在协调者或线程启动时读取。其余设置立即作用于已打开的会话。

## 使用

### 界面与快捷键

左侧是侧栏：会话搜索、按项目分组的会话列表、「最近」（不属于任何项目的会话）以及「项目」入口，宽度可拖动。右侧面板由标题栏右端的图标按钮切换，每个按钮一页，再点当前页的按钮收起面板：**任务**（计划、后台命令、子代理，各自可折叠；后台命令可展开查看输出末尾、停止运行中的进程；有内容在运行时按钮上显示圆点）、**线程**（仅项目有调度时出现）、**改动**（本会话各编辑工具改过的文件，同一文件多轮修改按顺序列出）、**浏览器**。各页分别记忆宽度，双击拖柄恢复默认宽度。

空会话的首页可以切换 git 分支（「切换分支」），并显示用量卡片（概览/模型，全部 / 30 天 / 7 天）。会话标题栏可以重命名、删除会话，或「在 VS Code 中打开」项目。

| 操作 | macOS | Windows / Linux |
|---|---|---|
| 展开/收起侧栏 | ⌘B | Ctrl+B |
| 新建会话 | ⌘T | Ctrl+T |
| 关闭当前会话 | ⌘W | Ctrl+W |
| 切换已打开的会话 | ⌘1–9 | Ctrl+1–9 |
| 打开项目 | ⇧⌘O | Ctrl+Shift+O |
| 设置 | ⌘, | Ctrl+, |

macOS 上标题栏为原生红绿灯按钮预留位置（缩放、全屏切换后也是），拖动空白处可移动窗口。⌘W 关闭当前会话，红色按钮关闭窗口；原生编辑、⌘Q 退出、Control+⌘F 全屏仍可通过 macOS 菜单使用。Windows / Linux 没有原生菜单栏，标题栏自带「文件」「视图」菜单。

### 动效与阅读

菜单、详情、侧栏和权限卡片使用柔和可见的动效。打开和关闭是连续的，中途反向操作会从当前位置继续。流式输出时文本保持可读。批准或拒绝请求立即生效，焦点回到输入框，卡片随后收起。

回合中展开的思考和工具详情在工具交接时保持展开；整个回合结束后，自动展开的详情可以一起折叠。手动的展开/折叠、键盘焦点、文本选择以及向上翻阅都会被保护：阅读较早的消息时，新输出不会把你拉回底部，「回到最新」可立即跳回。恢复会话时直接显示已保存内容，不重放工具完成动画。

桌面端遵循系统的**减弱动态效果**偏好（包括应用运行中修改）：移动、缩放和循环效果停止，进行中的过渡直接落定，状态文字和控件仍然可用。

### 斜杠命令

| 命令 | 作用 |
|---|---|
| `/help` | 列出可用命令 |
| `/clear` | 清空对话 |
| `/resume` | 恢复当前工作目录下的会话 |
| `/rewind` | 回到本会话较早的位置 |
| `/compact [保留重点]` | 立即压缩当前对话，可附上摘要要保留的内容 |
| `/model` | 查看或切换当前模型 |
| `/provider` | 管理端点、模型和路由 |
| `/effort` | 查看或设置思考等级 |
| `/plan` | 进入 plan 模式或查看当前计划 |
| `/agents` | 管理自定义 agent 定义和子代理任务 |
| `/tasks` | 在右侧面板打开任务页 |
| `/skills` | 列出可用技能 |
| `/cost` | 查看 token 用量和费用 |
| `/session` | 查看当前会话信息 |
| `/repair` | 修复会话记录的结构问题 |
| `/paste-image` | 附加剪贴板中的图片 |
| `/attachments` | 列出或移除草稿中的图片附件 |

技能也会注册成斜杠命令，见下文「技能」。

### 图片输入

只有你为某个模型打开图片输入后，它才会收到图片：在 `config.json` 的模型上设置 `supportsImageInput: true`，或在设置页服务商窗口里展开该模型、打开「支持图片输入」。默认关闭，不会根据模型名或端点推断，同一端点下的两个模型可以不同。这个开关是声明而非探测：端点若拒绝图片内容，会返回它自己的错误，Hanekawa 会连同下一步该怎么做一起显示。

支持 PNG、JPEG、GIF 和 WebP。真实格式从字节判断，扩展名写错也没关系；会应用 EXIF 方向；动图 GIF 和 WebP 取第一帧；SVG 保留文本语义。BMP、HEIC、TIFF、AVIF 会被拒绝，并提示先转成 PNG 或 JPEG。`Read` 工具按同样的规则把图片文件发给模型，并标注原始尺寸和发送尺寸。

在输入框里粘贴图片、把图片拖进对话区，或从 `+` 菜单选「选择图片」即可附加，每次输入最多 10 张（显式附件和 `@` 引用的图片合计），消息可以只有图片。每张图片显示一个缩略图，点击后在应用内全屏查看，可放大缩小。

拖进对话区的其他文件和文件夹只附上路径：输入框里每项显示一个方块（完整路径，左下角标格式或「文件夹」），发送后模型按需自行读取，项目外的路径照常经过权限确认。

每张图片先存储，再发送规范化的副本：按 EXIF 旋转、统一颜色、去除元数据、长边缩到 2,000 px（不放大），然后压缩——优先 PNG 以保持文字和透明度清晰，大截图用 JPEG——每张不超过 3.75 MB。原始输入超过 20 MB 或 4000 万像素会被拒绝，压到最低质量仍超出预算的也会被拒绝，错误信息会说明原因并建议裁剪。

当前模型不支持图片时，发送**新**图片会在回合开始前被拦下——草稿保留，提示指向 `/model`。对话中已有的图片变成带文件路径的文字占位符，每次切换只提示一次，而不是每步一次。原图仍保存在会话里，切回支持图片的模型会再次发送。压缩时图片总是被总结成文字（压缩模型不需要支持图片），但保留最新一条用户消息的图片；被压缩的图片可以从缓存路径重新读取。单次请求最多携带 100 张图片，优先丢弃最旧的历史图片；当前输入的图片不会被悄悄丢弃。

附件存放在 `~/.myagent/projects/<key>/attachments/<session-id>/`。导入时复制图片——无论发送、移除草稿附件还是删除会话，都不会修改或删除你的源文件。删除会话会删除它存储的附件；关闭面板或重启会保留；不再被引用的文件在 24 小时保留期过后清理。

### 内置浏览器

桌面端带一个真实的浏览器，agent 操作、你在旁观看。通过「视图 → 显示 / 隐藏浏览器」或标题栏右端的按钮打开；它占据窗口右侧面板，有自己的标签栏、后退/前进/刷新、地址栏和「＋」新建标签页，页面出错时显示可「重试」的错误页。标签页属于打开它的会话通道——切换项目时标签页跟着切换——关闭通道会关闭它的页面。

agent 通过 `Browser` 工具使用同一组标签页：打开、导航、后退/前进/刷新；把页面读成可操作元素表或纯文本；截图；点击（含按坐标点击）、悬停、输入、按键组合、滚动、选择原生 `<select>` 选项、勾选复选框；等待元素或网络空闲；模拟 iPhone、iPad、桌面等设备尺寸做响应式测试；还能在一次调用里批量执行多个步骤。与 `WebFetch` 不同，JavaScript 会运行，登录状态在多次调用间保留，模型读到的是渲染后的页面而不是 HTML 源码。导航按主机名请求你的许可，和 `WebFetch` 一样。下载被禁止。

页面在独立的持久会话分区中加载，cookie 与应用本身隔离；页面接触不到 Hanekawa 的任何东西：没有 preload 脚本、没有 Node 集成、沙箱化且上下文隔离，自动化操作也限定在自己的隔离环境里。密码、一次性验证码和银行卡字段永远不会投射给模型——它们的文本和值返回为空——agent 在这类字段里输入的内容也不会回显到对话记录中。

你可以随时接管标签页：在 agent 的回合进行中，点击地址栏旁的「接管」，或直接在页面里点击、键入（滚轮只算浏览，不算接管）。agent 的下一次浏览器调用会失败，并被要求停下来问你想怎么做；在你交还之前它一直被拦着。交还有两种方式：点击「交还」按钮，或给 agent 发一条消息；回合结束也会自动解除。回合之外，标签页随你使用，不算接管，只是 agent 上次读到的页面快照会失效。

### 项目调度

从侧栏的「项目调度」入口打开调度页，可以「新建调度」（选择一个文件夹），每个项目一张卡片，点开进入该项目的**协调者**：每个项目一个长期存在的会话。新协调者不会自动行动；项目还没有线程时，欢迎语里有「读取项目」按钮，点击后派一个只读线程阅读项目并给出几条建议。协调者只读加调度（权限模式锁定为 `readonly`）：它能阅读和搜索代码，并启动、发消息给、停止、完成**线程**——线程是干活的普通会话。线程默认 `auto` 权限模式，不能再启动线程。需要写代码的线程有自己的 git worktree，位于 `~/.myagent-worktrees/<key>/<threadId>`，分支 `hanekawa/<slug>-<threadId>`；只读线程共用项目目录。

- **侧栏**：顶部的「项目」区为每个项目显示一行协调者，带「N 运行中 · N 需要你」计数；线程本身不在侧栏列出。
- **线程视图**：标题栏显示「← 协调 · 线程名 [状态] [停止]」。右侧「线程」页顶部显示线程计数和「全部停止」，标题栏的「线程」按钮带阻塞线程数角标。线程列表按阻塞、运行中、空闲、安静、已完成分组（后两组默认折叠），每个线程一行，有新动静未查看的显示圆点；行尾「⋯」菜单可在主画布打开、停止或「标为完成」。
- **汇报**：线程的回合结束时，一份简短的、经过清理的笔记（是数据，不是指令）以卡片形式出现在协调者对话里。每个线程汇报后协调者都会被唤醒（其他线程仍在运行时它只处理已汇报的部分）；线程用 `AskCoordinator` 提问也会立即唤醒它。你上次在协调者里发言后，最多自动唤醒 20 次。权限请求从不转给模型：等待审批的线程显示为「需要你」并发出桌面通知。
- **合并**：线程的输入框上方显示「项目名 分支名 +N −M [合并] ×」；协调者显示「N 个线程分支待合并」，可展开。合并由应用自己运行 `git merge`。主工作区有未提交改动时拒绝合并；有冲突时中止合并并显示「有冲突 [让线程解决]」，让线程更新自己的分支。合并成功后删除 worktree 和分支，并把线程标记为完成。
- **长会话**：协调者会收到线程状态看板的快照，并使用专门的压缩提示；压缩后恢复最新看板。空闲超过缓存 TTL 且上下文用量超过 40% 时会提前压缩；如果压缩持续失败，会用摘要和看板开一个新的协调者会话。
- **设置**：Agent 分类下的「项目调度」卡片设置协调者和线程的模型与思考等级，以及「安静天数」（默认 3）和「自动结案天数」（默认 7），空闲线程超过这些天数后分别标记为安静或完成，填 0 关闭。被重启打断的线程会被标记，不会自动恢复。

### 撤回（`/rewind`）

`/rewind` 回到较早的一条提示，可以恢复对话、代码或两者。

恢复代码只恢复 **agent 的写入工具改过的文件**（`Edit`、`Write`、`MultiEdit`、`NotebookEdit`、`Delete`）。每次这类写入之前，原内容会被复制到 `~/.myagent/file-history/<session-id>/`，撤回时把这些副本放回去——并删除 agent 在所选位置之后新建的文件。

`Bash` 只在命令文本能明确看出目标时才被覆盖：输出重定向（`> f`、`>> f`、`2> f`、`&> f`）、`tee`，以及非递归的 `cp`/`mv`。用变量、通配符或命令替换拼出目标的命令，以及脚本间接写入的任何内容，都不会被捕获。

其他一切保持原样：你在编辑器里的修改、构建产物、`git` 操作都不会被捕获，也不会被回滚。撤回撤销的是 agent 的编辑，不是你工作区的状态。

## 权限

每次工具调用先由风险分级器（`src/harness/risk/`）定级，再由权限闸门把等级与你的规则和会话模式结合起来判断。

| 等级 | 含义 |
|---|---|
| `readonly` | 不做任何修改，只读工作区 |
| `normal` | 普通的编辑、构建、安装、联网、读取工作区外的文件 |
| `risky` | 不可逆或影响范围大但属于常规操作：`git push --force`、`git reset --hard`、`rm -r`、发布、`sudo`、写工作区外的文件、`.env` |
| `critical` | 破坏性或持久性的操作：`rm -rf ~`、`mkfs`、`curl … \| sh`、私钥和云凭据、shell rc / `authorized_keys` / git hooks、Hanekawa 自己的权限配置 |

| 等级 | `default` | `plan` | `auto`（需要时询问） | `bypass` |
|---|---|---|---|---|
| readonly | 允许 | 允许 | 允许 | 允许 |
| normal | 询问 | 拒绝写文件（会话计划文件除外）；单纯读取工作区外文件直接允许；其余询问 | 允许 | 允许 |
| risky | 询问 | 同 normal | 询问 | 允许，并提醒模型 |
| critical | 询问，不记住 | 拒绝 | 询问，不记住 | 大范围删除拒绝，其余允许并提醒模型 |

输入框上的权限按钮点开后可在 `default`、`plan`、`auto`、`bypass` 之间选择（协调者会话里不显示）。`readonly` 是内部模式，用于内置的 explore/plan 子代理和协调者会话。子代理的权限永远不会比父会话更宽松。旧的 `acceptEdits` 模式现在就是 `auto`，已有设置和 agent frontmatter 会自动迁移。

规则按优先级：

1. `deny` 规则在任何模式下都拒绝，永远不会变成询问。
2. `ask` 规则询问；`bypass` 忽略它。
3. `allow` 规则覆盖 `normal`；只有规则文本本身就是 risky 的（`Bash(git push --force:*)`、`Edit(/etc/hosts)`）才覆盖 `risky`，`Bash(git push:*)` 不算。没有规则能覆盖 `critical`。

`bypass` 信任模型，唯一的防护是大范围删除——删除 `/`、主目录、两者的直接子目录、盘符根目录或工作区根目录，或者目标在运行时才确定的递归删除（`rm -rf "$X"`、`xargs rm -rf`、`cd "$X"` 之后的相对路径）。`$HOME`、`$PWD` 和 `$(pwd)` 会先解析再判断。需要带护栏的模式请用 `auto`。

「始终允许」只对 `normal` 持久保存。`risky` 可以在本会话内按精确的命令或路径允许。`critical` 两者都不提供。

文件规则匹配解析后的绝对路径。以 `/` 或 `~` 开头的模式是绝对路径，其他都相对于项目根目录，所以 `Read(.env)` 只匹配根目录的 `.env`——要匹配所有的请写 `Read(**/.env)`。`Read`/`Edit` 的 deny 规则也会尽力应用到从 Bash 命令中提取出的路径。规则名有家族别名：`Edit` 涵盖所有写入工具，`Read` 涵盖 `Grep`/`Glob`。

项目 `.myagent/settings.json` 里的 `permissions.mode` 和 `mcp.trustedServers` 会被忽略并给出诊断，请在用户或本地设置中设置。`Config` 工具不能修改权限模式。`WebFetch` 只跟随同一主机内的重定向；跨主机重定向会返回给模型，它的下一次请求重新经过权限闸门。

## 扩展

### 技能

技能放在 `<项目>/.myagent/skills/<name>/SKILL.md`，或所有项目共享的 `~/.agents/skills/<name>/SKILL.md`（同名时项目内的优先），带 YAML frontmatter：

```markdown
---
name: debugging
description: Use when diagnosing bugs
allowedTools: [Read, Grep, Bash]
model: claude
effort: high
attachments:
  - references/checklist.md
hooks:
  stop:
    - command: "echo skill finished"
---

技能说明写在这里。用 $ARGUMENTS 表示斜杠命令参数出现的位置。
```

技能在启动时发现，有两种用法：

- 通用的 `Skill` 工具，让模型在回合中按名字加载技能
- 以 frontmatter 名字命名的斜杠命令，例如 `/debugging args`

`inclusion` 控制技能如何进入上下文：`manual`（默认，出现在技能列表里，按需加载）、`always`（全文放进系统提示）、`fileMatch`（不进列表，会话读到匹配 `paths` glob 的文件时自动激活）。设置里的 `skills.disabled` 或设置页的技能开关可以关掉某个技能。

技能斜杠命令会在后台把技能正文作为普通查询提交，对话记录里只显示斜杠调用本身，例如 `/debugging args`。正文中的 `$ARGUMENTS` 会被替换成命令参数；没有占位符时，非空参数以 `Arguments: ...` 追加在后面。正文可以包含 ``!`git status` `` 这样的内联 shell 片段，它们在提交查询前经过正常的 Bash 权限闸门执行。

斜杠技能还可以在 frontmatter 中声明文本 `attachments`、`hooks`、`allowedTools`、`model` 和 `effort`，只对该次技能回合生效：`allowedTools` 过滤模型可见和可执行的工具，`model`（必须是 `models` 中的 key）和 `effort` 是临时覆盖，`hooks`（支持 `userPromptSubmit`、`preToolUse`、`postToolUse`、`preCompact`、`postCompact`、`stop`）在该回合与会话钩子合并。附件路径是技能目录内的 UTF-8 文本文件，追加到提示末尾；不支持图片和 PDF 附件。与内置斜杠命令重名时内置命令优先。

### 子代理

模型通过 `Agent` 工具派出子代理。内置类型有 `general`、`fork`（预先载入父对话）、`explore` 和 `plan`（后两者为 `readonly`）。自定义 agent 定义从 `~/.myagent/agents/`、`<项目>/.myagent/agents/` 和 `~/.myagent/projects/<key>/agents.local/` 读取，`/agents` 可以查看和管理。子代理使用的模型由 `routing.subagent` 决定，也可以用环境变量 `MYAGENT_SUBAGENT_MODEL` 或 `MYAGENT_SUBAGENT_MODEL_<TYPE>` 覆盖。

### MCP

在设置的 `mcpServers` 里配置 MCP 服务器（也可以在设置页「技能和 MCP」中增删改），传输方式为 `stdio` 或 `sse`：

```json
{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    }
  },
  "mcp": { "trustedServers": ["filesystem"] }
}
```

`mcp.trustedServers` 只能在用户设置或本地设置中授予。MCP 工具默认延迟加载，由模型通过 `ToolSearch` 按需取用。

### 钩子

设置里的 `hooks` 在指定事件运行 shell 命令，事件有 `userPromptSubmit`、`preToolUse`、`postToolUse`、`preCompact`、`postCompact`、`subagentStart`、`subagentStop`、`stop`。每条为 `{ "command": "...", "matcher": "...", "timeoutMs": 5000 }`（`matcher`、`timeoutMs` 可选），跨设置层拼接：

```json
{
  "hooks": {
    "postToolUse": [{ "matcher": "Edit", "command": "npm run format" }]
  }
}
```

## 架构

```text
desktop/ -> runtime/ + harness/ -> config/providers/
                |       |
          sessions/  prompts/  tools/  services/
```

### Agent 循环

`src/harness/loop.ts` 驱动主推理循环：

```text
用户输入 -> 准备记录 -> 必要时压缩 -> 构建上下文 -> 调用模型 -> 执行工具 -> 重复
```

工具执行采用有序分批：连续的可并发安全工具并行执行，不安全的工具逐个执行并充当顺序屏障。`ToolRunner` 负责工具调用、审批和工具结果记录。

### 上下文与缓存

`src/harness/contextBuilder.ts` 组装：

- 静态系统指令
- 项目上下文（指令文件）
- 可选的自定义系统文本
- 技能
- 自动记忆索引
- 环境信息
- 当前日期
- 压缩后恢复的上下文
- 会话历史

Anthropic 提示词缓存在所有 Anthropic 兼容端点（包括代理）上默认为 `auto`，无论端点主机名是什么，缓存标记的位置都一样：

- 静态系统提示块
- 最后一个稳定的工具定义（MCP 工具和延迟加载的工具排在标记之后）
- 最后一条持久消息，以及上一次请求的锚点消息（每轮重建的临时尾部消息会被跳过）

如果端点以 HTTP 400/422 明确拒绝提示词缓存或 `cache_control`，Hanekawa 会去掉缓存标记重试一次该请求。只有不带缓存的重试成功后才记录这次拒绝，同一进程中相同端点 URL 和模型的所有服务商实例共享这一结果；新会话、切换模型和子代理都复用它，重启进程后清除。结果记录前发出的并发请求可能各自探测并回退。无关的错误走正常重试策略；缓存命中为零不会关闭缓存。

在 `~/.myagent/config.json` 的端点或模型上把 `promptCaching` 设为 `"auto"`、`"on"`（不做兼容回退）或 `"off"`，模型上的值覆盖端点默认值。`"on"` 即使之前记录过拒绝也会发送缓存标记。`MYAGENT_DISABLE_PROMPT_CACHING=1` 无视该设置，直接关闭 Anthropic 缓存标记。

缓存 TTL 默认 1 小时（设置页「1 小时提示词缓存」，或 `cache.ttl1h: false` / `MYAGENT_PROMPT_CACHE_1H=0` 改回 5 分钟），兼容端点同样适用；普通缓存不发送 beta 请求头。缓存用量统计和缓存失效诊断在兼容端点上同样运行。缺失的缓存用量不会被当成零命中；服务商调试输出把未缓存输入、缓存写入和缓存读取分开报告。

OpenAI 官方端点（`api.openai.com`）的 Chat Completions 请求带上基于模型、系统提示和工具生成的稳定 `prompt_cache_key`；兼容服务不发，因为部分服务会拒绝不认识的参数。缓存读取数兼容 `prompt_tokens_details.cached_tokens`、DeepSeek 的 `prompt_cache_hit_tokens` 和 Kimi 的顶层 `cached_tokens`；报告了 `cache_write_tokens` 的服务会单独计入缓存写入。

上下文管理完全在客户端进行：Hanekawa 不发送 `context_management` 或 `cache_edits` 请求。它为压缩摘要预留 20,000 token，保留活跃的对话前缀，长时间空闲后清除旧的工具结果，并在接近有效窗口上限时自动压缩。历史回合不会被按位置简单截断。自动压缩连续失败 3 次后暂停；`/compact` 不受此限制，成功后自动压缩恢复。

#### OpenAI Chat Completions

请求一律流式（`stream_options.include_usage`）。长时间没有数据时先提示，10 分钟无数据才中断并按网络错误重试；流结束却没有 `finish_reason` 也按网络错误重试，`content_filter` 直接报错。

请求形状按 `baseUrl` 自动识别：

| 服务 | 开启思考 | 关闭思考 | 其他 |
|---|---|---|---|
| OpenAI 官方 | `reasoning_effort` | 不发 | `developer` 角色、`max_completion_tokens`、`store: false` |
| DeepSeek | `thinking: {type: "enabled"}` + `reasoning_effort` | `thinking: {type: "disabled"}` | 历史 assistant 消息都带 `reasoning_content` |
| 通义（DashScope） | `enable_thinking: true` | `enable_thinking: false` | |
| 智谱 | `thinking: {type: "enabled"}` | `thinking: {type: "disabled"}` | |
| OpenRouter | `reasoning: {effort}` | 不发 | `reasoning_details` 原样回传给产生它的模型 |
| Kimi | 不发 | 不发 | |
| 其他 | 同 OpenAI 官方的 `reasoning_effort` | 不发 | `system` 角色、`max_tokens` |

思考等级原样发送；模型不支持的等级用模型的 `supportedEfforts` 排除。识别不出的中转站可以在 `config.json` 的端点上手写 `thinkingFormat`：`openai`、`deepseek`、`qwen`、`zai`、`openrouter` 或 `none`。

思考默认开启：并不是每个模型都会思考，而兼容服务无法事先告知。端点以 HTTP 400/422 拒绝了思考字段时，Hanekawa 去掉思考字段重试一次；只有重试成功才记住这次拒绝，同一进程中相同端点和模型之后不再发送，重启后清除。全局「扩展思考」关闭，或模型配置了 `"thinking": {"type": "disabled"}` 时，按上表「关闭思考」一列发送。

回复里的推理文本依次读取 `reasoning_content`、`reasoning`、`reasoning_text`，保存在消息上并在下次请求时以 `reasoning_content` 回传。

#### OpenAI Responses

`openai-responses` 同样流式请求，系统提示放在 `instructions`，带 `store: false`；工具一律 `strict: false`（不写的话 Responses 会尝试把工具转成严格模式，可选参数过不了）。工具结果里的图片直接放进 `function_call_output`。`prompt_cache_key` 同样只发给 OpenAI 官方端点。

开启思考时发送 `reasoning: {effort, summary: "auto"}` 和 `include: ["reasoning.encrypted_content"]`；关闭时整个 `reasoning` 都不发——`effort: "none"` 会被不支持它的模型直接拒绝。思考字段被拒时的退回与 Chat Completions 相同。

模型思考过的回复，会把这次的输出项（推理、文本、函数调用）原样存在消息上，下次请求同一个模型时原样回传：加密推理只能交还给产生它的模型，而且要连同与它配对的输出项一起。换了模型，或历史里缺了其中某个函数调用，就退回为只发文本和工具调用、不带推理。回复以 `max_output_tokens` 截断记为输出上限；其他未完成状态和 `response.failed` 直接报错；流结束却没有收到完成事件按网络错误重试。

### 服务商

服务商代码在 `src/config/providers/` 下：

- `anthropicProvider.ts`、`anthropicPayload.ts`
- `openaiProvider.ts`、`openaiPayload.ts`、`openaiCompat.ts`（按地址识别的请求形状、思考字段被拒时的退回）
- `responsesProvider.ts`、`responsesPayload.ts`
- `streamIdle.ts`（流式空闲超时，两种协议共用）
- `usage.ts`、`cacheControlTelemetry.ts`、`imageRequestGuard.ts`、`debug.ts`
- `registry.ts`（服务商构造）、`index.ts`

兼容入口 `src/config/providers.ts` 仍然保留，从 `../config/providers.js` 导入的代码照常工作。

### 工具

每个内置工具一个目录 `src/tools/<Name>Tool/`，包含实现文件和 `prompt.ts`（工具描述及工具名常量），统一在 `src/tools/index.ts` 注册：

- 文件：`Read`、`Write`、`Edit`、`MultiEdit`、`Delete`、`NotebookEdit`、`Grep`、`Glob`
- Shell：`Bash`、`BashOutput`、`KillShell`
- 网络：`WebFetch`、`WebSearch`
- 规划与交互：`EnterPlanMode`、`ExitPlanMode`、`AskUserQuestion`、`TaskCreate`、`TaskList`、`TaskGet`、`TaskUpdate`
- 其他：`Agent`、`SendMessage`、`Skill`、`ToolSearch`、`Config`

桌面端还通过 `extraTools` 注入 `Browser` 和项目调度工具（`StartThread`、`ListThreads`、`MessageThread`、`FetchThread`、`ResolveThread`、`StopThread`、`AskCoordinator`，按会话角色开放）。

工具声明 `name`、`description`、`inputSchema`、`execute()`，以及可选的 `isReadOnly`、`isConcurrencySafe`、`classifyRisk`、`sessionRoles`、`shouldDefer` 等字段。权限判定看的是上面的风险等级；`riskLevel`（`safe` / `confirm` / `dangerous`）只在工具没有专门分级逻辑时作为兜底，分别对应 `readonly` / `normal` / `risky`。

#### ToolSearch

- `HANEKAWA_TOOL_SEARCH`：模式。`true`/`1`/不设置=始终开启，`false`/`0`=关闭，`auto`=自动，`auto:N`=阈值为 N% 的自动模式
- `HANEKAWA_TOOL_SEARCH_AUTO_PERCENT`：自动模式阈值百分比（默认 10）；`auto:N` 优先于它
- `HANEKAWA_DISABLE_EXPERIMENTAL_BETAS=1`：关闭仅 beta 可用的动态 ToolSearch 字段

动态 ToolSearch 只在支持 `tool_reference` 的原生 Anthropic 服务商上启用，使用 `advanced-tool-use-2025-11-20` beta 请求头。OpenAI 和 Anthropic 兼容代理端点回退为内联完整的工具定义，不做动态加载。

### 会话

会话存放在 `~/.myagent/projects/<key>/sessions/`，由元数据和只追加的 JSONL 记录组成，记录包括消息、工具调用、工具结果、审批和压缩边界。每个会话旁边还有一个 `<id>.metrics.jsonl` 用量文件，目录里有 `index.json` 索引。

## 测试

```bash
npm run test         # 全部测试
npm run typecheck    # 类型检查
npm test -- test/config.test.ts
npm test -- test/config.test.ts test/cacheBreakDetection.test.ts
```

`npm test` 给子进程一个一次性的 home 和临时目录，无论成功、失败还是中断都会删除。跑单个测试也请用这个入口，不要直接用 `tsx --test`，否则会读写你真实的 `~/.myagent`。

### 桌面冒烟测试（真实应用）

`npm test` 从不启动 Electron：它离线且封闭，也应该保持这样。桌面外壳由另一个驱动程序验证：它启动真实应用，通过 Chrome DevTools Protocol 操作，检查只有运行中的窗口才能体现的东西——后台会话持续流式输出、挂起的权限请求在切换会话后依然存在、删除会话会清掉所有产物、设置在重启后保留。

```bash
npm run build:desktop      # 发现 dist/ 过期会拒绝运行
npm run smoke:desktop
npm run smoke:desktop -- --first-run
```

它需要显示器，所以只能本地运行。默认使用你配置的服务商。`--first-run` 从没有配置文件开始，使用本地模拟的 OpenAI 兼容端点：验证自动打开配置页、保留草稿、通过服务商窗口一次保存服务商和模型、发送消息，以及重启后使用已保存的模型。这个模式不需要真实凭据，也不会发出外部模型请求。

- **不碰你的数据。** 应用使用临时项目、一次性 home 和独立的 Electron profile。服务商配置来自 `~/.myagent/config.json` 的一份 `0600` 副本；测试模型、项目注册、会话和文件历史都留在一次性 home 里。断言会确认仓库的会话以及你真实的配置、设置和项目注册表都没被改动。
- **默认不花钱。** 只有一项——后台继续运行的真实回合——需要真实的模型调用，并且只在加 `--paid-turn` 时运行。该回合由一次性闩锁限制，默认使用 `step-3.5-flash`（可用 `--model=<key>` 指定），超时会被中断。
- 临时项目、配置、浏览器缓存、截图和日志在成功、失败或中断后都会删除，摘要打印在终端。加 `--out=.smoke/<name>` 保留截图、日志和摘要，或加 `--keep` 保留整个临时环境用于调试。SIGKILL 或断电无法执行清理。

常用参数：`--only=S3,S8` 只运行指定步骤；`--verbose` 打印通过的断言；`--kill-stale` 配合相同的 `--out` 目录停止之前的冒烟进程；`--port=`（默认 9222）；`--model=<key>`、`--paid-prompt=<text>`、`--paid-turn-timeout=<ms>`（默认 45000）用于付费回合。

另有两个同样需要显示器的本地检查，清理规则相同：

- `npm run smoke:browser`：先 `npm run build`，再在一次性 profile 中用 Electron 对内置浏览器跑只有真实渲染进程才有的路径（离开页面拦截、点击命中测试、原生 `<select>`、组合键）。
- `npm run smoke:motion`：录制并检查桌面动效，支持 `--scale=1|1.25`、`--theme=dark|light`、`--dpi=chromium|native`、`--port`、`--out`、`--keep`。

## 环境变量

- `MYAGENT_DEBUG_PROVIDER=1`：记录服务商请求和响应内容
- `MYAGENT_PROMPT_CACHE_1H=0`：把 Anthropic 提示词缓存 TTL 从默认的 1 小时改为 5 分钟
- `MYAGENT_DISABLE_PROMPT_CACHING=1`：关闭提示词缓存
- `MYAGENT_MAX_OUTPUT_TOKENS=N`：覆盖最大输出 token 数（上限 128,000）
- `MYAGENT_STREAM_IDLE_WARNING_MS=N`：流空闲多久发出警告（默认 90 秒；旧名 `MYAGENT_STREAM_IDLE_TIMEOUT_MS` 仍可用）
- `MYAGENT_STREAM_IDLE_HARD_TIMEOUT_MS=N`：流空闲多久中止请求（默认 10 分钟）
- `MYAGENT_SUBAGENT_MODEL` / `MYAGENT_SUBAGENT_MODEL_<TYPE>`：覆盖子代理使用的模型
- `HANEKAWA_SEARCH_URL`：`WebSearch` 使用的 SearXNG 地址
- `MYAGENT_BASH_PATH`：指定 Bash 可执行文件（仅 Windows 生效）
- ToolSearch 相关变量见上文「ToolSearch」
