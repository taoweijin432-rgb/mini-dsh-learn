// src/core/agent-loop-runtime.ts
//
// Agent Loop 负责“问模型 → 执行工具 → 再问模型”。
// RunRuntime 负责这次运行的生命周期和边界，两者故意分开：
// Loop 关注业务步骤，Run 关注什么时候开始、什么时候必须停止、为什么结束。

import type { Agent } from './agent-runtime.js';
import type { ChatRequest, ChatResponse, LlmRuntime } from './llm-runtime.js';
import type { SystemPromptRuntime } from './system-prompt-runtime.js';
import type { SessionRuntime } from './session-runtime.js';
import {
  RunBoundaryError,
  type ActiveRun,
  type RunEndReason,
  type RunLimitsInput,
  type RunRegistry,
} from './run-runtime.js';
import type {
  ExecutionResult,
  ToolRuntime,
} from './tool-runtime.js';

/** Agent.send() 可以传入的运行级配置。 */
export interface AgentRunOptions {
  // AbortSignal 由调用者触发；RunRuntime 会把它纳入自己的生命周期信号。
  signal?: AbortSignal;

  // 一次运行的边界。未提供的字段使用 RunRuntime 默认值。
  limits?: RunLimitsInput;

  // 模型每流出一小段“推理文本”时调用。
  onReasoning?: (chunk: string) => void;

  // 模型每流出一小段“最终回答”时调用。
  onContent?: (chunk: string) => void;

  // 每个工具真正开始执行前调用。
  onToolCall?: (call: AgentToolCall) => void;

  // 每个工具完成并格式化结果后调用。
  onToolResult?: (result: AgentToolResult) => void;
}

/** 模型要求调用工具时的一条调用指令。 */
export interface AgentToolCall {
  id: string;
  name: string;
  arguments: any;
  runId?: string;
  traceId?: string;
  step?: number;
}

/** 发送给 onToolResult 的信息。 */
export type AgentToolResult = ExecutionResult & {
  name: string;
  toolCallId: string;
  renderedContent: string;
  runId?: string;
  traceId?: string;
  step?: number;
};

/** Agent Loop 的依赖。 */
export interface AgentLoopDependencies {
  // Session 是权威事件日志；模型 messages 从它投影出来。
  sessions: SessionRuntime;
  systemPrompt: SystemPromptRuntime;
  tools: ToolRuntime;
  llm: LlmRuntime;

  // RunRegistry 记录本次请求的边界和结束原因。
  runs: RunRegistry;
}

/** Agent 只需要知道 Loop 有一个 run 方法。 */
export interface AgentLoop {
  run(agent: Agent, input: string, options?: AgentRunOptions): Promise<string>;
}

/** 被取消且尚未执行的工具，必须写入配对结果。 */
export const CANCELLED_RESULT =
  'ToolError: the run was cancelled before this tool ran';

/** 因运行边界未执行的工具也要有结果，避免 assistant/tool 历史断裂。 */
export const BOUNDARY_RESULT =
  'ToolError: the run boundary stopped this tool before it ran';

/**
 * Agent Loop 的核心实现。
 *
 * 与真实 DSH 的对应关系：
 * - 本项目的 Run，大致对应 DSH 的一个 turn；
 * - 本项目的 step，对应“一个模型请求及其工具执行”；
 * - Session 的 run/step 事件，承担 DSH turn/step 事件的学习版职责。
 */
export class AgentLoopRuntime implements AgentLoop {
  private readonly sessions: SessionRuntime;
  private readonly systemPrompt: SystemPromptRuntime;
  private readonly tools: ToolRuntime;
  private readonly llm: LlmRuntime;
  private readonly runs: RunRegistry;

  constructor(dependencies: AgentLoopDependencies) {
    this.sessions = dependencies.sessions;
    this.systemPrompt = dependencies.systemPrompt;
    this.tools = dependencies.tools;
    this.llm = dependencies.llm;
    this.runs = dependencies.runs;
  }

