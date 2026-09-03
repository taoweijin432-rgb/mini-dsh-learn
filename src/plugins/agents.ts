// src/plugins/agents.ts

import { Service } from '@deepseek-ai/cordis';
import {
  AgentRuntime,
  type Agent,
  type CreateAgentOptions,
} from '../core/agent-runtime.js';

/**
 * Cordis 服务层对 AgentRuntime 的薄封装。
 *
 * Runtime 负责业务逻辑，Service 负责把它挂到 ctx.agents。
 */
export class AgentsService extends Service {
  private runtime: AgentRuntime;

  constructor(ctx: any) {
    // super 会把这个服务注册到 ctx.agents。
    super(ctx, 'agents');
    this.runtime = new AgentRuntime();
  }

  register(agent: Agent): () => void {
    return this.runtime.register(agent);
  }

  create(options: CreateAgentOptions): Agent {
    return this.runtime.create(options);
  }

  list(): Agent[] {
    return this.runtime.list();
  }
}

export const name = 'mini-agents';

export function apply(ctx: any) {
  ctx.plugin(AgentsService);
}
