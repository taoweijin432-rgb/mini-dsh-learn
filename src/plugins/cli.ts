// src/plugins/cli.ts
// CLI 是最薄的一层 UI：读取用户输入，调用 Agent，并把事件打印出来。

import readline from 'node:readline';
import process from 'node:process';
import type {
  AgentToolCall,
  AgentToolResult,
} from '../core/agent-loop-runtime.js';

export const inject = [
  'sessions',
  'agents',
  'agentLoop',
  'tools',
  'systemPrompt',
  'llm',
];

type CliConfig = {
  model?: string;
};

const color = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
};

function truncate(value: string, max = 300): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function printHelp(): void {
  console.log('Commands:');
  console.log('  /tools   list registered tools');
  console.log('  /models  list available models');
  console.log('  /model [provider/model]  show or change model');
  console.log('  /history show current session messages');
  console.log('  /prompt  show the assembled system prompt');
  console.log('  /reset   clear the current session');
  console.log('  /exit    quit the CLI');
}

export function apply(ctx: any, config: CliConfig = {}): void {
  const session = ctx.sessions.create({ source: 'cli' });
  let model =
    config.model ??
    process.env.MINI_DSH_MODEL ??
    'deepseek/deepseek-v4-pro';
  const agent = ctx.agents.create({
    name: 'cli-agent',
    sessionId: session.id,
    model,
    loop: ctx.agentLoop,
  });

  let currentAbort: AbortController | null = null;
  let disposed = false;
  let contentStarted = false;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'You > ',
  });
  const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false;
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    // raw mode 让 readline 能看到单独的 Esc 字节，而不是等到回车才交付。
    process.stdin.setRawMode(true);
  }

  const onData = (chunk: Buffer | string) => {
    // 只取消“单独的 Esc 字节”。方向键通常是 Esc + '[' + 其他字节。
    const bytes = Buffer.from(chunk);
    if (bytes.length === 1 && bytes[0] === 0x1b) {
      currentAbort?.abort();
    }
  };

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    currentAbort?.abort();
    process.stdin.off('data', onData);
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(Boolean(wasRaw));
    }
    rl.close();
  };

  // 让 Cordis 在 CLI 插件卸载时自动移除 stdin 监听和 readline。
  ctx.effect(() => cleanup, 'cli readline');
  process.stdin.on('data', onData);

  const showTools = () => {
    const tools = ctx.tools.list();
    if (!tools.length) {
      console.log('No tools registered.');
      return;
    }
    for (const tool of tools) {
      console.log(`- ${tool.name}: ${tool.description ?? ''}`.trimEnd());
    }
  };

  const showModels = () => {
    const models = ctx.llm.models();
    console.log(`Available models: ${models.length ? models.join(', ') : '(none)'}`);
    console.log(`Default model: ${ctx.llm.defaultSelection() ?? '(none)'}`);
  };

  const handleCommand = async (line: string): Promise<boolean> => {
    const [command, ...args] = line.trim().split(/\s+/);

    switch (command) {
      case '/tools':
        showTools();
        return true;
      case '/models':
        showModels();
        return true;
      case '/model': {
        const requested = args[0];
        if (!requested) {
          console.log(`Current model: ${model}`);
          return true;
        }
        if (!ctx.llm.has(requested)) {
          console.log(`Unknown model: ${requested}`);
          return true;
        }
        model = requested;
        agent.model = requested;
        console.log(`Model changed to ${model}`);
        return true;
      }
      case '/history':
        console.dir(ctx.sessions.deriveMessages(session.id), { depth: null });
        return true;
      case '/prompt':
        console.log(
          await ctx.systemPrompt.assemble({
            agent,
            sessionId: session.id,
            step: 0,
          }),
        );
        return true;
      case '/reset':
        ctx.sessions.clear(session.id);
        console.log('Session reset.');
        return true;
      case '/exit':
        cleanup();
        return true;
      case '/help':
        printHelp();
        return true;
      default:
        console.log(`Unknown command: ${command}. Type /help.`);
        return true;
    }
  };

  const handleLine = async (line: string) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input.startsWith('/')) {
      await handleCommand(input);
      if (!disposed) rl.prompt();
      return;
    }

    if (currentAbort) {
      console.log('[busy] wait for the current run to finish or press Esc.');
      return;
    }

    currentAbort = new AbortController();
    contentStarted = false;

    try {
      const answer = await agent.send(input, {
        signal: currentAbort.signal,
        onReasoning: (chunk: string) => {
          process.stdout.write(`${color.gray}[Thinking] ${chunk}${color.reset}\n`);
        },
        onContent: (chunk: string) => {
          if (!contentStarted) {
            process.stdout.write('Agent > ');
            contentStarted = true;
          }
          process.stdout.write(chunk);
        },
        onToolCall: (call: AgentToolCall) => {
          process.stdout.write(
            `${color.cyan}[tool] ${call.name} ${JSON.stringify(call.arguments)}${color.reset}\n`,
          );
        },
        onToolResult: (result: AgentToolResult) => {
          process.stdout.write(
            `${color.green}[tool result] ${truncate(result.renderedContent)}${color.reset}\n`,
          );
        },
      });

      if (contentStarted) {
        process.stdout.write('\n');
      } else {
        console.log(`Agent > ${answer}`);
      }
    } catch (error: any) {
      // LLM fetch 被 AbortSignal 打断时，底层可能抛 AbortError；
      // 只要当前 signal 已经 aborted，也统一显示为用户主动取消。
      if (currentAbort?.signal.aborted || /cancelled|aborted/i.test(error?.message ?? '')) {
        console.log('[cancelled]');
      } else {
        console.log(`[AgentError] ${error?.message ?? String(error)}`);
      }
    } finally {
      currentAbort = null;
      if (!disposed) rl.prompt();
    }
  };

  rl.on('line', line => {
    void handleLine(line);
  });
  rl.on('close', cleanup);

  console.log('mini-dsh CLI');
  console.log(`Model: ${model}`);
  console.log('Type /help for commands. Press Esc to cancel a running request.');
  rl.prompt();
}
