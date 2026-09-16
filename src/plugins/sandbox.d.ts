// src/plugins/sandbox.d.ts
// sandbox.js 的类型声明，供入口和工具插件使用。

export const inject: string[];
export const name: string;

export class SandboxService {
  readonly workspace: string;
  readonly allowHosts: Set<string>;
  inspectCommand(command: string): { action: 'allow' | 'deny'; reason?: string };
  assertCommand(command: string): string;
  approve(request: unknown): Promise<{ approved: true; source: 'auto' | 'user' }>;
  setApprover(approver: (request: unknown) => boolean | Promise<boolean>): () => void;
  disposeApprover(): void;
}

export function apply(ctx: unknown, config?: Record<string, unknown>): void;
