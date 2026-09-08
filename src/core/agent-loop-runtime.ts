// src/core/agent-loop-runtime.ts
// 这个文件负责真正的 Agent Loop：问模型、执行工具、记录结果，再继续问模型。

// 下面全部是类型导入。真正的 Runtime 实例会从构造函数注入。
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
  // AbortSignal 是只读的取消状态；调用者通过 AbortController.abort() 触发它。
  signal?: AbortSignal;

  // 模型每流出一小段“推理文本”时调用，常用于实时显示思考过程。
  onReasoning?: (chunk: string) => void;

  // 模型每流出一小段“最终回答”时调用，常用于打字机效果。
  onContent?: (chunk: string) => void;

  // 每个工具真正开始执行前调用，方便 UI 显示“正在调用 xxx”。
  onToolCall?: (call: AgentToolCall) => void;

  // 每个工具完成并格式化结果后调用，方便 UI 展示执行结果。
  onToolResult?: (result: AgentToolResult) => void;
}

/**
 * 模型要求调用工具时的一条调用指令。
 */
export interface AgentToolCall {
  // 一次工具调用的唯一 ID；后面的 tool result 必须用相同 ID 与它配对。
  id: string;

  // ToolRuntime 中注册的工具名。
  name: string;

  // 模型为该工具生成的参数对象。
  arguments: any;
}

/**
 * 发送给 onToolResult 的信息。
 *
 * 它在原始 ExecutionResult 上增加工具名称、调用 ID，
 * 以及已经适合写入 Session 的字符串结果。
 */
export type AgentToolResult = ExecutionResult & {
  // 补上工具名，让回调接收者不必再根据 ID 反查工具。
  name: string;

  // 指向原始 AgentToolCall.id，用来关联“调用”和“结果”。
  toolCallId: string;

  // ToolRuntime 把内容块转成的字符串，可直接写入 Session 并发给模型。
  renderedContent: string;
};

/**
 * Agent Loop 的依赖。
 *
 * Loop 本身不创建这些对象，而是由外部注入，
 * 这样测试时可以传入 mock，生产环境再传入真实实现。
 */
export interface AgentLoopDependencies {
  // Session 是权威事件日志：既负责记录事件，也负责投影模型 messages。
  sessions: SessionRuntime;

  // 每一轮根据 Agent、Session 和 step 动态组装 system prompt。
  systemPrompt: SystemPromptRuntime;

  // 提供工具 schema、工具执行和结果渲染能力。
  tools: ToolRuntime;

  // 根据 agent.model 选择 provider/model，并发送 ChatRequest。
  llm: LlmRuntime;
}

/**
 * AgentRuntime 所需要的最小 Loop 接口。
 *
 * Agent 只知道“有一个 run 方法”，不需要知道 Loop 的内部细节。
 */
export interface AgentLoop {
  // 只暴露一个最小 run() 契约，使 AgentRuntime 不依赖具体实现类。
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
  // readonly 表示构造完成后不能把依赖替换成另一个 Runtime。
  private readonly sessions: SessionRuntime;
  private readonly systemPrompt: SystemPromptRuntime;
  private readonly tools: ToolRuntime;
  private readonly llm: LlmRuntime;

