// src/plugins/agent-loop.ts
// 这个插件负责收集 Cordis 上的四个服务，并把它们注入 AgentLoopRuntime。

import { Service } from '@deepseek-ai/cordis';
import {
  AgentLoopRuntime,
  // 下面两个名字只用于类型检查。
  type AgentLoopDependencies,
  type AgentRunOptions,
} from '../core/agent-loop-runtime.js';
import type { Agent } from '../core/agent-runtime.js';

/**
 * Agent Loop 依赖的 Cordis 服务名称。
 *
 * Cordis 会等 sessions、systemPrompt、tools、llm、runs 都准备好后，
 * 才创建 AgentLoopService。
 */
export const inject = ['sessions', 'systemPrompt', 'tools', 'llm', 'runs'];

export class AgentLoopService extends Service {
  // 除了插件对象上的 inject，类本身也声明一次依赖。
  // 这样直接把 AgentLoopService 作为 class plugin 加载时也能生效。
  static inject = inject;

  // 循环逻辑保留在 core Runtime，Service 只负责框架接入和方法转发。
  private runtime: AgentLoopRuntime;

  constructor(ctx: any) {
    // 把当前 Service 注册为 ctx.agentLoop。
    super(ctx, 'agentLoop');

    // 从 Cordis Context 中取出已经准备好的四个依赖。
    const dependencies: AgentLoopDependencies = {
      sessions: ctx.sessions,
      systemPrompt: ctx.systemPrompt,
      tools: ctx.tools,
      llm: ctx.llm,
      runs: ctx.runs,
    };

    // 将框架服务注入普通 TypeScript 类，核心代码因此不需要知道 Cordis。
    this.runtime = new AgentLoopRuntime(dependencies);
  }

  /**
   * Service 层只暴露 run。
   *
   * 具体的循环、工具执行和事件记录都留在 core runtime 中。
   */
  run(agent: Agent, input: string, options?: AgentRunOptions): Promise<string> {
    // 不在插件层增加循环逻辑，参数和返回值都原样转交。
    return this.runtime.run(agent, input, options);
  }
}

// Cordis 插件名；它和 ctx 上的服务键 agentLoop 是两个不同概念。
export const name = 'mini-agent-loop';

// 加载插件时，让 Cordis 实例化上面的 AgentLoopService。
export function apply(ctx: any) {
  ctx.plugin(AgentLoopService);
}
