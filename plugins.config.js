// plugins.config.js
//
// 这里集中声明“应用启动时还要加载哪些外部插件”。
// 配置文件本身不负责加载插件，真正的加载动作由
// src/plugins/external-plugins.js 完成。

// 读取环境变量必须发生在 dotenv.config() 之后。
// 因为 src/index.ts 会先加载 .env，再动态 import 本文件。
const headers = {};

// Context7 需要 API Key 时才添加 Authorization 请求头。
// 没有 Key 也保留空 headers，让插件仍然可以尝试连接公开服务。
if (process.env.CONTEXT7_API_KEY) {
  headers.Authorization = `Bearer ${process.env.CONTEXT7_API_KEY}`;
}

// 默认导出一个数组；数组中的每个对象描述一个外部插件实例。
export default [
  {
    // npm 包名，external-plugins 插件会把它传给动态 import()。
    package: '@deepseek-ai/dsh-mcp-client',
    // Context7 是可选能力，连接失败不能阻止主程序启动。
    required: false,
    // 这些配置会原样传给 dsh-mcp-client 的 apply(ctx, config)。
    config: {
      serverName: 'context7',
      transport: 'streamable-http',
      url: 'https://mcp.context7.com/mcp',
      headers,
      failOnStartupError: false,
      toolCallTimeoutMs: 60_000,
    },
  },
];