  constructor(dependencies: AgentLoopDependencies) {
    // 构造函数只“接线”，不在类内部 new 依赖。
    // 生产环境可以注入真实服务，测试则可以注入可控的 mock。
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
    // 第三个参数默认是空对象，所以 agent.send(input) 不传配置也能安全解构。
    {
      signal,
      onReasoning,
      onContent,
      onToolCall,
      onToolResult,
    }: AgentRunOptions = {}
  ): Promise<string> {
    // 后续所有事件都写入 Agent 绑定的同一个 Session。
    const sessionId = agent.sessionId;

    // 用户输入是整个事件链的起点。
    // 必须先写入，后面的 deriveMessages() 才能把本次问题发给模型。
    this.sessions.append(sessionId, 'user/message', { content: input });

    // step 从 0 开始，在每轮循环开头加 1，因此第一轮传给 prompt 的是 1。
    let step = 0;

    // 学习版故意不设置 maxSteps。
    // 正常结束条件只有：模型不再返回 toolCalls。
    while (true) {
      step += 1;

      // 每次进入模型前都检查取消状态。
      // 这里还没有为本轮写入 assistant/tool_calls，所以可以立即抛错。
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
      // 这样只维护一份权威历史，避免 events 和 messages 相互不一致。
      const messages = this.sessions.deriveMessages(sessionId);

      // ChatRequest 允许携带额外字段，model 会在 LlmRuntime 内部补上。
      const request: ChatRequest = {
        system,
        messages,

        // schemas() 只把工具说明交给模型，并不会在这里执行工具。
        tools: this.tools.schemas(),

        // 把同一个取消信号继续向下传给模型适配器。
        signal,

        // 模型产生流式片段时，LlmRuntime 会调用这两个回调。
        onReasoning,
        onContent,
      };

      // agent.model 的格式是 provider/model，由 LlmRuntime 完成模型路由。
      const response: ChatResponse = await this.llm.chat(request, agent.model);

      // 某些模型不返回 toolCalls 字段；?? [] 将 undefined 统一为空数组。
      const toolCalls = (response.toolCalls ?? []) as AgentToolCall[];

      // 没有工具调用，说明模型已经给出最终回答。
      if (toolCalls.length === 0) {
        // content 也可能缺失，学习版统一把它当作空字符串。
        const content = response.content ?? '';

        // 最终回答先写回 Session，再返回给 agent.send() 的调用者。
        this.sessions.append(sessionId, 'assistant/message', { content });
        return content;
      }

      // 先完整记录 assistant 的工具调用消息。
      // reasoningContent 必须和本轮 toolCalls 一起保存。
      // 内部字段叫 toolCalls，Session 投影成 API 消息时会变成 tool_calls。
      this.sessions.append(sessionId, 'assistant/tool_calls', {
        // 模型可能只返回工具调用而没有普通文字，此时使用 null。
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
        // ||= 会让 cancelled 一旦变成 true，就在剩余循环中一直保持 true。
        cancelled ||= Boolean(signal?.aborted);

        if (cancelled) {
          // 为每个未执行的调用补一条取消结果，保持日志配对。
          // 不能直接 break，否则更后面的 tool call 仍然没有结果。
          this.sessions.append(sessionId, 'tool/result', {
            toolCallId: call.id,
            name: call.name,
            isError: true,
            content: CANCELLED_RESULT,
          });

          // continue 会继续处理下一个调用，为它也补上取消结果。
          continue;
        }

        // 通知 UI 或 CLI：准备执行哪一个工具。
        // ?. 表示调用者没传回调时什么也不做。
        onToolCall?.(call);

        // ToolRuntime 会负责找到工具、执行函数并统一捕获错误。
        const result = await this.tools.execute(call.name, call.arguments, {
          // 把当前运行上下文交给工具；工具可以据此响应取消或记录关联信息。
          signal,
          sessionId,
          toolCallId: call.id,
          agent,
        });

        // 模型下一轮需要文本，所以把内容块渲染成字符串。
        const renderedContent = this.tools.renderResult(result);

        // ...result 复制 value、content、isError，再补充 Agent Loop 关心的字段。
        const toolResult: AgentToolResult = {
          ...result,
          renderedContent,
          name: call.name,
          toolCallId: call.id,
        };

        // 通知 UI 或 CLI：工具已经返回结果。
        // 这个回调只负责观察结果，不代替下面的 Session 记录。
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
      // 到这里，每个 tool call 都有真实结果或 CANCELLED_RESULT。
      if (cancelled) {
        throw new Error('Agent run cancelled');
      }

      // 没有 return、throw 时，while 会回到顶部，让模型读取刚写入的工具结果。
    }
  }
}
