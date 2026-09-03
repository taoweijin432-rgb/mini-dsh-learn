// src/core/tool-runtime.ts

/**
 * 工具输出中的一段内容。
 *
 * 这里没有直接使用 string，是因为大模型 API 往往使用 content block：
 * 当前先支持文本，未来可以扩展图片、文件等类型。
 */
export type ContentBlock = { type: 'text'; text: string };

/**
 * 工具执行时能拿到的上下文。
 */
export interface ExecutionContext {
  signal: AbortSignal; // 用于取消执行，例如用户按 Esc 或 Ctrl+C
  sessionId?: string; // 当前会话 ID，工具可以据此读取会话上下文
  toolCallId?: string; // 本次调用的唯一 ID，便于日志关联
  agent?: any; // 当前 Agent 实例，暂时保留给高级用法
}

/**
 * 工具执行完成后，Runtime 统一返回的结果。
 */
export interface ExecutionResult {
  value: any; // execute 函数返回的原始值，供程序继续处理
  content: ContentBlock[]; // 转换后的内容，供模型、日志或 UI 使用
  isError: boolean; // 是否执行失败
}

/**
 * 一个工具的完整定义。
 */
export interface ToolDefinition {
  name: string; // 唯一名称，模型会通过它发起调用
  description?: string; // 给模型看的工具说明
  parameters?: Record<string, any>; // JSON Schema，描述工具需要哪些参数

  // 真正执行工具的函数，可以同步返回，也可以异步返回 Promise。
  execute: (args: any, ctx: ExecutionContext) => any | Promise<any>;

  // 可选的第一次渲染：把原始 value 转成字符串或多个内容块。
  output?: {
    render?: (
      args: any,
      value: any
    ) => string | ContentBlock[] | Promise<string | ContentBlock[]>;
  };

  // 可选的最后加工：在成功结果即将返回前修改 content。
  finalizeContent?: (
    ctx: ExecutionContext,
    result: ExecutionResult
  ) => ContentBlock[] | Promise<ContentBlock[]>;
}

/**
 * 工具运行时。
 *
 * 它只负责工具的通用生命周期：
 * 注册 -> 展示给模型 -> 执行 -> 格式化结果 -> 返回。
 * 具体工具是什么（搜索、读文件、执行命令）由外部注册进来。
 */
export class ToolRuntime {
  // key 是工具名，value 是工具定义。
  private tools = new Map<string, ToolDefinition>();

  /**
   * 注册工具，返回 disposer 函数。
   */
  register(definition: ToolDefinition): () => void {
    // 1. 先校验，错误尽快暴露。
    if (!definition.name) throw new Error('tool.name is required');
    if (typeof definition.execute !== 'function') {
      throw new Error(`tool.execute must be a function for "${definition.name}"`);
    }
    if (this.tools.has(definition.name)) {
      throw new Error(`tool "${definition.name}" is already registered`);
    }

    // 2. 放入工具注册表。
    this.tools.set(definition.name, definition);

    // 3. 返回撤销函数，便于插件卸载或测试清理。
    let disposed = false;
    return () => {
      // 重复调用 disposer 不会重复删除，也不会报错。
      if (disposed) return;

      // 只有 Map 中仍然是同一个 definition 时才删除，
      // 避免误伤后来注册的同名对象。
      if (this.tools.get(definition.name) === definition) {
        this.tools.delete(definition.name);
      }
      disposed = true;
    };
  }

  /**
   * 按名称查找工具。
   *
   * 找不到时返回 undefined，由调用方决定如何处理。
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * 返回所有已注册工具。
   */
  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * 生成给大模型看的工具目录。
   *
   * 模型不会读取 execute 函数本身，
   * 它只能看到 name、description 和 parameters，
   * 然后根据这些信息决定是否调用工具。
   */
  schemas(): Array<{
    type: 'function';
    function: { name: string; description?: string; parameters?: any };
  }> {
    const result: Array<any> = [];

    for (const def of this.tools.values()) {
      result.push({
        type: 'function',
        function: {
          name: def.name,
          description: def.description,
          parameters: def.parameters,
        },
      });
    }
    return result;
  }

  /**
   * 执行工具并统一处理结果。
   */
  async execute(
    name: string,
    args: any,
    exec: Partial<ExecutionContext> = {}
  ): Promise<ExecutionResult> {
    // 情况 1：工具不存在。
    // 这里返回结构化错误，而不是抛异常，方便 Agent 把错误继续告诉模型。
    const def = this.tools.get(name);
    if (!def) {
      return {
        value: null,
        content: [{ type: 'text', text: `Tool "${name}" not found` }],
        isError: true,
      };
    }

    // 如果调用方没有传 signal，就创建一个默认的、不会主动取消的 signal。
    const signal = exec.signal ?? new AbortController().signal;
    const fullCtx: ExecutionContext = {
      signal,
      sessionId: exec.sessionId,
      toolCallId: exec.toolCallId,
      agent: exec.agent,
    };

    try {
      // 第一步：执行工具本身。
      const value = await def.execute(args, fullCtx);

      // 第二步：把原始返回值转换成模型能理解的内容块。
      let content: ContentBlock[];

      if (def.output?.render) {
        // 工具提供了自定义渲染器，优先使用它。
        const rendered = await def.output.render(args, value);

        if (typeof rendered === 'string') {
          content = [{ type: 'text', text: rendered }];
        } else if (Array.isArray(rendered)) {
          // 允许一次返回多个内容块。
          content = rendered;
        } else {
          // 防御性兜底：尽量把意外返回值转成文本。
          content = [{ type: 'text', text: JSON.stringify(rendered) }];
        }
      } else {
        // 没有自定义渲染器时：
        // 字符串原样返回，其他值使用格式化 JSON，便于人阅读。
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        content = [{ type: 'text', text }];
      }

      // 第三步：先构造一个成功结果。
      const result: ExecutionResult = { value, content, isError: false };

      // 第四步：如果定义了 finalizeContent，允许做最后一次加工。
      // 例如追加耗时、状态码或统一的元信息。
      if (def.finalizeContent) {
        const finalized = await def.finalizeContent(fullCtx, result);
        result.content = finalized;
      }

      return result;
    } catch (err: any) {
      // execute、render、finalizeContent 任意一步失败，
      // 都转换成统一的错误结果，让上层不必为每一步分别 try/catch。
      return {
        value: null,
        content: [{ type: 'text', text: `Error: ${err.message || String(err)}` }],
        isError: true,
      };
    }
  }

  /**
   * 把内容块拼成普通字符串，方便日志或 UI 显示。
   */
  renderResult(result: ExecutionResult): string {
    return result.content.map(block => block.text).join('');
  }
}
