// src/plugins/runtime-context.ts
// 把每次运行时才知道的现实环境信息注入 system prompt。

// `node:os` 是 Node.js 内置模块，用来读取操作系统信息，例如主机名。
import os from 'node:os';
// `node:path` 是 Node.js 内置模块，用来安全地处理文件路径。
import path from 'node:path';

// Cordis 在加载插件前会检查 inject 中列出的依赖。
export const inject = ['systemPrompt'];

// 插件配置类型：workspace 是可选的工作目录。
// `?` 表示调用方可以不传这个字段。
type RuntimeContextConfig = {
  workspace?: string;
};

// 读取当前进程的时区名称。
function getTimeZone(): string {
  // Intl.DateTimeFormat 是 JavaScript 国际化 API；
  // resolvedOptions() 返回当前环境实际采用的格式化配置。
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
}

// apply 是 Cordis 插件约定的入口函数。
// ctx 是 Cordis 上下文，config 是插件加载时传入的配置。
export function apply(
  ctx: any,
  config: RuntimeContextConfig = {},
): void {
  // `??` 会在左侧为 null 或 undefined 时选择右侧。
  // 因此工作目录的优先级是：显式配置 > 环境变量 > 当前进程目录。
  // `path.resolve` 把相对路径转换成绝对路径，方便模型明确知道工作位置。
  // workspace 只在插件启动时确定一次，后续每一轮复用同一个绝对路径。
  const workspace = path.resolve(
    config.workspace ??
      process.env.MINI_DSH_WORKSPACE ??
      process.cwd(),
  );

  // 第一段 prompt 是稳定的“身份说明”，使用 section 注册。
  // 箭头函数 `() => ...` 延迟执行注册动作，并把 disposer 交给 ctx.effect 管理。
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        // name 是片段的唯一名字，便于调试或之后移除。
        name: 'agent:identity',
        // order 越小越靠前；身份说明应该出现在环境信息之前。
        order: 10,
        // 数组 + join('\n') 是一种清晰的多行字符串写法。
        text: [
          'You are the local mini-dsh agent harness.',
          'Prefer using an available tool when a tool can verify the answer.',
          'When asked which tools are available, use the tools supplied in the current request.',
          'Reply in English by default.',
        ].join('\n'),
      }),
    'register agent identity prompt',
  );

  // 第二段 prompt 是动态 context：每次 assemble 时才调用 text 函数。
  // 这样当前时间等“可能变化的信息”不会在插件启动时被固定。
  ctx.effect(
    () =>
      ctx.systemPrompt.context({
        // 与 section 一样，name 用于标识这个 prompt 片段。
        name: 'runtime:environment',
        // 100 比身份片段的 10 大，所以会排在身份说明之后。
        order: 100,
        // 这里传函数而不是字符串，SystemPromptRuntime 组装时会重新读取环境。
        text: () =>
          [
            // toISOString() 生成标准 UTC 时间字符串，便于模型和程序识别。
            `Current time: ${new Date().toISOString()}`,
            // 函数调用得到当前时区；模板字符串用 ${...} 嵌入变量。
            `Time zone: ${getTimeZone()}`,
            // workspace、platform 等是 apply 阶段准备好的值。
            `Workspace: ${workspace}`,
            // process.platform 是 Node.js 提供的操作系统平台标识。
            `Platform: ${process.platform}`,
            // process.version 是当前 Node.js 版本。
            `Node.js: ${process.version}`,
            // os.hostname() 返回当前机器的主机名。
            `Hostname: ${os.hostname()}`,
          ].join('\n'),
      }),
    'register runtime environment prompt',
  );
}
