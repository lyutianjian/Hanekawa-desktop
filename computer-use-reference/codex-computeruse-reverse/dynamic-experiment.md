# 正式 Computer Use 动态实验记录

日期：2026-11-04，Asia/Shanghai。使用当前聊天中的正式 mcp__cua_repl.js。以下为工具调用和关键返回内容的整理，未将截图另存为文件；结果截图可在本聊天对应工具输出中查看。

最初尝试被用户中断，不计为成功。用户要求继续后，调用如下。

## 1. 绑定和首次观察

```javascript
let calculator = await cua.getApp("com.apple.calculator");
```

工具报告 7.676 秒，自动返回接口文档、确认规则和完整 AX 树。关键节点：

```text
Window: "计算器", App: 计算器.
4 滚动区 ID: StandardInputView;value:0, Secondary Actions: 拷贝
5 文本 Description: 编辑字段, Value: 0
18 按钮 Description: 1, ID: One
19 按钮 Description: 2, ID: Two
21 按钮 Description: 加, ID: Add
25 按钮 Description: 等于, ID: Equals
```

## 2. 批量点击后差分

```javascript
await calculator.click(18);
await calculator.click(21);
await calculator.click(19);
await calculator.click(25);
await calculator.getAXState();
```

工具报告 0.8443 秒，返回：

```text
The following is a diff from the previous accessibility tree for Window: "计算器" with ~ and + representing changed and added elements, respectively. Removed elements are summarized by ID range.
Removed element IDs: 29-31
+            38 滚动区 ID: StandardResultView, Secondary Actions: 拷贝
+                39 文本 Description: 上个表达式, Value: 1 + 2
~            4 滚动区 ID: StandardInputView;value:3, Secondary Actions: 拷贝
~                5 文本 Description: 编辑字段, Value: 3
+    40 菜单按钮 窗口共享
```

上面的缩进为了 Markdown 阅读被整理，内容和索引按工具输出记录。

## 3. 完整 AX 与截图

```javascript
await calculator.getAXStateAndScreenshot({disableDiffing:true});
```

工具报告 0.1441 秒，返回完整树和计算器窗口截图。树中表达式为 1 + 2、结果为 3，截图也显示相同结果。完整树的关键索引变为：

```text
4 滚动区 ID: StandardResultView, Secondary Actions: 拷贝
5 文本 Description: 上个表达式, Value: 1 + 2
6 滚动区 ID: StandardInputView;value:3, Secondary Actions: 拷贝
7 文本 Description: 编辑字段, Value: 3
18 按钮 Description: 6, ID: Six
20 按钮 Description: 1, ID: One
21 按钮 Description: 2, ID: Two
23 按钮 Description: 加, ID: Add
27 按钮 Description: 等于, ID: Equals
```

完整观察后的 18 已不同于初始 18，后续动作需按最新观察重新定位。

## 4. 完成标记与实验边界

紧接着按工具约定发送了一次 completion_summary，工具确认收到。没有继续进行业务应用操作。

此实验验证了持久 App 绑定、索引动作、批量执行、AX 差分、完整观察和窗口截图。未做并行前台操作、遮挡、多显示器、锁屏或后台输入机制的对照实验。单次工具时间不等于性能基准。