  /** 执行一次完整的 Agent 请求，并保证 Run 最终一定关闭。 */
  async run(
    agent: Agent,
    input: string,
    {
      signal,
      limits,
      onReasoning,
      onContent,
      onToolCall,
      onToolResult,
    }: AgentRunOptions = {},
  ): Promise<string> {
    const sessionId = agent.sessionId;
    const run = this.runs.start({
      agentId: agent.id,
      sessionId,
      signal,
      limits,
    });

    // 先写生命周期事件，再写用户消息。
    // 这样恢复或审计时能明确知道这条消息属于哪次运行。
    this.sessions.append(sessionId, 'run/start', {
      runId: run.id,
      traceId: run.state.traceId,
      agentId: agent.id,
      limits: run.state.limits,
    });
    this.sessions.append(sessionId, 'user/message', {
      content: input,
      runId: run.id,
      traceId: run.state.traceId,
    });

    try {
      while (true) {
        // beginStep 会在进入模型前检查取消、超时和 maxSteps。
        const step = run.beginStep();
        this.sessions.append(sessionId, 'step/start', {
          runId: run.id,
          traceId: run.state.traceId,
          step,
        });

        let stepOutcome: 'completed' | 'stopped' | 'error' = 'stopped';
        try {
          const system = await this.systemPrompt.assemble({
            agent,
            sessionId,
            runId: run.id,
            traceId: run.state.traceId,
            step,
          });
          const messages = this.sessions.deriveMessages(sessionId);
          const request: ChatRequest = {
            system,
            messages,
            tools: this.tools.schemas(),
            // 使用 Run 自己的 signal，而不是裸的调用者 signal。
            // 这样 maxDurationMs、用户取消和未来 shutdown 都能进入同一条链路。
            signal: run.signal,
            // Provider 只负责产生片段，Run 负责决定片段是否还能继续向 UI 输出。
            onReasoning: chunk => {
              if (run.consumeOutput(chunk)) onReasoning?.(chunk);
            },
            onContent: chunk => {
              if (run.consumeOutput(chunk)) onContent?.(chunk);
            },
          };

          const response: ChatResponse = await this.llm.chat(request, agent.model);
          // 适配器可能没有及时响应 AbortSignal；返回后仍要再次检查 Run 边界。
          if (run.stopRequested) throw run.toError();
          const toolCalls = (response.toolCalls ?? []) as AgentToolCall[];

          if (toolCalls.length === 0) {
            const content = response.content ?? '';
            this.sessions.append(sessionId, 'assistant/message', {
              content,
              runId: run.id,
              traceId: run.state.traceId,
              step,
            });
            stepOutcome = 'completed';
            run.finish({ kind: 'completed' });
            return content;
          }

          this.sessions.append(sessionId, 'assistant/tool_calls', {
            content: response.content ?? null,
            reasoningContent: response.reasoningContent,
            toolCalls,
            runId: run.id,
            traceId: run.state.traceId,
            step,
          });

          // 必须遍历完整个 toolCalls：即使运行被取消，也要为每个调用补 result。
          let stoppedDuringTools = false;
          for (const rawCall of toolCalls) {
            const call: AgentToolCall = { ...rawCall, runId: run.id, traceId: run.state.traceId, step };

            if (run.stopRequested) {
              stoppedDuringTools = true;
              this.appendStoppedToolResult(sessionId, call, run);
              continue;
            }

            try {
              // 预算检查放在工具真正启动之前。
              run.consumeToolCall();
            } catch (error) {
              stoppedDuringTools = true;
              this.appendStoppedToolResult(sessionId, call, run);
              continue;
            }

            onToolCall?.(call);
            const result = await this.tools.execute(call.name, call.arguments, {
              signal: run.signal,
              sessionId,
              toolCallId: call.id,
              agent,
            });
            const renderedContent = this.tools.renderResult(result);
            const toolResult: AgentToolResult = {
              ...result,
              renderedContent,
              name: call.name,
              toolCallId: call.id,
              runId: run.id,
              traceId: run.state.traceId,
              step,
            };

            onToolResult?.(toolResult);
            this.sessions.append(sessionId, 'tool/result', {
              toolCallId: call.id,
              name: call.name,
              isError: result.isError,
              content: renderedContent,
              runId: run.id,
              traceId: run.state.traceId,
              step,
            });
          }

          if (stoppedDuringTools || run.stopRequested) {
            throw run.toError();
          }
          stepOutcome = 'completed';
        } catch (error) {
          stepOutcome = 'error';
          throw error;
        } finally {
          // 与真实 DSH 的 step/end 一样，即使模型或工具失败，也要关闭 step 边界。
          this.sessions.append(sessionId, 'step/end', {
            runId: run.id,
            traceId: run.state.traceId,
            step,
            outcome: stepOutcome,
          });
        }
      }
    } catch (error) {
      const reason = run.reasonFor(error);
      run.finish(reason);
      // 对边界类错误统一使用稳定消息；普通模型/工具错误保留原始错误。
      if (reason.kind !== 'error') throw run.toError();
      throw error;
    } finally {
      if (!run.isFinished) {
        // 理论上的最后保险：任何未来新增的 return/throw 分支都不能留下开放 Run。
        run.finish(run.reasonFor(new Error('run ended without an explicit result')));
      }

      const state = run.state;
      this.sessions.append(sessionId, 'run/end', {
        runId: run.id,
        traceId: state.traceId,
        status: state.status,
        reason: state.stopReason,
        currentStep: state.currentStep,
        toolCalls: state.toolCalls,
        outputBytes: state.outputBytes,
      });
    }
  }

  /** 为未执行的 tool call 写入与 assistant/tool_calls 配对的结果。 */
  private appendStoppedToolResult(
    sessionId: string,
    call: AgentToolCall,
    run: ActiveRun,
  ): void {
    const content = run.stopReason?.kind === 'cancelled'
      ? CANCELLED_RESULT
      : BOUNDARY_RESULT;

    this.sessions.append(sessionId, 'tool/result', {
      toolCallId: call.id,
      name: call.name,
      isError: true,
      content,
      runId: run.id,
      traceId: run.state.traceId,
      step: call.step,
    });
  }
}
