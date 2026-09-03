// src/plugins/system-prompt.ts
import { Service } from '@deepseek-ai/cordis';
import { SystemPromptRuntime, AssembleContext } from '../core/system-prompt-runtime.js';

export class SystemPromptService extends Service {
  private runtime: SystemPromptRuntime;

  constructor(ctx: any) {
    super(ctx, 'systemPrompt');
    this.runtime = new SystemPromptRuntime();
  }

  section(fragment: any) {
    return this.runtime.section(fragment);
  }
  context(fragment: any) {
    return this.runtime.context(fragment);
  }
  assemble(ctx: AssembleContext = {}) {
    return this.runtime.assemble(ctx);
  }
  inspect() {
    return this.runtime.inspect();
  }
}

export const name = 'mini-system-prompt';
export function apply(ctx: any) {
  ctx.plugin(SystemPromptService);
}