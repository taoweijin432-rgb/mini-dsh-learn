// src/core/agent-loop-runtime.ts

import type { Agent } from './agent-runtime.js';
import type { ChatRequest, ChatResponse, LlmRuntime } from './llm-runtime.js';
import type { SystemPromptRuntime } from './system-prompt-runtime.js';
import type { SessionRuntime } from './session-runtime.js';
import type {
  ExecutionResult,
  ToolRuntime,
} from './tool-runtime.js';

/**
 * Agent Loop 运行时需要的取消和流式回调。
 */
export interface AgentRunOptions {
  signal?: AbortSignal;
  onReasoning?: (chunk: string) => void;
  onContent?: (chunk: string) => void;
  onToolCall?: (call: AgentToolCall) => void;
  onToolResult?: (result: AgentToolResult) => void;
}

/**
 * 模型要求调用工具时的一条调用指令。
 */
export interface AgentToolCall {
  id: string;
  name: string;
  arguments: any;
}

/**
 * 发送给 onToolResult 的信息。
 *
 * 它在原始 ExecutionResult 上增加工具名称、调用 ID，
 * 以及已经适合写入 Session 的字符串结果。
 */
export type AgentToolResult = ExecutionResult & {
  name: string;
  toolCallId: string;
  renderedContent: string;
};

/**
 * Agent Loop 的依赖。
 *
 * Loop 本身不创建这些对象，而是由外部注入，
 * 这样测试时可以传入 mock，生产环境再传入真实实现。
 */
export interface AgentLoopDependencies {
  sessions: SessionRuntime;
  systemPrompt: SystemPromptRuntime;
  tools: ToolRuntime;
  llm: LlmRuntime;
}

/**
 * AgentRuntime 所需要的最小 Loop 接口。
 *
 * Agent 只知道“有一个 run 方法”，不需要知道 Loop 的内部细节。
 */
export interface AgentLoop {
  run(agent: Agent, input: string, options?: AgentRunOptions): Promise<string>;
}

/**
 * 取消时写入 Session 的工具结果。
 *
 * 不能只抛异常：
 * 如果 assistant/tool_calls 已经写入，但缺少对应的 tool/result，
 * 下一次把历史发送给模型时，消息结构就不完整了。
 */
export const CANCELLED_RESULT =
  'ToolError: the run was cancelled before this tool ran';

/**
 * Agent Loop：整个 Agent 的核心循环。
 *
 * 每一轮的流程是：
 *
 * 1. 重新组装 system prompt；
 * 2. 从 Session 事件日志投影 messages；
 * 3. 调用 LLM；
 * 4. 如果模型返回工具调用，就全部执行；
 * 5. 把工具结果写回 Session；
 * 6. 回到第 1 步，直到模型不再要求调用工具。
 */
export class AgentLoopRuntime implements AgentLoop {
  private readonly sessions: SessionRuntime;
  private readonly systemPrompt: SystemPromptRuntime;
  private readonly tools: ToolRuntime;
  private readonly llm: LlmRuntime;

  constructor(dependencies: AgentLoopDependencies) {
    this.sessions = dependencies.sessions;
    this.systemPrompt = dependencies.systemPrompt;
    this.tools = dependencies.tools;
    this.llm = dependencies.llm;
  }

  /**
   * 执行一次完整的 Agent 请求。
   */
  async run(
    agent: Agent,
    input: string,
    {
      signal,
      onReasoning,
      onContent,
      onToolCall,
      onToolResult,
    }: AgentRunOptions = {}
  ): Promise<string> {
    const sessionId = agent.sessionId;

    // 用户输入是整个事件链的起点。
    this.sessions.append(sessionId, 'user/message', { content: input });

    let step = 0;

    // 学习版故意不设置 maxSteps。
    // 正常结束条件只有：模型不再返回 toolCalls。
    while (true) {
      step += 1;

      // 每次进入模型前都检查取消状态。
      if (signal?.aborted) {
        throw new Error('Agent run cancelled');
      }

      // system prompt 必须每一步重新组装，
      // 因为它可能包含当前时间、会话状态等动态内容。
      const system = await this.systemPrompt.assemble({
        agent,
        sessionId,
        step,
      });

      // 不直接拼消息，而是从 Session 的事件日志重新投影。
      const messages = this.sessions.deriveMessages(sessionId);

      // ChatRequest 允许携带额外字段，model 会在 LlmRuntime 内部补上。
      const request: ChatRequest = {
        system,
        messages,
        tools: this.tools.schemas(),
        signal,
        onReasoning,
        onContent,
      };
      const response: ChatResponse = await this.llm.chat(request, agent.model);

      const toolCalls = (response.toolCalls ?? []) as AgentToolCall[];

      // 没有工具调用，说明模型已经给出最终回答。
      if (toolCalls.length === 0) {
        const content = response.content ?? '';
        this.sessions.append(sessionId, 'assistant/message', { content });
        return content;
      }

      // 先完整记录 assistant 的工具调用消息。
      // reasoningContent 必须和本轮 toolCalls 一起保存。
      this.sessions.append(sessionId, 'assistant/tool_calls', {
        content: response.content ?? null,
        reasoningContent: response.reasoningContent,
        toolCalls,
      });

      // 这里不能在工具循环中途直接 throw。
      // 否则剩余 tool_call 没有对应的 tool/result，历史就会损坏。
      let cancelled = false;

      // 一轮模型可能同时要求多个工具，必须全部处理完再回模型。
      for (const call of toolCalls) {
        // 如果上一个工具执行期间触发了取消，
        // 当前以及后续调用都不再真正执行。
        cancelled ||= Boolean(signal?.aborted);

        if (cancelled) {
          // 为每个未执行的调用补一条取消结果，保持日志配对。
          this.sessions.append(sessionId, 'tool/result', {
            toolCallId: call.id,
            name: call.name,
            isError: true,
            content: CANCELLED_RESULT,
          });
          continue;
        }

        // 通知 UI 或 CLI：准备执行哪一个工具。
        onToolCall?.(call);

        // ToolRuntime 会负责找到工具、执行函数并统一捕获错误。
        const result = await this.tools.execute(call.name, call.arguments, {
          signal,
          sessionId,
          toolCallId: call.id,
          agent,
        });

        // 模型下一轮需要文本，所以把内容块渲染成字符串。
        const renderedContent = this.tools.renderResult(result);
        const toolResult: AgentToolResult = {
          ...result,
          renderedContent,
          name: call.name,
          toolCallId: call.id,
        };

        // 通知 UI 或 CLI：工具已经返回结果。
        onToolResult?.(toolResult);

        // 工具结果必须和 tool_call_id 对应，模型才能继续理解历史。
        this.sessions.append(sessionId, 'tool/result', {
          toolCallId: call.id,
          name: call.name,
          isError: result.isError,
          content: renderedContent,
        });
      }

      // 所有工具调用都已经写入日志后，才真正结束本次取消。
      if (cancelled) {
        throw new Error('Agent run cancelled');
      }
    }
  }
}
