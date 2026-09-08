// src/index.ts
//
// 入口必须先加载 .env，再动态 import 会读取环境变量的插件。
// 如果把插件放到静态 import，ESM 会在 dotenv.config() 之前执行它们。
import { Context } from '@deepseek-ai/cordis';
import dotenv from 'dotenv';

dotenv.config();

const root = new Context();
const workspace = process.env.MINI_DSH_WORKSPACE ?? process.cwd();

// 动态 import 的顺序就是依赖装配顺序：
// Session / Prompt / Tool / LLM 先就绪，Agent / Loop 再注入它们。
const sessions = await import('./plugins/session.js');
const systemPrompt = await import('./plugins/system-prompt.js');
const tools = await import('./plugins/tools.js');
const llm = await import('./plugins/llm.js');
const agents = await import('./plugins/agents.js');
const agentLoop = await import('./plugins/agent-loop.js');
const runtimeContext = await import('./plugins/runtime-context.js');
const deepseek = await import('./models/deepseek.js');
const cli = await import('./plugins/cli.js');

await root.plugin(sessions);
await root.plugin(systemPrompt);
await root.plugin(tools);
await root.plugin(llm);
await root.plugin(agents);
await root.plugin(agentLoop);

await root.plugin(runtimeContext, { workspace });
await root.plugin(deepseek);
await root.plugin(cli, {
  model: process.env.MINI_DSH_MODEL ?? 'deepseek/deepseek-v4-pro',
});
