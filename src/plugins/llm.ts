// src/plugins/llm.ts
import { Service } from '@deepseek-ai/cordis';
import { LlmRuntime, ChatRequest, ChatResponse } from '../core/llm-runtime.js';

export class LlmService extends Service {
  private runtime: LlmRuntime;

  constructor(ctx: any) {
    super(ctx, 'llm');
    this.runtime = new LlmRuntime();
  }

  register(provider: string, adapter: any, options?: { defaultModel?: string }) {
    return this.runtime.register(provider, adapter, options);
  }
  models() {
    return this.runtime.models();
  }
  defaultSelection() {
    return this.runtime.defaultSelection();
  }
  has(selection: string) {
    return this.runtime.has(selection);
  }
  chat(request: ChatRequest, selection?: string) {
    return this.runtime.chat(request, selection);
  }
}

export const name = 'mini-llm';
export function apply(ctx: any) {
  ctx.plugin(LlmService);
}