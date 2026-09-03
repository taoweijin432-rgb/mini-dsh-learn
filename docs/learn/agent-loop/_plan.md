# Agent Loop 入门指南实施计划

> 生成时间：2026-09-03
> 基于 spec：[_spec.md](./_spec.md)
> 状态：待用户批准
**Goal：** 按已批准的规格落地一份完整的 Agent Loop 中文入门指南，
产出 `_spec.md`、`_plan.md`、`agent-loop.md` 三份 Markdown。
**Architecture：** 采用单文件正文。Task 1 编写并自查 `agent-loop.md`，
Task 2 做整体验收。正文不修改项目源码，只解释基线 commit 中已经存在的代码。
**Tech Stack：** Markdown、GitHub-flavored Mermaid、`file:///` 源码链接和 Git。

---

## 全局约定
1. 代码引用格式使用 `[basename](file:///绝对路径#Lstart-Lend)`。
2. 链接文字只写文件名，不添加反引号。
3. 源码行号基于 commit `2fbb62996bbf16d556a627ad5646af2ffa6c415b`。
4. 正文全部使用中文，以第一次接触 Agent Loop 的读者为主线受众。
5. 新增代码采用逐行或紧密连续代码块的讲解方式。
6. 每段代码先说明“做什么”，再解释“为什么这样写”。
7. 所有术语首次出现时必须解释，不能直接假设读者已经理解。
8. 至少使用一张 Mermaid 图展示完整调用过程。
9. 至少使用一张 Mermaid 图或表格展示多工具取消过程。
10. 📦 额外知识框统一以 `> 📦 **额外知识：标题**` 开头。
11. 全文至少包含 4 个 📦 额外知识框。
12. 全文末尾恰好包含一个 `> 💡 **一句话记住**：...`。
13. 教程包含 18 道分级面试问答。
14. 每个新增测试都按 Arrange、Act、Assert 和失败表现讲解。
15. 每个 Task 完成后立即创建本地 Git commit。
16. 本阶段不修改 Agent Loop 源码，也不新增测试代码。

---

## 文件结构
| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `docs/learn/agent-loop/_spec.md` | 已批准 | 教程范围和验收标准 |
| `docs/learn/agent-loop/_plan.md` | 当前文件 | 教程实施步骤 |
| `docs/learn/agent-loop/agent-loop.md` | 待创建 | 单文件中文整合教程 |

---

## Task 1：编写单文件整合教程
**Files：**
- Create：`docs/learn/agent-loop/agent-loop.md`
- Read：`src/core/agent-runtime.ts`
- Read：`src/core/agent-loop-runtime.ts`
- Read：`src/plugins/agents.ts`
- Read：`src/plugins/agent-loop.ts`
- Read：`test/core.test.ts`

### Step 1：写正文
按照以下结构编写 350-900 行正文：

1. **阅读路线**
   - 小白完整路线
   - 后端开发者重点路线
   - 熟练开发者速查路线
2. **类比开场**
   - Agent 是带着工牌和工作任务的员工
   - AgentRuntime 是员工登记处
   - AgentLoopRuntime 是工作流程和调度员
3. **全景图**
   - 展示 `agent.send()` 到最终回答的数据流
   - 标明 Session、Prompt、Tool、LLM 四个依赖
4. **运行前的基础概念**
   - Agent、Agent Loop、Runtime、插件和依赖注入
   - tool call 与 tool result 的配对关系
5. **`agent-runtime.ts` 逐行讲解**
   - 类型导入
   - `Agent` 和 `CreateAgentOptions`
   - 注册表、`register()`、disposer
   - `create()` 中的闭包
   - `list()`
6. **`agent-loop-runtime.ts` 类型逐行讲解**
   - 运行选项和四种回调
   - 工具调用与工具结果类型
   - 依赖接口与最小 Loop 接口
   - `CANCELLED_RESULT`
7. **`run()` 主循环逐行讲解**
   - 写入用户消息
   - 进入无固定步数上限的循环
   - 组装 system prompt
   - 投影 messages
   - 调用 LLM
   - 最终回答分支
   - 工具调用分支
8. **多工具取消机制**
   - 为什么不能在工具循环中立即抛错
   - `cancelled ||=` 的状态传播
   - 如何为剩余 tool call 补取消结果
   - 为什么走完整个工具循环后才抛错
9. **两个 Cordis 插件逐行讲解**
   - Service 薄封装
   - `ctx.agents` 和 `ctx.agentLoop`
   - `inject` 与 `static inject`
10. **四个新增测试逐个拆解**
    - 模型 → 工具 → 模型
    - 超过 12 步仍继续
    - 四类流式回调
    - 多工具取消后日志仍然自洽
11. **关键设计决策**
    - 句柄和循环分离
    - 构造函数依赖注入
    - 事件日志作为单一事实来源
    - 流式回调只透传
    - 学习版不设置 `maxSteps`
12. **常见错误和扩展方向**
13. **18 道面试问答**
14. **源码索引**
15. **全文唯一的一句话总结**

### Step 2：正文自查
执行：
```bash
FILE=docs/learn/agent-loop/agent-loop.md
wc -l "$FILE"
grep -c "📦" "$FILE"
grep -c "💡 \*\*一句话记住\*\*" "$FILE"
grep -c "file:///" "$FILE"
grep -c '^\`\`\`mermaid' "$FILE"
```

预期：
- 行数在 350-900 之间
- 📦 至少 4 个
- 💡 一句话记住恰好 1 个
- `file:///` 至少 8 个
- Mermaid 代码块至少 1 个
- 18 道面试题数量准确
- 四个新增测试全部被讲解

如果任意项目不达标，补充或精简正文后重新自查，最多执行 3 轮。

### Step 3：提交正文
```bash
git add docs/learn/agent-loop/agent-loop.md
git commit -m "docs(learn): add agent-loop tutorial"
```

---

## Task 2：整体验收
### Step 1：术语一致性检查
- Agent、Agent Runtime、Agent Loop、Agent Loop Runtime 的写法保持一致
- `toolCalls` 表示项目内部响应，`tool_calls` 表示投影后的 API 消息
- `reasoningContent` 和 `reasoning_content` 的使用场景不能混淆
- disposer、AbortSignal、SessionEvent 首次出现时均有解释

### Step 2：源码链接抽查
- 检查 4 个新增文件的链接和行号
- 检查 4 个新增测试的链接和行号
- 至少随机抽查 8 处链接
- 对照 commit `2fbb62996bbf16d556a627ad5646af2ffa6c415b`

### Step 3：正文结构检查
- [ ] 包含三档阅读路线
- [ ] 包含类比开场
- [ ] 包含 Agent Loop 全景图
- [ ] 包含主循环逐步讲解
- [ ] 包含四个新增文件的逐行讲解
- [ ] 包含四个新增测试的详细拆解
- [ ] 包含多工具取消专题
- [ ] 包含设计决策和常见错误
- [ ] 包含 18 道面试问答
- [ ] 包含源码索引
- [ ] 文末只有一个“一句话记住”

### Step 4：最终提交
全部验收通过后创建空提交：
```bash
git commit --allow-empty -m "docs(learn): finalize agent-loop tutorial (v0.1.0)"
```
