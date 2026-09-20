# mini-dsh 工程化实现清单

> 目标：把当前可运行的学习型 Agent Loop，逐步推进为具备边界、恢复能力、可观测性和可验证性的工程化 DSH（DeepSeek Harness）原型。
>
> 本清单是持续更新文件。后续每完成一项实现，必须同步把该项状态改为 `✅ 已实现`，并补充实现日期、变更文件和验证证据；不能只改代码而不更新清单。

## 1. 状态和完成规则

### 1.1 状态含义

- `✅ 已实现`：代码已经存在，验收标准已满足，并有当前工作区验证证据。
- `🟡 部分实现`：有可运行的基础版本，但距离本清单定义的工程化验收标准仍有缺口。
- `⬜ 未实现`：尚未实现，或只有设计/注释，没有可验证代码。
- `🔍 未验证`：代码可能已经存在，但缺少当前工作区的测试、集成或真实环境证据。
- `⛔ 阻塞`：实现依赖外部条件，当前无法继续推进；必须记录阻塞原因。

### 1.2 每项完成时必须补充

```text
状态：✅ 已实现
实现日期：YYYY-MM-DD
实现文件：...
验收命令：...
验证结果：...
备注：...
```

如果只完成了部分内容，保持 `🟡 部分实现`，不要为了让清单好看而提前标记完成。

### 1.3 当前基线

- 审计日期：2026-09-20
- 当前分支：`main`
- 当前 HEAD：`85af48e`
- 工作区：干净
- 当前测试：`pnpm test` 通过，22/22
- 当前类型检查：`pnpm check` 通过
- 当前差异检查：`git diff --check` 通过
- 真实 DeepSeek/OpenAI 网络请求：本轮未验证
- 当前定位：学习型 Agent Loop + 单用户 CLI 原型，尚未达到生产级 Agent

---

## 2. 已有基线能力

这些能力已经存在，但“已实现”仅表示当前学习型原型范围完成，不代表生产级安全或可靠性已经完成。

| ID | 能力 | 状态 | 当前证据 | 后续注意事项 |
|---|---|---|---|---|
| BASE-01 | Agent 句柄、AgentRuntime 注册和创建 | ✅ 已实现 | `src/core/agent-runtime.ts` | 仍是内存注册表 |
| BASE-02 | Agent Loop：模型 → 工具 → 模型 → 最终回答 | ✅ 已实现 | `src/core/agent-loop-runtime.ts` | 需要补 Run、预算和恢复 |
| BASE-03 | Session 事件日志和消息投影 | ✅ 已实现 | `src/core/session-runtime.ts` | 仍是内存实现，事件缺少 run/trace 元数据 |
| BASE-04 | System Prompt section/context 组装 | ✅ 已实现 | `src/core/system-prompt-runtime.ts` | 需要 Prompt 版本和上下文压缩配合 |
| BASE-05 | ToolRuntime 注册、执行、结果渲染 | ✅ 已实现 | `src/core/tool-runtime.ts` | 尚无通用 schema 校验和能力策略 |
| BASE-06 | DeepSeek/OpenAI Chat Completions SSE 适配 | 🟡 部分实现 | `src/models/deepseek.ts`、`src/models/openai.ts` | 缺少统一网关、重试、超时、usage 和能力描述 |
| BASE-07 | 文件工具：read/write/edit/glob/grep | 🟡 部分实现 | `src/tools/files.js` | 缺少统一大小限制、原子写入和并发保护 |
| BASE-08 | Bash 工具和应用层命令策略 | 🟡 部分实现 | `src/tools/bash.js`、`src/core/sandbox-runtime.js` | 不是容器，不能作为不可信代码的安全边界 |
| BASE-09 | 外部插件和 Context7 MCP 接入 | 🟡 部分实现 | `plugins.config.js`、`src/plugins/external-plugins.js` | 缺少插件信任、能力审核、健康状态和重连策略 |
| BASE-10 | 单用户 CLI、审批、Esc 取消和调试命令 | 🟡 部分实现 | `src/plugins/cli.ts` | 缺少 API 层、CLI E2E 和错误输入覆盖 |
| BASE-11 | Cordis 插件装配与生命周期卸载 | ✅ 已实现 | `src/index.ts`、`src/plugins/` | 需要补启动诊断和配置校验 |
| BASE-12 | 核心单元测试和 Cordis 集成测试 | 🟡 部分实现 | `test/core.test.ts`、`test/integration.test.ts` | 缺少 Provider contract、CLI E2E、安全、持久化和评测测试 |
| BASE-13 | Agent Loop 中文学习文档 | ✅ 已实现 | `docs/learn/agent-loop/` | 需要补工程化运行手册和安全边界说明 |

