// src/plugins/tools.ts
import { Service } from '@deepseek-ai/cordis';
import { ToolRuntime, ToolDefinition, ExecutionContext, ExecutionResult } from '../core/tool-runtime.js';

export class ToolsService extends Service {
  private runtime: ToolRuntime;

  constructor(ctx: any) {
    super(ctx, 'tools');
    this.runtime = new ToolRuntime();
  }

  register(definition: ToolDefinition) {
    return this.runtime.register(definition);
  }
  get(name: string) {
    return this.runtime.get(name);
  }
  list() {
    return this.runtime.list();
  }
  schemas() {
    return this.runtime.schemas();
  }
  execute(name: string, args: any, exec?: Partial<ExecutionContext>) {
    return this.runtime.execute(name, args, exec);
  }
  renderResult(result: ExecutionResult) {
    return this.runtime.renderResult(result);
  }
}

export const name = 'mini-tools';
export function apply(ctx: any) {
  ctx.plugin(ToolsService);
}