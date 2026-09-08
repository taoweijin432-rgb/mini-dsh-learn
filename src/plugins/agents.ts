// src/plugins/agents.ts
// 插件层只负责把普通 TypeScript Runtime 接到 Cordis Context 上。

// Service 是运行时需要的真实值，因此使用普通 import。
import { Service } from '@deepseek-ai/cordis';
import {
  AgentRuntime,
  // Agent 和 CreateAgentOptions 只用于类型检查，不会进入编译后的 JS。
  type Agent,
  type CreateAgentOptions,
} from '../core/agent-runtime.js';

/**
 * Cordis 服务层对 AgentRuntime 的薄封装。
 *
 * Runtime 负责业务逻辑，Service 负责把它挂到 ctx.agents。
 */
export class AgentsService extends Service {
  // 真正的 Agent 管理逻辑仍然由 core/AgentRuntime 完成。
  private runtime: AgentRuntime;

  constructor(ctx: any) {
    // super 会把这个服务注册到 ctx.agents。
    super(ctx, 'agents');

    // Service 只持有一个 Runtime 实例，自己不复制注册/创建逻辑。
    this.runtime = new AgentRuntime();
  }

  /**
   * 把“注册已有 Agent”的请求原样转发给 core Runtime。
   */
  register(agent: Agent): () => void {
    return this.runtime.register(agent);
  }

  /**
   * 创建并注册 Agent；返回值就是 core Runtime 创建的 Agent 句柄。
   */
  create(options: CreateAgentOptions): Agent {
    return this.runtime.create(options);
  }

  /**
   * 列出当前内存中的全部 Agent。
   */
  list(): Agent[] {
    return this.runtime.list();
  }
}

// Cordis 用这个名字标识插件，而服务挂载名仍然是上面的 agents。
export const name = 'mini-agents';

// apply 是插件入口：让 Cordis 加载 AgentsService。
export function apply(ctx: any) {
  ctx.plugin(AgentsService);
}