---

## 3. P0：完整本地工程化原型的必做项

> 完成 P0 后，才可以较有把握地称为“工程化的单用户本地 DSH 原型”。

### 3.1 Run 生命周期和执行边界

| ID | 实现项 | 状态 | 依赖 | 验收标准 |
|---|---|---|---|---|
| P0-01 | 引入 RunRuntime / RunState | ✅ 已实现 | BASE-02、BASE-03 | 每次 `agent.send()` 创建唯一 run；记录 `runId`、状态、开始/结束时间、停止原因、当前 step |
| P0-02 | Agent Loop 最大步数限制 | ✅ 已实现 | P0-01 | 支持 `maxSteps`；超限后停止并写入明确的 `max-steps` 结构化原因 |
| P0-03 | 工具调用数、运行时长和输出预算 | ✅ 已实现 | P0-01 | 支持 `maxToolCalls`、`maxDurationMs` 和模型流式 `maxOutputBytes`，超限有结构化停止原因 |
| P0-04 | 运行错误和取消状态机 | ✅ 已实现 | P0-01 | 统一覆盖 completed、failed、cancelled、timeout、budget_exceeded；`context_overflow` 留给 P0-06 上下文管理 |
| P0-05 | 运行事件元数据 | ✅ 已实现 | P0-01 | Session 事件或独立 Run 事件包含 `runId`、`step`、`traceId`，可按 run 重建过程 |

### 3.2 上下文和消息管理

| ID | 实现项 | 状态 | 依赖 | 验收标准 |
|---|---|---|---|---|
| P0-06 | ContextManager | ⬜ 未实现 | P0-01 | 模型请求前统一执行消息预算、工具结果裁剪和系统消息保留策略 |
| P0-07 | Token/上下文窗口估算 | ⬜ 未实现 | P0-06 | 根据模型能力或配置估算输入规模，接近上限时提前处理而不是等待上游报错 |
| P0-08 | 历史摘要和压缩 | ⬜ 未实现 | P0-06 | 长会话可以生成 summary event；压缩后仍保留当前任务、关键事实和最近工具结果 |
| P0-09 | 工具输出压缩 | ⬜ 未实现 | P0-06、P0-03 | read/grep/glob/MCP 工具都有统一输出上限和截断提示，不能无界进入上下文 |

### 3.3 工具契约和策略

| ID | 实现项 | 状态 | 依赖 | 验收标准 |
|---|---|---|---|---|
| P0-10 | 通用 JSON Schema 参数校验 | ⬜ 未实现 | BASE-05 | 工具执行前统一校验 required、类型和结构；非法参数不会直接进入业务函数 |
| P0-11 | Tool timeout 和 AbortSignal 规范 | ⬜ 未实现 | P0-03 | 每个工具有超时策略；超时能写入工具错误并清理执行资源 |
| P0-12 | Tool 输入/输出大小限制 | ⬜ 未实现 | P0-03 | 所有内置和外部工具都受统一输入、输出、条目数量限制 |
| P0-13 | Tool capability 声明 | ⬜ 未实现 | BASE-08、BASE-09 | 工具声明读文件、写文件、执行进程、网络、外部副作用等能力 |
| P0-14 | 统一审批策略 | ⬜ 未实现 | P0-13 | 审批由策略层统一决定；内置工具和 MCP 工具不能绕过同一套审批/拒绝规则 |
| P0-15 | 文件写入并发保护和原子替换 | ⬜ 未实现 | BASE-07 | edit/write 支持版本或 hash 校验；采用临时文件和原子替换，避免覆盖用户新修改 |

### 3.4 Provider 和配置可靠性

| ID | 实现项 | 状态 | 依赖 | 验收标准 |
|---|---|---|---|---|
| P0-16 | 统一 ModelGateway | ⬜ 未实现 | BASE-06 | Agent Loop 不直接依赖供应商细节，网关统一处理请求、流式事件和错误分类 |
| P0-17 | LLM timeout、重试和 429/5xx 处理 | ⬜ 未实现 | P0-16 | 网络超时、限流和临时服务错误按策略重试；不可重试错误不盲目重试 |
| P0-18 | 共用 SSE 和 tool-call 流解析器 | ⬜ 未实现 | BASE-06 | DeepSeek/OpenAI 不再维护重复 parser；parser contract tests 覆盖分片、DONE、坏 JSON |
| P0-19 | Provider 可选注册和启动诊断 | ⬜ 未实现 | BASE-06 | 只配置 OpenAI 时可启动；只配置 DeepSeek 时可启动；无 Provider 时给出清晰错误 |
| P0-20 | 配置 schema 和集中默认值 | ⬜ 未实现 | P0-19 | 环境变量统一解析、校验、脱敏展示；覆盖模型、工作区、预算、审批、日志和网络策略 |
| P0-21 | 模型能力描述 | ⬜ 未实现 | P0-16 | 每个模型声明上下文窗口、工具支持、reasoning、vision 和输出能力 |

