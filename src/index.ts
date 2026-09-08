// src/index.ts
//
// 入口必须先加载 .env，再动态 import 会读取环境变量的插件。
// 如果把插件放到静态 import，ESM 会在 dotenv.config() 之前执行它们。
// 这是因为 ESM 的静态 import 会在当前文件其余代码之前完成加载。
import { Context } from '@deepseek-ai/cordis';
// dotenv.config() 会读取项目根目录的 .env，并把键值放进 process.env。
import dotenv from 'dotenv';

// 必须在动态加载插件之前执行，让插件 apply() 读取到完整配置。
dotenv.config();

// Context 是 Cordis 的总上下文，负责注册插件、服务和生命周期。
const root = new Context();
// `process.cwd()` 返回启动命令所在的当前工作目录。
// `??` 表示 MINI_DSH_WORKSPACE 没有设置时才使用 cwd。
const workspace = process.env.MINI_DSH_WORKSPACE ?? process.cwd();

// 动态 import 的顺序就是依赖装配顺序：
// Session / Prompt / Tool / LLM 先就绪，Agent / Loop 再注入它们。
// `await import(...)` 返回一个 Promise，结果是这个模块的导出对象。
const sessions = await import('./plugins/session.js');
const systemPrompt = await import('./plugins/system-prompt.js');
const tools = await import('./plugins/tools.js');
const llm = await import('./plugins/llm.js');
const agents = await import('./plugins/agents.js');
const agentLoop = await import('./plugins/agent-loop.js');
const runtimeContext = await import('./plugins/runtime-context.js');
const deepseek = await import('./models/deepseek.js');
const cli = await import('./plugins/cli.js');

// root.plugin 会把模块注册到 Cordis 上下文。
// 下面的先后顺序保证被依赖的服务已经存在。
await root.plugin(sessions);
await root.plugin(systemPrompt);
await root.plugin(tools);
await root.plugin(llm);
await root.plugin(agents);
await root.plugin(agentLoop);

// 运行时上下文需要 workspace 配置；第二个参数就是插件配置对象。
await root.plugin(runtimeContext, { workspace });
// DeepSeek 插件会读取 API key，并向 llm 服务注册适配器。
await root.plugin(deepseek);
// CLI 最后启动，因为它依赖前面已经装配完成的所有服务。
await root.plugin(cli, {
  // CLI 的初始模型使用环境变量，缺失时回退到 pro 模型。
  model: process.env.MINI_DSH_MODEL ?? 'deepseek/deepseek-v4-pro',
});
