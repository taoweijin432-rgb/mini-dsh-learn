// src/core/agent-runtime.ts
// 这个文件只负责“Agent 句柄的创建和管理”，不负责模型/工具循环。

// import type 只参与 TypeScript 类型检查，编译后不会产生运行时代码。
import type { AgentLoop, AgentRunOptions } from './agent-loop-runtime.js';

/**
 * Agent 的最小公开形态。
 *
 * Agent 自己不负责“思考循环”，它只是一个句柄：
 * 保存身份、会话和模型信息，并把 send() 委托给 AgentLoop。
 */
export interface Agent {
  // Runtime 自动生成的唯一标识，用于在注册表中区分不同 Agent。
  id: string;

  // 给人看的名字；它不参与模型路由，也不要求唯一。
  name: string;

  // Agent 的全部对话事件都会写入这个 Session。
  sessionId: string;

  // 完整模型名，格式是 provider/model，例如 mock/demo。
  model: string;

  // 对外入口。这里返回最终文本，但真正的循环由 AgentLoop.run() 完成。
  send(input: string, options?: AgentRunOptions): Promise<string>;
}

/**
 * 创建 Agent 时需要的参数。
 */
export interface CreateAgentOptions {
  sessionId: string; // Agent 要使用哪一个会话
  model: string; // 使用哪个 provider/model，例如 mock/demo
  loop: AgentLoop; // 真正负责运行 Agent Loop 的对象
  name?: string; // 可选的人类可读名称
}

/**
 * Agent Runtime 只负责管理 Agent 句柄。
 *
 * 重要边界：
 * - 这里不写 while 循环；
 * - 这里不直接执行工具；
 * - 这里不直接调用 LLM。
 *
 * 这些工作全部交给 AgentLoopRuntime。
 */
export class AgentRuntime {
  // Map 的 key 是 Agent ID，value 是完整 Agent 句柄。
  // 注册表只保存在内存中，程序退出后不会自动持久化。
  private agents = new Map<string, Agent>();

  /**
   * 注册一个已有 Agent。
   *
   * 返回 disposer，调用它可以撤销本次注册。
   */
  register(agent: Agent): () => void {
    // 尽早检查 ID，避免把一个无法索引的对象放进 Map。
    if (!agent || !agent.id) {
      throw new Error('agent.id is required');
    }

    // TypeScript 类型只能约束正常的 TS 调用者；运行时仍要防御非法对象。
    if (typeof agent.send !== 'function') {
      throw new Error(`agent.send must be a function for "${agent.id}"`);
    }

    // 同一个 ID 只能注册一次，否则后注册的对象会悄悄覆盖旧对象。
    if (this.agents.has(agent.id)) {
      throw new Error(`agent "${agent.id}" already registered`);
    }

    // 所有校验都通过后，才真正修改注册表。
    this.agents.set(agent.id, agent);

    // disposer 是一次性的清理函数。
    // 它通过闭包记住本次注册的 agent 和 disposed 状态。
    let disposed = false;
    return () => {
      // 允许调用者重复执行清理函数；第二次以后直接结束。
      if (disposed) return;

      // 用引用比较，避免误删后来注册的同 ID 对象。
      // “=== agent”比较的是对象本身，而不只是相同的字符串 ID。
      if (this.agents.get(agent.id) === agent) {
        this.agents.delete(agent.id);
      }

      // 无论 Map 中是否仍是旧对象，本 disposer 都已经完成自己的职责。
      disposed = true;
    };
  }

  /**
   * 创建并注册一个 Agent。
   */
  create(options: CreateAgentOptions): Agent {
    // sessionId 决定对话历史写到哪里，是 Agent 运行所需的最小信息。
    if (!options?.sessionId) {
      throw new Error('sessionId is required');
    }

    // 没有模型名时，LlmRuntime 无法选择 provider 和上游 model。
    if (!options.model) {
      throw new Error('model is required');
    }

    // 只要求对象有 run() 方法，而不是强制必须是 AgentLoopRuntime 实例。
    // 这样真实运行时和测试 mock 都可以实现同一个最小接口。
    if (!options.loop || typeof options.loop.run !== 'function') {
      throw new Error('loop must have a run method');
    }

    // UUID 由 Runtime 生成，调用者不需要自己管理 Agent ID。
    const id = globalThis.crypto.randomUUID();

    // 把 loop 保存到局部常量中，send 闭包会一直记住它。
    const loop = options.loop;

    // 先声明变量，再在 send 闭包中引用它。
    // 这样 send 被调用时拿到的就是完整 Agent 对象。
    const agent: Agent = {
      id,

      // ?? 只在 name 为 null/undefined 时使用默认值；空字符串会被保留。
      name: options.name ?? 'default',
      sessionId: options.sessionId,
      model: options.model,

      // Agent 不实现循环，只把请求转交给 Loop。
      // 箭头函数此时只是被保存，等以后调用 send() 才执行 loop.run()。
      send: (input, runOptions) => loop.run(agent, input, runOptions),
    };

    // create 创建出来的 Agent 默认立即进入注册表。
    // 因此 create() 返回后，list() 已经可以看到这个 Agent。
    this.register(agent);
    return agent;
  }

  /**
   * 返回所有已经注册的 Agent。
   */
  list(): Agent[] {
    // Map.values() 是迭代器；Array.from() 把当前值复制成普通数组返回。
    // 返回数组而不是直接暴露 Map，可以避免调用者任意修改内部注册表。
    return Array.from(this.agents.values());
  }
}
