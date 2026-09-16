// src/plugins/cli.ts
// CLI 是最薄的一层 UI：读取用户输入，调用 Agent，并把事件打印出来。

// Node.js 内置 readline 用来把终端输入按“每一行”交给程序。
import readline from 'node:readline';
// 显式导入 process，方便阅读者知道 stdin/stdout 来自哪里。
import process from 'node:process';
// 这两个类型只在编译期使用，不会增加运行时依赖。
import type {
  AgentToolCall,
  AgentToolResult,
} from '../core/agent-loop-runtime.js';

// inject 声明本插件需要哪些 Cordis 服务。
// sandbox 负责文件写入和 Bash 执行前的批准。
export const inject = [
  'sessions',
  'agents',
  'agentLoop',
  'tools',
  'systemPrompt',
  'llm',
  'sandbox',
];

// CLI 配置类型；调用者可以传一个初始模型。
type CliConfig = {
  model?: string;
};

// ANSI 转义码：终端识别这些字符串后，会改变后续文字的颜色。
// reset 用来恢复默认颜色，防止颜色影响后面的提示符。
const color = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
};

// 只保留结果前 max 个字符，避免工具输出刷屏。
function truncate(value: string, max = 300): string {
  // 三元表达式的格式是 condition ? valueIfTrue : valueIfFalse。
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

// 打印帮助信息；把命令集中放在一个函数里，便于维护。
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

// Cordis 插件的入口。
export function apply(ctx: any, config: CliConfig = {}): void {
  // 每次启动 CLI 创建一个 session，并标记来源是 cli。
  const session = ctx.sessions.create({ source: 'cli' });
  // 选择模型的优先级：插件配置 > 环境变量 > 内置默认值。
  let model =
    config.model ??
    process.env.MINI_DSH_MODEL ??
    'deepseek/deepseek-v4-pro';
  // Agent 负责对外提供 send()；具体循环逻辑由已注入的 agentLoop 承担。
  const agent = ctx.agents.create({
    name: 'cli-agent',
    sessionId: session.id,
    model,
    loop: ctx.agentLoop,
  });

  // 当前正在运行的请求对应的取消控制器；没有运行时为 null。
  let currentAbort: AbortController | null = null;
  // disposed 表示 CLI 是否已经清理过资源，防止重复清理。
  let disposed = false;
  // 记录是否已经输出过 "Agent > "，用于决定最后是否补换行。
  let contentStarted = false;
  // running 表示是否正在处理一轮用户请求。
  let running = false;
  // 审批问题由 readline 自己接收输入；此时 Esc 不能被当成取消请求。
  let approvalInProgress = false;

  // 创建 readline：
  // input 是输入来源，output 是提示符输出位置，prompt 是每轮显示的提示文字。
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'User > ',
  });
  // 先记住 stdin 原来的 raw mode，退出时恢复它。
  const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false;
  // 只有真实终端支持 raw mode；管道输入或测试环境中通常没有这个能力。
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    // raw mode 让 readline 能看到单独的 Esc 字节，而不是等到回车才交付。
    process.stdin.setRawMode(true);
  }

  /**
   * 把 SandboxRuntime 的批准回调接到当前 CLI 的 readline。
   */
  const askApproval = (request: { summary?: string }) => {
    const wasRunning = running;
    running = false;
    approvalInProgress = true;
    if (request.summary) process.stdout.write(`\n[approval] ${request.summary}\n`);

    return new Promise<boolean>(resolve => {
      rl.question('Allow this? [Y/n] ', answer => {
        const normalized = answer.trim().toLowerCase();
        const approved = !normalized || normalized === 'y' || normalized === 'yes';
        if (!approved) console.log('rejected.');
        approvalInProgress = false;
        running = wasRunning;
        resolve(approved);
      });
    });
  };

  // stdin 的 data 事件会在收到原始字节时触发。
  const onData = (chunk: Buffer | string) => {
    // 审批期间由 readline.question 专门处理 Y/N，Esc 不应抢走这次输入。
    if (approvalInProgress) return;
    // 只取消“单独的 Esc 字节”。方向键通常是 Esc + '[' + 其他字节。
    // Buffer.from 能把字符串或已有 Buffer 统一成字节数组。
    const bytes = Buffer.from(chunk);
    // 0x1b 是十六进制写法，对应 ASCII 的 Escape。
    if (bytes.length === 1 && bytes[0] === 0x1b) {
      // `?.` 表示 currentAbort 存在时才调用 abort()。
      currentAbort?.abort();
    }
  };

  // 关闭 CLI 时统一释放所有资源。
  const cleanup = () => {
    // 已经清理过就直接返回，保证 cleanup 具备幂等性。
    if (disposed) return;
    disposed = true;
    // 关闭正在进行的模型请求。
    currentAbort?.abort();
    // off 移除之前通过 on 注册的监听器。
    process.stdin.off('data', onData);
    // 恢复进入 raw mode 之前的终端状态。
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(Boolean(wasRaw));
    }
    // 关闭 readline，停止读取终端。
    rl.close();
  };

  // 让 Cordis 在 CLI 插件卸载时自动移除 stdin 监听和 readline。
  // ctx.effect 会记住 cleanup，在上下文销毁时调用它。
  const disposeApprover = ctx.sandbox.setApprover(askApproval);
  ctx.effect(
    () => () => {
      // 先移除批准回调，再关闭 readline，避免卸载过程中留下悬空审批。
      ctx.sandbox.disposeApprover();
      disposeApprover();
      cleanup();
    },
    'cli readline',
  );
  // 注册 stdin 的 data 监听；cleanup 会负责移除它。
  process.stdin.on('data', onData);

  // /tools：读取 ToolRuntime 当前注册的工具。
  const showTools = () => {
    const tools = ctx.tools.list();
    // 空数组在 JavaScript 中是真值，所以必须检查 length。
    if (!tools.length) {
      console.log('No tools registered.');
      return;
    }
    // for...of 逐个遍历数组元素。
    for (const tool of tools) {
      // 模板字符串可把多个变量拼成一行；?? 给 description 提供空字符串兜底。
      console.log(`- ${tool.name}: ${tool.description ?? ''}`.trimEnd());
    }
  };

  // /models：显示所有已经注册的 provider/model 选择。
  const showModels = () => {
    const models = ctx.llm.models();
    console.log(`Available models: ${models.length ? models.join(', ') : '(none)'}`);
    console.log(`Default model: ${ctx.llm.defaultSelection() ?? '(none)'}`);
  };

  // 处理以 "/" 开头的命令。
  // 返回 boolean 是为了让调用者知道“这行是否已经作为命令处理”。
  const handleCommand = async (line: string): Promise<boolean> => {
    // trim 去掉首尾空白；split 按一个或多个空白切分。
    // 第一项是命令，其余项放入 args，例如 "/model mock/demo"。
    const [command, ...args] = line.trim().split(/\s+/);

    // switch 根据 command 的值选择对应分支。
    switch (command) {
      case '/tools':
        showTools();
        return true;
      case '/models':
        showModels();
        return true;
      case '/model': {
        // 块级花括号让 requested 只在这个 case 内有效。
        const requested = args[0];
        if (!requested) {
          console.log(`Current model: ${model}`);
          return true;
        }
        if (!ctx.llm.has(requested)) {
          console.log(`Unknown model: ${requested}`);
          return true;
        }
        // 同时更新本地变量和 Agent 字段，之后 send() 才会使用新模型。
        model = requested;
        agent.model = requested;
        console.log(`Model changed to ${model}`);
        return true;
      }
      case '/history':
        // deriveMessages 把事件日志投影成当前模型能理解的消息数组。
        console.dir(ctx.sessions.deriveMessages(session.id), { depth: null });
        return true;
      case '/prompt':
        // assemble 会按顺序合并 identity、runtime 等 system prompt 片段。
        console.log(
          await ctx.systemPrompt.assemble({
            agent,
            sessionId: session.id,
            step: 0,
          }),
        );
        return true;
      case '/reset':
        // clear 只清空历史，不创建新 session，因此 session.id 保持不变。
        ctx.sessions.clear(session.id);
        console.log('Session reset.');
        return true;
      case '/exit':
        // /exit 复用统一清理逻辑。
        cleanup();
        return true;
      case '/help':
        printHelp();
        return true;
      default:
        // 未知命令不抛异常，只给用户提示。
        console.log(`Unknown command: ${command}. Type /help.`);
        return true;
    }
  };

  // 处理 readline 交付的一整行输入。
  const handleLine = async (line: string) => {
    // 用户输入只要去掉首尾空格后为空，就不启动 Agent。
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // 以 "/" 开头的输入统一视为 CLI 命令，而不是发给模型的问题。
    if (input.startsWith('/')) {
      await handleCommand(input);
      // /exit 会把 disposed 设为 true，此时不能再显示新提示符。
      if (!disposed) rl.prompt();
      return;
    }

    // currentAbort 非 null 代表上一轮尚未结束，避免并发改写同一个 session。
    if (running || currentAbort) {
      console.log('[busy] wait for the current run to finish or press Esc.');
      return;
    }

    // 为这一次 send() 创建专用的取消控制器。
    running = true;
    currentAbort = new AbortController();
    // 新一轮开始前重置“是否输出过正文”的标记。
    contentStarted = false;

    try {
      // send() 会启动 Agent Loop；signal 让底层 fetch 和 Loop 都能感知取消。
      const answer = await agent.send(input, {
        signal: currentAbort.signal,
        // 推理片段到达时立即用灰色打印。
        onReasoning: (chunk: string) => {
          process.stdout.write(`${color.gray}[Thinking] ${chunk}${color.reset}\n`);
        },
        // 正文片段到达时立即流式打印，而不是等待完整答案。
        onContent: (chunk: string) => {
          if (!contentStarted) {
            // 只在第一个正文片段前打印一次前缀。
            process.stdout.write('Agent > ');
            contentStarted = true;
          }
          // 后续片段直接写在同一行，形成连续回答。
          process.stdout.write(chunk);
        },
        // 工具调用发生时输出工具名和 JSON 参数。
        onToolCall: (call: AgentToolCall) => {
          process.stdout.write(
            `${color.cyan}[tool] ${call.name} ${JSON.stringify(call.arguments)}${color.reset}\n`,
          );
        },
        // 工具执行完成时输出渲染后的文本结果。
        onToolResult: (result: AgentToolResult) => {
          process.stdout.write(
            `${color.green}[tool result] ${truncate(result.renderedContent)}${color.reset}\n`,
          );
        },
      });

      // 如果已经流式打印过正文，只需要补一个换行；
      // 否则说明模型没有产生 onContent，直接打印 send() 返回的最终文本。
      if (contentStarted) {
        process.stdout.write('\n');
      } else {
        console.log(`Agent > ${answer}`);
      }
    } catch (error: any) {
      // LLM fetch 被 AbortSignal 打断时，底层可能抛 AbortError；
      // 只要当前 signal 已经 aborted，也统一显示为用户主动取消。
      // `RegExp.test` 用正则检查错误消息是否包含 cancelled 或 aborted。
      if (currentAbort?.signal.aborted || /cancelled|aborted/i.test(error?.message ?? '')) {
        console.log('[cancelled]');
      } else {
        console.log(`[AgentError] ${error?.message ?? String(error)}`);
      }
    } finally {
      // finally 无论 try 成功还是 catch 报错都会执行。
      // 把控制器恢复为 null，表示下一轮可以开始。
      currentAbort = null;
      running = false;
      if (!disposed) rl.prompt();
    }
  };

  // readline 每读到一行就触发 line 事件。
  // handleLine 是 async，但事件监听器不等待它，所以用 void 明确忽略 Promise。
  rl.on('line', line => {
    void handleLine(line);
  });
  // 用户发送 EOF 或 readline 被关闭时，也执行清理。
  rl.on('close', cleanup);

  // 启动提示信息只打印一次，然后显示第一轮输入提示符。
  console.log('mini-dsh CLI');
  console.log(`Model: ${model}`);
  console.log(`Sandbox workspace: ${ctx.sandbox.workspace}`);
  console.log('Writes and bash execution ask [Y/n] first. Press Esc to cancel a run.');
  rl.prompt();
}
