// src/core/llm-runtime.ts

/**
 * 发给大模型适配器的请求。
 *
 * 可以把它理解成“统一格式的快递单”：
 * 不管底层接的是 DeepSeek、OpenAI 还是本地模型，
 * Runtime 都先把请求整理成这个格式，再交给对应的适配器。
 */
export interface ChatRequest {
  system?: string; // 系统提示词：告诉模型应该如何工作
  messages: any[]; // 对话历史，例如 user、assistant、tool 消息
  tools?: any[]; // 可供模型调用的工具目录
  signal?: AbortSignal; // 取消信号，例如用户按下 Ctrl+C
  onReasoning?: (chunk: string) => void; // 流式接收模型的思考过程
  onContent?: (chunk: string) => void; // 流式接收模型的普通回答

  // 允许继续携带 temperature、max_tokens 等供应商特有参数。
  [key: string]: any;
}

/**
 * Runtime 对外返回的统一响应。
 *
 * 不同模型厂商返回的数据结构可能不同，
 * 这里先统一成项目自己的格式，Agent 就不必关心供应商细节。
 */
export interface ChatResponse {
  content?: string | null; // 模型最终回答
  reasoningContent?: string; // DeepSeek 等模型可能返回的思考内容
  toolCalls?: Array<{
    id: string; // 这次工具调用的唯一 ID
    name: string; // 工具名称
    arguments: any; // 工具参数
  }>;
}

/**
 * 大模型适配器。
 *
 * 适配器是“翻译员”：Runtime 使用统一的 ChatRequest 调用它，
 * 适配器负责把请求翻译成某个具体厂商 SDK 需要的格式。
 */
export interface ModelAdapter {
  models: string[]; // 这个适配器支持的模型名称，例如 ['deepseek-chat']
  chat: (request: ChatRequest) => Promise<ChatResponse>; // 实际发起模型请求
}

/**
 * Provider 注册信息。
 *
 * provider 是厂商或后端的名字，例如 deepseek、openai、local。
 * 一个 provider 下面可以有多个模型。
 */
type ProviderRegistration = {
  adapter: ModelAdapter;
  defaultModel?: string; // 这个 provider 自己希望优先使用的模型
};

/**
 * LLM Runtime：统一管理模型供应商，并负责路由聊天请求。
 *
 * 使用流程：
 * 1. register('mock', adapter) 注册一个供应商；
 * 2. models() 查看所有 provider/model；
 * 3. chat(request, 'mock/fast') 指定模型发起请求；
 * 4. register 返回的 disposer 可以撤销这次注册。
 */
export class LlmRuntime {
  // key 是 provider 名称，value 是这个 provider 的适配器和默认模型。
  private providers = new Map<string, ProviderRegistration>();

  // 记录默认目标，格式固定为 "provider/model"。
  // 没有任何 provider 时，它是 null。
  private _defaultSelection: string | null = null;

  /**
   * 注册一个模型供应商。
   *
   * 返回的函数叫 disposer，可以理解为“撤销注册按钮”。
   * 这样插件卸载时就能把自己注册的 provider 清理掉。
   */
  register(
    provider: string,
    adapter: ModelAdapter,
    options?: { defaultModel?: string }
  ): () => void {
    // 尽早校验输入，避免错误配置一直隐藏到真正调用模型时才暴露。
    if (!provider) throw new Error('provider name is required');
    if (this.providers.has(provider)) {
      throw new Error(`provider "${provider}" already registered`);
    }
    if (!adapter || typeof adapter.chat !== 'function') {
      throw new Error(`adapter must have a chat method for provider "${provider}"`);
    }
    if (!adapter.models || adapter.models.length === 0) {
      throw new Error(`adapter must declare at least one model for "${provider}"`);
    }

    // 通过校验后，把 provider 保存到注册表中。
    this.providers.set(provider, {
      adapter,
      defaultModel: options?.defaultModel,
    });

    // 第一个注册的 provider 自动成为全局默认 provider。
    if (this._defaultSelection === null) {
      // 调用方指定 defaultModel 就用它，否则使用模型列表中的第一个。
      const defaultModel = options?.defaultModel ?? adapter.models[0];
      this._defaultSelection = `${provider}/${defaultModel}`;
    }

    let disposed = false;
    return () => {
      // disposer 可以被重复调用，但第二次调用不应产生副作用。
      if (disposed) return;

      // 删除 provider。
      this.providers.delete(provider);

      // 如果删除的恰好是当前默认 provider，就重新挑选一个默认值。
      if (this._defaultSelection?.startsWith(`${provider}/`)) {
        this._defaultSelection = this.computeDefaultSelection();
      }
      disposed = true;
    };
  }

