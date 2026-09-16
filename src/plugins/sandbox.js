// src/plugins/sandbox.js
//
// 插件层把 SandboxRuntime 挂到 Cordis 的 ctx.sandbox 上，
// 并把“工具和命令需要经过批准”这条规则告诉模型。

import { Service } from '@deepseek-ai/cordis';
import { SandboxRuntime } from '../core/sandbox-runtime.js';

// 沙箱需要 systemPrompt 服务来注册 policy 片段。
export const inject = ['systemPrompt'];

/** Cordis 中的 sandbox 服务，只做 Runtime 的薄转发。 */
export class SandboxService extends Service {
  static inject = inject;

  constructor(ctx, config = {}) {
    super(ctx, 'sandbox');
    this.runtime = new SandboxRuntime({
      workspace: config.workspace,
      autoApprove:
        config.autoApprove ?? process.env.MINI_DSH_AUTO_APPROVE === '1',
      allowHosts: config.allowHosts,
    });

    // Service 自己声明了 systemPrompt 依赖，因此这里可以安全访问 ctx.systemPrompt。
    // 用 runtime.workspace 而不是 ctx.sandbox，避免在 sandbox 服务尚未完成注入时自引用。
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'sandbox:policy',
          order: 15,
          text: [
            'You are operating inside an application-layer sandbox.',
            'File writes and bash commands require user approval unless auto-approval is enabled.',
            `The allowed workspace is: ${this.runtime.workspace}`,
            'Do not treat this policy as a substitute for the runtime checks.',
          ].join('\n'),
        }),
      'register sandbox policy prompt',
    );
  }

  get workspace() {
    return this.runtime.workspace;
  }

  get allowHosts() {
    return this.runtime.allowHosts;
  }

  inspectCommand(command) {
    return this.runtime.inspectCommand(command);
  }

  assertCommand(command) {
    return this.runtime.assertCommand(command);
  }

  approve(request) {
    return this.runtime.approve(request);
  }

  setApprover(approver) {
    return this.runtime.setApprover(approver);
  }

  disposeApprover() {
    return this.runtime.disposeApprover();
  }
}

export const name = 'mini-sandbox';

/** 启动 sandbox 服务；policy prompt 在服务构造期间注册。 */
export function apply(ctx, config = {}) {
  // 先把 Runtime 挂上 ctx.sandbox，文件和 Bash 工具才能依赖它。
  ctx.plugin(SandboxService, config);
}
