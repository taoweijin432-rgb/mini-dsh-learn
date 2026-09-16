// src/plugins/external-plugins.js
//
// 这个插件是一个很薄的“外部插件加载器”。
// 它不理解 MCP，也不为 Context7 编写特殊分支；
// 它只按照统一的 Cordis 插件契约加载配置中的 npm 包。

// Cordis 插件的名字主要用于日志和调试。
export const name = 'mini-external-plugins';

// 这个插件本身没有固定的服务依赖。
// 外部插件各自声明自己的 inject，Cordis 会在 ctx.plugin() 时检查它们。
export const inject = [];

// 一个外部插件配置项的形状说明。
// 这是普通 JavaScript 注释，不是运行时校验；真正的配置来自 plugins.config.js。
//
// {
//   package: 'npm-package-name',
//   required: false,
//   config: { ... }
// }

/**
 * 依次加载配置中的外部插件。
 *
 * 这里使用 async，是因为动态 import() 和 ctx.plugin() 都可能异步完成。
 * 只有 await 每一个 fiber，才可以保证插件的初始化工作完成后再继续启动 CLI。
 */
export async function apply(ctx, entries = []) {
  // for...of 按配置数组顺序逐个加载插件。
  // 这里不使用 forEach，因为 forEach 不会等待 async 回调返回的 Promise。
  for (const entry of entries) {
    try {
      // import() 是动态导入：参数是运行时字符串，返回一个 Promise。
      // await 会等待 npm 包加载完成，并得到它的模块导出对象。
      const mod = await import(entry.package);

      // ctx.plugin() 启动外部插件，并返回一个 Fiber。
      // Fiber 同时具有 PromiseLike 能力，因此可以直接 await。
      const fiber = ctx.plugin(mod, entry.config);

      // 必须等待 Fiber：外部 MCP 插件需要先连接服务并注册工具。
      // 如果不 await，CLI 可能先启动，/tools 此时还看不到 MCP 工具。
      await fiber;
    } catch (error) {
      // error 可能是 Error，也可能是其他值，所以用可选链和 String 做兜底。
      const message = error?.message ?? String(error);
      console.error(`[plugin] failed ${entry.package}: ${message}`);

      // required 默认为 false；只有明确要求的插件失败时才阻止启动。
      // Context7 是 optional，所以网络/TLS 故障只记录日志，不影响 CLI。
      if (entry.required) throw error;
    }
  }
}
