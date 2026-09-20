// src/plugins/runs.ts
//
// Cordis 只负责把 RunRuntime 暴露到 ctx.runs；生命周期规则仍在 core。

import { Service } from '@deepseek-ai/cordis';
import {
  RunRuntime,
  type RunRegistry,
  type RunState,
  type StartRunOptions,
} from '../core/run-runtime.js';

export class RunsService extends Service implements RunRegistry {
  private readonly runtime: RunRuntime;

  constructor(ctx: any) {
    super(ctx, 'runs');
    this.runtime = new RunRuntime();
  }

  start(options: StartRunOptions) {
    return this.runtime.start(options);
  }

  get(id: string): RunState | undefined {
    return this.runtime.get(id);
  }

  list(): RunState[] {
    return this.runtime.list();
  }
}

export const name = 'mini-runs';

export function apply(ctx: any): void {
  ctx.plugin(RunsService);
}