  /**
   * 从当前注册表中重新计算默认模型。
   *
   * Map 会按照注册顺序遍历，所以这里选择剩余 provider 中的第一个。
   */
  private computeDefaultSelection(): string | null {
    for (const [provider, reg] of this.providers) {
      const model = reg.defaultModel ?? reg.adapter.models[0];
      return `${provider}/${model}`;
    }
    // 所有 provider 都被删除时，没有默认模型。
    return null;
  }

  /**
   * 列出所有可用模型。
   *
   * 返回的字符串统一使用 "provider/model" 格式，
   * 这样 CLI 或 Agent 可以直接把它当作模型选择值使用。
   */
  models(): string[] {
    const result: string[] = [];
    for (const [provider, reg] of this.providers) {
      for (const model of reg.adapter.models) {
        result.push(`${provider}/${model}`);
      }
    }
    return result;
  }

  /**
   * 返回当前默认的 "provider/model"。
   */
  defaultSelection(): string | null {
    return this._defaultSelection;
  }

  /**
   * 判断一个模型选择值是否有效。
   *
   * Agent Loop 或 CLI 在真正调用模型前可以先调用它，
   * 这样用户输入错误时可以立即提示，而不是等到网络请求时才失败。
   */
  has(selection: string): boolean {
    const { provider, model } = this.parseSelection(selection);
    const reg = this.providers.get(provider);
    if (!reg) return false;

    // 按当前接口 models 必然存在；这个判断保留了对宽松运行时对象的兼容。
    if (!reg.adapter.models) return true;
    return reg.adapter.models.includes(model);
  }

  /**
   * 发起聊天请求。
   *
   * selection 不传时使用默认模型；
   * 传入时必须是 "provider/model"，例如 "deepseek/deepseek-chat"。
   */
  async chat(request: ChatRequest, selection?: string): Promise<ChatResponse> {
    // ?? 表示只有 selection 为 null/undefined 时才使用默认值。
    const target = selection ?? this._defaultSelection;
    if (!target) {
      throw new Error('No provider registered, cannot call chat');
    }

    // 把一个字符串拆成 provider 和 model 两部分。
    const { provider, model } = this.parseSelection(target);
    const reg = this.providers.get(provider);
    if (!reg) {
      throw new Error(`Provider "${provider}" not found`);
    }

    // 适配器只需要真正的 model 名称，不需要知道 "provider/model" 这个组合写法。
    const adapterRequest = { ...request, model };
    return await reg.adapter.chat(adapterRequest);
  }

  /**
   * 解析 "provider/model" 字符串。
   *
   * 这是内部方法，所以不直接暴露给外部；
   * 但所有模型选择都经过这里，能保证格式检查只有一份。
   */
  private parseSelection(selection: string): { provider: string; model: string } {
    if (typeof selection !== 'string') {
      throw new Error('selection must be a string in format "provider/model"');
    }

    const parts = selection.split('/');
    if (parts.length !== 2) {
      throw new Error(`invalid selection format: "${selection}", expected "provider/model"`);
    }

    const [provider, model] = parts;
    if (!provider || !model) {
      throw new Error(`invalid selection: provider and model must be non-empty, got "${selection}"`);
    }
    return { provider, model };
  }
}