### 3.5 持久化和恢复

| ID | 实现项 | 状态 | 依赖 | 验收标准 |
|---|---|---|---|---|
| P0-22 | SessionRepository 接口 | ⬜ 未实现 | BASE-03 | SessionRuntime 依赖 Repository；至少同时提供 memory 实现和持久化实现 |
| P0-23 | SQLite Session/Event Store | ⬜ 未实现 | P0-22 | 进程重启后能恢复 session、事件顺序和消息投影 |
| P0-24 | RunRepository | ⬜ 未实现 | P0-01、P0-22 | 能查询运行状态、停止原因、工具调用和失败信息 |
| P0-25 | 失败后的恢复/回放 | ⬜ 未实现 | P0-23、P0-24 | 进程中断后可以识别未完成 run；至少能安全终止或人工恢复，不能静默丢失状态 |

### 3.6 P0 验证和交付

| ID | 实现项 | 状态 | 依赖 | 验收标准 |
|---|---|---|---|---|
| P0-26 | Provider contract tests | ⬜ 未实现 | P0-16、P0-18 | 测试请求 body、SSE、错误码、取消、工具调用拼接和无 body 响应 |
| P0-27 | Agent reliability tests | ⬜ 未实现 | P0-01 至 P0-12 | 覆盖无限循环、超时、取消、坏参数、大输出、未知工具、模型失败 |
| P0-28 | Persistence tests | ⬜ 未实现 | P0-22 至 P0-25 | 覆盖重启恢复、事件顺序、重复事件、未完成 run 和消息投影 |
| P0-29 | CLI E2E tests | ⬜ 未实现 | BASE-10 | 覆盖 `/help`、`/tools`、`/models`、`/model`、`/history`、`/reset`、审批、Esc 和 EOF |
| P0-30 | README 和本地运行手册 | ⬜ 未实现 | P0-19、P0-20 | 新用户可按文档启动、配置 Provider、理解审批和明确安全边界 |


---

### P0-01 至 P0-05 实现记录

- 状态：✅ 已实现
- 实现日期：2026-09-20
- 实现文件：`src/core/run-runtime.ts`、`src/core/agent-loop-runtime.ts`、`src/core/session-runtime.ts`、`src/plugins/runs.ts`、`src/plugins/agent-loop.ts`、`src/index.ts`
- 测试文件：`test/core.test.ts`
- 验收命令：`pnpm test`、`pnpm check`、`git diff --check`
- 验证结果：27/27 tests passed；类型检查通过；差异检查通过
- 设计说明：`docs/engineering/run-lifecycle.md`
- 已覆盖：Run ID、Run/step 生命周期、maxSteps、maxToolCalls、maxDurationMs、maxOutputBytes、caller cancellation、结构化停止原因，以及未执行工具的配对结果
- 当前边界：Run 状态仍保存在内存；timeout signal 只负责通知，Bash 进程树的真正隔离和清理留在 P2 执行器任务

---

## 4. P1：可靠 Agent 和可运维原型

| ID | 实现项 | 状态 | 依赖 | 验收标准 |
|---|---|---|---|---|
| P1-01 | 结构化日志和 traceId | ⬜ 未实现 | P0-01、P0-05 | 每次 run、模型请求、工具调用、审批都有可关联日志 |
| P1-02 | Token、延迟和成本统计 | ⬜ 未实现 | P0-16、P0-21 | 记录 provider/model、输入输出 token、延迟和估算成本 |
| P1-03 | 审批审计日志 | ⬜ 未实现 | P0-14、P1-01 | 记录谁、何时、对哪个工具、以什么参数、批准或拒绝了什么 |
| P1-04 | Provider fallback 和健康检查 | ⬜ 未实现 | P0-17、P0-19 | 当前 Provider 不可用时按能力和策略选择 fallback，并能报告健康状态 |
| P1-05 | 统一错误分类和用户错误信息 | ⬜ 未实现 | P0-04、P0-16 | 区分配置错误、网络错误、模型错误、工具错误、权限错误和用户取消 |
| P1-06 | 任务恢复和幂等控制 | ⬜ 未实现 | P0-25 | 重试不会重复不可逆副作用；工具调用有幂等或人工确认策略 |
| P1-07 | Prompt 版本管理 | ⬜ 未实现 | BASE-04、P0-06 | prompt fragment 有版本/来源，可定位某次 run 使用的规则 |
| P1-08 | MCP 工具健康、重连和能力审核 | ⬜ 未实现 | BASE-09、P0-13、P0-14 | 外部 MCP 失败可报告、重连或降级；工具不能绕过本地策略 |
| P1-09 | Agent Eval 回归集 | ⬜ 未实现 | P0-26、P0-27 | 有固定任务集，统计工具选择、最终结果、步数、成本和失败原因 |
| P1-10 | CI、格式化、Lint 和覆盖率门禁 | ⬜ 未实现 | P0-26 至 P0-30 | Pull Request 自动执行测试、类型检查、diff 检查、lint 和关键覆盖率门禁 |
| P1-11 | 构建和发布产物 | ⬜ 未实现 | P1-10 | 有可复现的 build、打包、版本和启动检查流程 |

