# Run 生命周期与执行边界：从真实 DSH 到 mini-dsh

## 1. 这次实现要学习什么

本项目没有直接复制真实 DSH 的全部包，而是抽出最值得学习的四个思想：

1. **一次 Agent 请求不是一个裸 Promise，而是一个有状态的 Run。**
2. **Session 是事件真源，模型消息从事件投影出来。**
3. **一次 Run 由多个 step 组成；一个 step 是一次模型请求及其工具执行。**
4. **结束必须有结构化原因，并且所有打开的边界都要关闭。**

在真实 DSH 中，类似概念通常叫 `turn` 和 `step`：

```text
turn/start
  ├── step/start
  │     ├── assistant/chunk
  │     ├── assistant/message 或 tool/call
  │     └── tool/result
  ├── step/end
  └── turn/end { reason }
```

本项目先把顶层概念命名为 `Run`，让初学者更容易理解：

```text
run/start
  ├── step/start
  │     ├── 一次 LLM 请求
  │     └── 该请求产生的工具执行
  ├── step/end
  └── run/end { status, reason }
```

## 2. 真实 DSH 思想和本项目实现的映射

| 真实 DSH 思想 | mini-dsh 学习版 |
|---|---|
| Session event-sourced log | `SessionRuntime.events` |
| LLM history derived from session | `SessionRuntime.deriveMessages()` |
| `turn/start` / `turn/end` | `run/start` / `run/end` |
| `step/start` / `step/end` | 同名事件 |
| 结构化 turn end reason | `RunEndReason` |
| Agent/Loop 生命周期分离 | `AgentRuntime` + `AgentLoopRuntime` + `RunRuntime` |
| timeout signal 只负责通知 | `ActiveRun.signal`；能力自己响应取消 |
| subprocess 自己负责真实终止 | 当前 Bash 仍是简化版，进程树清理留在后续任务 |
| durable session / flush | 当前尚未实现，属于 P0-22/P0-23 |
| agent handle dispose | 当前尚未实现完整 handle，属于后续 Agent 生命周期任务 |

## 3. RunRuntime 的职责

文件：`src/core/run-runtime.ts`

`RunRuntime` 只管理进程内的 Run 注册表和默认边界；它不调用模型，也不执行工具。

```text
RunRuntime.start()
      ↓
ActiveRun
      ├── beginStep()
      ├── consumeToolCall()
      ├── consumeOutput()
      ├── requestStop()
      └── finish()
```

### 3.1 为什么需要 ActiveRun

如果没有 `ActiveRun`，边界逻辑容易散落在 Agent Loop 中：

```text
Agent Loop 自己计 step
Agent Loop 自己计工具
CLI 自己处理 timeout
Provider 自己处理取消
```

这样很快会出现不同入口行为不一致的问题。

现在所有执行边界都由 Run 统一保存：

```ts
run.currentStep
run.toolCalls
run.outputBytes
run.limits
run.stopReason
run.signal
```

Loop 只在关键边界调用方法，不直接修改计数器。

### 3.2 为什么 stopReason 不能只是字符串

不推荐：

```ts
run.status = 'failed';
run.error = 'something went wrong';
```

推荐：

```ts
{
  kind: 'max-steps',
  limit: 30,
}
```

原因是 UI、日志、恢复逻辑和测试都需要区分：

```text
用户取消
运行超时
超过最大 step
超过工具调用数
超过输出字节数
模型/工具真正失败
```

## 4. AgentLoop 的边界顺序

当前 `AgentLoopRuntime.run()` 的重要顺序是：

```text
1. RunRuntime.start()
2. 写 run/start
3. 写 user/message
4. beginStep()
5. 写 step/start
6. 组装 system prompt
7. 从 Session 投影 messages
8. 调用 LLM
9. 再次检查 Run 是否被取消或超时
10. 写 assistant/message 或 assistant/tool_calls
11. 执行工具，并为每个 tool call 写 tool/result
12. 写 step/end
13. 成功时 finish(completed)
14. 失败/取消/超限时 finish(reason)
15. 写 run/end
```

第 9 步很重要：有些测试适配器或第三方 SDK 不会及时响应 AbortSignal。即使模型 Promise 最后返回了，也不能因为拿到了返回值就忽略已经发生的 timeout。

## 5. 为什么取消时仍然要补工具结果

假设模型一次返回两个调用：

```text
assistant/tool_calls: [write_file, bash]
```

第一个工具执行期间用户取消了运行。如果直接抛错，历史会变成：

```text
assistant/tool_calls: [write_file, bash]
tool/result: write_file
```

`bash` 没有对应结果，下一次投影给模型时，assistant/tool 调用关系不完整。

现在的规则是：

```text
assistant/tool_calls: [write_file, bash]
tool/result: write_file      # 真实结果
tool/result: bash            # CANCELLED_RESULT 或 BOUNDARY_RESULT
run/end: cancelled/budget_exceeded
```

这就是“先收尾事件，再结束 Run”。

## 6. timeout 和真正终止的边界

真实 DSH 的 timeout 设计有一个很值得学习的分层：

```text
timeout/deadline：负责计时和分类
具体能力：负责真正停止工作
```

例如：

```text
LLM fetch       → 把 signal 交给 fetch
Bash 子进程     → signal 触发进程组终止
MCP 请求        → signal 触发 transport 关闭
```

本项目当前已经让 Run 生成自己的 `AbortSignal`，但 Bash 仍然是简化实现。后续 P2 的执行器任务需要补：

- 进程组管理
- SIGTERM → 宽限期 → SIGKILL
- descendants 回收
- 清理后的环境变量
- 等待整个进程树真正退出

因此当前实现可以学习生命周期边界，但不能宣称已经实现了真实安全隔离。

## 7. 建议的阅读顺序

1. `src/core/run-runtime.ts`
   - `RunEndReason`
   - `RunLimits`
   - `ActiveRun.beginStep()`
   - `ActiveRun.consumeToolCall()`
   - `ActiveRun.requestStop()`
   - `ActiveRun.finish()`
2. `src/core/agent-loop-runtime.ts`
   - `run.start`
   - `step.start`
   - 模型请求后的二次边界检查
   - 多工具结果补齐
   - `step.end` / `run.end`
3. `src/core/session-runtime.ts`
   - 生命周期事件为什么不进入 `deriveMessages()`
4. `test/core.test.ts`
   - 成功生命周期
   - maxSteps
   - maxToolCalls
   - timeout
   - output budget

## 8. 当前实现的诚实边界

本阶段已经完成：

- Run ID
- Run 状态
- step 计数
- tool call 计数
- 模型流式输出字节预算
- maxDurationMs timeout
- caller cancellation
- 结构化结束原因
- run/step 生命周期事件
- 未执行工具的配对结果

本阶段还没有完成：

- SQLite 或其他持久化
- crash recovery
- Run 事件的真正 durable flush
- token 级上下文预算
- 工具 schema 校验
- 工具统一 timeout
- 容器级进程隔离
- 多用户 API

所以，这一阶段的正确结论是：

> 我们已经从“无边界的 Agent Loop”升级为“具有可观察生命周期和基础执行边界的学习型 Agent Loop”，但还不是完整生产级 DSH。
