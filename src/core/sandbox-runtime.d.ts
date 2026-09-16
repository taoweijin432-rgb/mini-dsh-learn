// src/core/sandbox-runtime.d.ts
// sandbox-runtime.js 的类型声明。

export interface SandboxOptions {
  workspace?: string;
  autoApprove?: boolean;
  allowHosts?: string[];
}

export interface CommandInspection {
  action: 'allow' | 'deny';
  // 调用方通常会先检查 action，再读取 reason；声明为 string 方便测试和 UI 展示。
  reason: string;
}

export interface ApprovalRequest {
  tool: string;
  summary: string;
}

export class SandboxRuntime {
  readonly workspace: string;
  readonly autoApprove: boolean;
  readonly allowHosts: Set<string>;
  constructor(options?: SandboxOptions);
  inspectCommand(command: string): CommandInspection;
  assertCommand(command: string): string;
  approve(request: ApprovalRequest): Promise<{
    approved: true;
    source: 'auto' | 'user';
  }>;
  setApprover(
    approver: (request: ApprovalRequest) => boolean | Promise<boolean>,
  ): () => void;
  disposeApprover(): void;
}
