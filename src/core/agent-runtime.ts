// src/core/agent-runtime.ts

import type { AgentLoop, AgentRunOptions } from './agent-loop-runtime.js';

/**
 * Agent 的最小公开形态。
 *
 * Agent 自己不负责“思考循环”，它只是一个句柄：
 * 保存身份、会话和模型信息，并把 send() 委托给 AgentLoop。
 */
export interface Agent {
  id: string;
  name: string;
  sessionId: string;
  model: string;
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
  // key 是 Agent ID，value 是 Agent 句柄。
  private agents = new Map<string, Agent>();

  /**
   * 注册一个已有 Agent。
   *
   * 返回 disposer，调用它可以撤销本次注册。
   */
  register(agent: Agent): () => void {
    if (!agent || !agent.id) {
      throw new Error('agent.id is required');
    }
    if (typeof agent.send !== 'function') {
      throw new Error(`agent.send must be a function for "${agent.id}"`);
    }
    if (this.agents.has(agent.id)) {
      throw new Error(`agent "${agent.id}" already registered`);
    }

    this.agents.set(agent.id, agent);

    // disposer 是一次性的清理函数。
    let disposed = false;
    return () => {
      if (disposed) return;

      // 用引用比较，避免误删后来注册的同 ID 对象。
      if (this.agents.get(agent.id) === agent) {
        this.agents.delete(agent.id);
      }
      disposed = true;
    };
  }

  /**
   * 创建并注册一个 Agent。
   */
  create(options: CreateAgentOptions): Agent {
    if (!options?.sessionId) {
      throw new Error('sessionId is required');
    }
    if (!options.model) {
      throw new Error('model is required');
    }
    if (!options.loop || typeof options.loop.run !== 'function') {
      throw new Error('loop must have a run method');
    }

    const id = globalThis.crypto.randomUUID();
    const loop = options.loop;

    // 先声明变量，再在 send 闭包中引用它。
    // 这样 send 被调用时拿到的就是完整 Agent 对象。
    const agent: Agent = {
      id,
      name: options.name ?? 'default',
      sessionId: options.sessionId,
      model: options.model,

      // Agent 不实现循环，只把请求转交给 Loop。
      send: (input, runOptions) => loop.run(agent, input, runOptions),
    };

    // create 创建出来的 Agent 默认立即进入注册表。
    this.register(agent);
    return agent;
  }

  /**
   * 返回所有已经注册的 Agent。
   */
  list(): Agent[] {
    return Array.from(this.agents.values());
  }
}
