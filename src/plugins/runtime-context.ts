// src/plugins/runtime-context.ts
// 把每次运行时才知道的现实环境信息注入 system prompt。

import os from 'node:os';
import path from 'node:path';

export const inject = ['systemPrompt'];

type RuntimeContextConfig = {
  workspace?: string;
};

function getTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
}

export function apply(
  ctx: any,
  config: RuntimeContextConfig = {},
): void {
  // workspace 只在插件启动时确定一次，后续每一轮复用同一个绝对路径。
  const workspace = path.resolve(
    config.workspace ??
      process.env.MINI_DSH_WORKSPACE ??
      process.cwd(),
  );

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'agent:identity',
        order: 10,
        text: [
          'You are the local mini-dsh agent harness.',
          'Prefer using an available tool when a tool can verify the answer.',
          'When asked which tools are available, use the tools supplied in the current request.',
          'Reply in English by default.',
        ].join('\n'),
      }),
    'register agent identity prompt',
  );

  ctx.effect(
    () =>
      ctx.systemPrompt.context({
        name: 'runtime:environment',
        order: 100,
        text: () =>
          [
            `Current time: ${new Date().toISOString()}`,
            `Time zone: ${getTimeZone()}`,
            `Workspace: ${workspace}`,
            `Platform: ${process.platform}`,
            `Node.js: ${process.version}`,
            `Hostname: ${os.hostname()}`,
          ].join('\n'),
      }),
    'register runtime environment prompt',
  );
}
