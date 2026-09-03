// src/plugins/agent-loop.ts

import { Service } from '@deepseek-ai/cordis';
import {
  AgentLoopRuntime,
  type AgentLoopDependencies,
  type AgentRunOptions,
} from '../core/agent-loop-runtime.js';
import type { Agent } from '../core/agent-runtime.js';

/**
 * Agent Loop 依赖的 Cordis 服务名称。
 *
 * Cordis 会等 sessions、systemPrompt、tools、llm 都准备好后，
 * 才创建 AgentLoopService。
 */
export const inject = ['sessions', 'systemPrompt', 'tools', 'llm'];

export class AgentLoopService extends Service {
  // 除了插件对象上的 inject，类本身也声明一次依赖。
  // 这样直接把 AgentLoopService 作为 class plugin 加载时也能生效。
  static inject = inject;

  private runtime: AgentLoopRuntime;

  constructor(ctx: any) {
    super(ctx, 'agentLoop');

    const dependencies: AgentLoopDependencies = {
      sessions: ctx.sessions,
      systemPrompt: ctx.systemPrompt,
      tools: ctx.tools,
      llm: ctx.llm,
    };
    this.runtime = new AgentLoopRuntime(dependencies);
  }

  /**
   * Service 层只暴露 run。
   *
   * 具体的循环、工具执行和事件记录都留在 core runtime 中。
   */
  run(agent: Agent, input: string, options?: AgentRunOptions): Promise<string> {
    return this.runtime.run(agent, input, options);
  }
}

export const name = 'mini-agent-loop';

export function apply(ctx: any) {
  ctx.plugin(AgentLoopService);
}