---

## 5. P2：真正的安全执行和平台化 DSH

| ID | 实现项 | 状态 | 依赖 | 验收标准 |
|---|---|---|---|---|
| P2-01 | 容器/隔离执行器 | ⬜ 未实现 | P0-13、P1-08 | Agent 命令在非 root、受限网络、受限资源的隔离环境中执行 |
| P2-02 | 环境变量和秘密访问白名单 | ⬜ 未实现 | P2-01 | 默认不把全部 `process.env` 暴露给工具和子进程 |
| P2-03 | 进程组和 descendants 清理 | ⬜ 未实现 | P2-01 | 取消、超时和退出时能清理整个进程树 |
| P2-04 | HTTP API 和 SSE/WebSocket 事件流 | ⬜ 未实现 | P0-01、P0-05、P1-01 | CLI 之外提供 session、run、cancel、events、tools、models API |
| P2-05 | 认证、授权和多用户隔离 | ⬜ 未实现 | P2-04、P0-23 | 用户只能访问有权限的 session、run、workspace 和工具 |
| P2-06 | 队列、Worker 和并发控制 | ⬜ 未实现 | P2-04、P2-05 | 长任务不会阻塞 API 进程；有并发、排队和取消策略 |
| P2-07 | 部署、监控和告警 | ⬜ 未实现 | P1-01、P1-02、P1-10 | 有 Docker/部署配置、健康检查、指标、日志采集和故障告警 |
| P2-08 | 安全回归和负载测试 | ⬜ 未实现 | P2-01 至 P2-07 | 覆盖命令绕过、秘密泄漏、路径攻击、并发和长任务压力 |

---

## 6. 推荐实现顺序

不要按文件数量推进，而要按风险闭环推进：

```text
P0-01 RunRuntime
  → P0-02/P0-03/P0-04 运行边界
  → P0-06/P0-07/P0-08 上下文管理
  → P0-10/P0-11/P0-12 工具契约
  → P0-16/P0-17/P0-18 模型网关可靠性
  → P0-22/P0-23/P0-24 持久化
  → P0-26/P0-27/P0-28 验证体系
  → P1 可观测性、评测、CI
  → P2 隔离执行和平台化
```

### 6.1 第一批建议实现项

如果下一轮直接开始编码，顺序建议是：

1. `P0-01` RunRuntime / RunState
2. `P0-02` 最大步数限制
3. `P0-03` 工具调用、时长和输出预算
4. `P0-04` 运行状态机和停止原因
5. `P0-10` 工具参数 JSON Schema 校验
6. `P0-11` 工具 timeout 和取消规范
7. `P0-06` ContextManager 基础版
8. `P0-19` Provider 可选注册和启动诊断
9. `P0-22` SessionRepository 接口
10. `P0-23` SQLite 持久化

原因：这组任务先解决“会不会失控、会不会撑爆、失败后能不能知道、工具是否可信、进程重启后是否丢数据”五个最重要问题。

---

## 7. 每次实现后的更新模板

完成某一项后，在该项表格的“状态”改为 `✅ 已实现`，并在下方追加证据：

```markdown
### P0-XX 实现记录

- 状态：✅ 已实现
- 实现日期：YYYY-MM-DD
- 实现文件：`src/...`
- 测试文件：`test/...`
- 验收命令：`pnpm test`、`pnpm check`
- 验证结果：`N/N` tests passed；类型检查通过
- 备注：说明边界、未覆盖内容或后续依赖
```

如果实现过程中发现原验收标准不合理，先保留原 ID，再在备注中记录调整理由，不要删除历史记录。
