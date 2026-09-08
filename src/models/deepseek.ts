// src/models/deepseek.ts
//
// 这里实现的是“模型供应商适配器”，不是 Agent。
// Agent Loop 只认识统一的 ChatRequest / ChatResponse；
// 本文件负责把统一请求翻译成 DeepSeek Chat Completions 请求，
// 再把 DeepSeek 的 SSE 流翻译回项目自己的响应格式。

// `import type` 表示“只导入类型，不导入运行时值”。
// 这些名称只用于 TypeScript 检查，编译成 JavaScript 后不会真的执行导入。
import type { ChatRequest, ChatResponse, ModelAdapter } from '../core/llm-runtime.js';

// 这是对“读取网络流对象”的最小类型描述。
// 我们没有直接使用完整的浏览器 Response 类型，而是只声明本文件真正需要的成员。
type SseReader = {
  // `read()` 每调用一次，就从流中取出一块数据。
  // Promise 表示读取是异步的；done 表示流是否结束；value 是二进制数据。
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  // `?` 表示这个属性是可选的；有些假的测试 reader 可能没有它。
  releaseLock?: () => void;
};

// 同样，这里只描述 parseSSE 需要的 response 结构。
type SseResponse = {
  // body 可能为空，所以使用 `| null` 表示“对象或 null”。
  body: {
    // getReader() 把 response body 转成可逐块读取的 reader。
    getReader(): SseReader;
  } | null;
};

// 工具调用在 SSE 中会被拆成多段，这个类型就是“拼接中的工具调用”。
type ToolCallAccumulator = {
  // index 用来区分同一轮里的第几个工具调用。
  index: number;
  // id 和 name 通常只在某个 delta 中出现，但也可能被分段发送。
  id: string;
  name: string;
  // arguments 是 JSON 文本，必须先拼接完整，最后才能 JSON.parse。
  arguments: string;
};

/**
 * 读取 DeepSeek 的 Server-Sent Events 流。
 *
 * 每个 data: 行都是一个 JSON 事件；[DONE] 只是结束标记，不是模型事件。
 * 这里按“每一行”吐出事件，而不是等空行，因此也兼容最后一行没有换行符的情况。
 */
export async function* parseSSE(response: SseResponse): AsyncGenerator<any> {
  // 网络响应没有 body，就没有任何内容可以读取，直接抛出明确错误。
  if (!response.body) {
    throw new Error('DeepSeek API returned no response body');
  }

  // `getReader()` 得到流读取器；之后通过 await reader.read() 持续读取数据。
  const reader = response.body.getReader();
  // TextDecoder 负责把 Uint8Array（二进制字节）转换成 JavaScript 字符串。
  const decoder = new TextDecoder();
  // 一个网络 chunk 不一定刚好等于一整行，所以要把暂时不完整的文本放进 buffer。
  let buffer = '';

  // 内部函数：把一行 SSE 文本转换成 JSON 事件。
  // `any | undefined` 表示可能返回任意对象，也可能返回 undefined（代表忽略这一行）。
  const parseLine = (line: string): any | undefined => {
    // 兼容 CRLF，并忽略 SSE 注释行和空行。
    // Windows 常见换行是 "\r\n"，前面的拆分只去掉了 "\n"，所以这里再去掉 "\r"。
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    // `||` 表示“只要左边或右边为真就成立”。
    // 空行和以冒号开头的 SSE 注释都不是模型事件。
    if (!normalized || normalized.startsWith(':')) return undefined;

    // SSE 允许写成 data: xxx 或 data:xxx，所以空格必须是可选的。
    // 正则中的 `^` 和 `$` 分别表示行首和行尾；`.*` 表示任意内容。
    const match = normalized.match(/^data:\s?(.*)$/);
    // 不是 data 行时忽略；SSE 还可能有 event、id 等字段，本项目不需要它们。
    if (!match) return undefined;

    // 正则第一个捕获组 `(.*)` 的内容位于 match[1]。
    const data = match[1];
    // [DONE] 是 DeepSeek 用来告诉客户端“流结束”的特殊标记，不是 JSON。
    if (data === '[DONE]') return undefined;
    // 将 data 文本解析为 JavaScript 对象；如果 JSON 损坏，JSON.parse 会抛异常。
    return JSON.parse(data);
  };

  // try/finally 保证：无论正常结束还是中途报错，都尝试释放 reader。
  try {
    while (true) {
      // `await` 等待下一块网络数据；每一块可能包含半行、整行或多行。
      const chunk = await reader.read();
      // `stream: !chunk.done` 告诉解码器是否还会有后续字节。
      // done 时让 TextDecoder 把内部残留字节也冲刷出来。
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });

      // 只要遇到换行，就立即处理完整的一行。
      while (true) {
        // indexOf 找不到换行时返回 -1，说明 buffer 里暂时只有半行。
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;

        // slice(0, newline) 取出换行前的内容，不包含换行符本身。
        const line = buffer.slice(0, newline);
        // slice(newline + 1) 丢弃已经处理的这一行，保留后面的文本。
        buffer = buffer.slice(newline + 1);
        // 先解析，再通过 yield 把事件交给 for await...of 的调用者。
        const event = parseLine(line);
        if (event !== undefined) yield event;
      }

      // `break` 只跳出当前 while，表示底层 reader 已经报告结束。
      if (chunk.done) break;
    }

    // 最后一行可能没有 \n，必须在 done 时手动 flush。
    // 如果不处理这里，服务端最后一个 token 会被留在 buffer 中而丢失。
    if (buffer) {
      const event = parseLine(buffer);
      if (event !== undefined) yield event;
    }
  } finally {
    // `?.` 是可选链：只有 releaseLock 存在时才调用它。
    reader.releaseLock?.();
  }
}

/**
 * 把一个 tool_calls delta 拼接到对应的工具调用上。
 *
 * DeepSeek 会把工具名和 arguments 分成多个 delta 发送，
 * 所以 name 和 arguments 都必须使用“追加”，不能整体覆盖。
 */
export function accumulateToolCallDelta(
  map: Map<number, ToolCallAccumulator>,
  toolCall: any,
): void {
  // `??` 只有在左侧为 null 或 undefined 时才使用右侧默认值。
  // 某些服务端 delta 可能省略 index，因此这里将其当作第 0 个调用。
  const index = Number(toolCall.index ?? 0);
  // 如果 map 中已经有这个 index，就继续使用原对象；
  // 否则创建一个字段齐全的初始对象。
  const current = map.get(index) ?? {
    index,
    id: '',
    name: '',
    arguments: '',
  };

  // 只有 id 是字符串且当前还没有 id 时才写入。
  // 这样后续 delta 不会用空值覆盖第一次收到的有效 id。
  if (typeof toolCall.id === 'string' && !current.id) {
    current.id = toolCall.id;
  }

  // function 也可能缺失，因此缺失时使用空对象，避免访问 undefined.name。
  const fn = toolCall.function ?? {};
  // typeof 检查可以避免把非字符串值错误地拼接到工具名中。
  if (typeof fn.name === 'string') {
    // `+=` 等价于 current.name = current.name + fn.name，表示追加片段。
    current.name += fn.name;
  }
  if (typeof fn.arguments === 'string') {
    // 参数同样按文本追加，不能在每个 delta 到达时直接 JSON.parse。
    current.arguments += fn.arguments;
  }

  // Map.set(key, value) 保存最新的累积结果。
  map.set(index, current);
}

/**
 * 把累积好的工具调用转换成 Agent Loop 使用的统一格式。
 */
export function finalizeToolCalls(
  map: Map<number, ToolCallAccumulator>,
): Array<{ id: string; name: string; arguments: any }> {
  // Map.values() 得到所有 value；扩展运算符 `...` 把可迭代对象展开成数组。
  // 后面的链式调用会依次完成排序、过滤和格式转换。
  return [...map.values()]
    // 先按原始 index 升序排列，确保多个工具调用保持模型声明的顺序。
    .sort((a, b) => a.index - b.index)
    // 某些不完整的流可能只有 arguments，没有工具名；这类调用不能执行。
    .filter(call => call.name.trim())
    // `map` 会把每个累积对象转换成 Agent Loop 约定的统一对象。
    .map(call => ({
      // 没收到 id 时生成一个本地兜底 id，保证后续 tool result 能配对。
      id: call.id || `call_${call.index}`,
      name: call.name,
      // 到这里参数文本应该已经完整，因此现在才解析 JSON。
      arguments: parseToolArguments(call.arguments),
    }));
}

/**
 * 解析模型拼接出来的工具参数。
 *
 * 空字符串表示模型没有提供参数，属于合法情况；
 * 非空但不是完整 JSON，则说明流被截断或模型输出损坏。
 */
export function parseToolArguments(text: string): any {
  // 模型可能调用一个不需要参数的工具；空文本对应空对象，而不是错误。
  if (!text) return {};

  try {
    // JSON.parse 把 JSON 字符串转换成对象、数组、数字等 JavaScript 值。
    return JSON.parse(text);
  } catch {
    // catch 捕获 JSON.parse 的 SyntaxError，并换成更容易理解的业务错误。
    throw new Error('incomplete tool arguments JSON');
  }
}

// 将环境变量的任意字符串收敛成适配器真正支持的两个值。
function normalizeThinking(value: string | undefined): 'enabled' | 'disabled' {
  // 返回值后面的联合字面量类型表示只能是这两个字符串之一。
  return value === 'disabled' ? 'disabled' : 'enabled';
}

// 从 provider/model 格式的环境变量中取出 provider 后面的模型名。
function defaultModelFromEnv(): string {
  const selection = process.env.MINI_DSH_MODEL;
  // `?.` 表示 selection 有值时才调用 startsWith；没有值时结果为 undefined。
  if (selection?.startsWith('deepseek/')) {
    // slice 从指定位置截取到字符串末尾，去掉 "deepseek/" 前缀。
    return selection.slice('deepseek/'.length);
  }
  // 未配置或配置了其他供应商时，DeepSeek 插件使用自己的默认模型。
  return 'deepseek-v4-pro';
}

/**
 * 创建一个绑定了 API key 和 Base URL 的 DeepSeek 适配器。
 *
 * 单独抽成函数，方便插件负责配置，适配器本身负责请求。
 */
export function createDeepSeekAdapter(
  apiKey: string,
  baseUrl = 'https://api.deepseek.com',
  thinking = process.env.DEEPSEEK_THINKING ?? 'enabled',
): ModelAdapter {
  // 去掉 baseUrl 末尾多余的 "/"，避免最终 URL 出现 "//chat/completions"。
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  // 在创建适配器时就把 thinking 配置标准化，chat() 每次可以直接复用。
  const thinkingType = normalizeThinking(thinking);

  // 返回对象满足 ModelAdapter 接口：模型列表 + chat 方法。
  return {
    // 这些是当前适配器对外公布的可选模型名。
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],

    // async 表示函数内部可以使用 await；返回值会自动包装成 Promise。
    async chat(request: ChatRequest): Promise<ChatResponse> {
      // DeepSeek 的 messages 需要把 system 单独放成第一条 system 消息。
      // `...(条件 ? [元素] : [])` 表示有 system 才展开一个元素，否则展开空数组。
      const messages = [
        ...(request.system
          ? [{ role: 'system', content: request.system }]
          : []),
        ...request.messages,
      ];

      // Record<string, any> 表示“字符串键 -> 任意值”的对象。
      // 这里构造供应商 API 需要的请求体。
      const body: Record<string, any> = {
        model: request.model,
        messages,
        stream: true,
        thinking: { type: thinkingType },
      };
      // 没有工具时不发送 tools 字段；有工具时才挂到请求体上。
      if (request.tools?.length) body.tools = request.tools;

      // fetch 发起 HTTP 请求；await 等待服务器返回响应头。
      const response = await fetch(endpoint, {
        // POST 表示把请求参数放在请求 body 中提交。
        method: 'POST',
        headers: {
          // 告诉服务端 body 是 JSON。
          'content-type': 'application/json',
          // Bearer 是常见的 Token 认证格式。
          authorization: `Bearer ${apiKey}`,
        },
        // JSON.stringify 把 JavaScript 对象序列化成 JSON 字符串。
        body: JSON.stringify(body),
        // AbortSignal 允许 CLI 或上层调用者取消网络请求。
        signal: request.signal,
      });

      // response.ok 表示 HTTP 状态码处于成功范围；失败时读取服务端错误详情。
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `DeepSeek API request failed (${response.status}): ${detail || response.statusText}`,
        );
      }

      // content 和 reasoningContent 分开累积，分别对应回答正文和思考过程。
      let content = '';
      let reasoningContent = '';
      // key 是 tool call 的 index，value 是该工具调用目前已经拼好的内容。
      const toolCalls = new Map<number, ToolCallAccumulator>();

      // `for await...of` 会逐个消费异步生成器 parseSSE 产出的事件。
      for await (const event of parseSSE(response)) {
        // DeepSeek 的增量内容位于 choices[0].delta；可选链避免结构不完整时崩溃。
        const delta = event?.choices?.[0]?.delta;
        if (!delta) continue;

        // reasoning_content 可能不存在；存在且是字符串时才累积并实时通知调用者。
        if (typeof delta.reasoning_content === 'string') {
          reasoningContent += delta.reasoning_content;
          // `?.()` 表示回调存在时才调用，不存在时什么也不做。
          request.onReasoning?.(delta.reasoning_content);
        }

        // 正文 content 与 reasoning 的处理方式相同，但回调名称不同。
        if (typeof delta.content === 'string') {
          content += delta.content;
          request.onContent?.(delta.content);
        }

        // 一个 delta 可以携带多个工具调用；没有 tool_calls 时 ?? [] 让循环安全跳过。
        for (const toolCall of delta.tool_calls ?? []) {
          accumulateToolCallDelta(toolCalls, toolCall);
        }
      }

      // 先创建普通响应对象；空字符串转换成 undefined，表示“没有这类内容”。
      const result: ChatResponse = {
        content: content || undefined,
        reasoningContent: reasoningContent || undefined,
      };
      // 将 Map 中拼好的工具调用转成数组。
      const finalized = finalizeToolCalls(toolCalls);
      // 只有确实存在工具调用时才添加 toolCalls 字段。
      if (finalized.length) result.toolCalls = finalized;
      return result;
    },
  };
}

/**
 * Cordis 插件元信息：依赖已经注册好的 LlmService。
 */
export const name = 'mini-model-deepseek';
// inject 是 Cordis 的依赖声明：插件启动前，必须先有名为 llm 的服务。
export const inject = ['llm'];

export function apply(ctx: any): void {
  // 插件通过 process.env 读取 dotenv.config() 已经加载的环境变量。
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    // 没有密钥时尽早失败，避免用户启动后才得到模糊的鉴权错误。
    throw new Error(
      'missing DEEPSEEK_API_KEY; copy .env.example to .env and fill it in',
    );
  }

  // `??` 表示只有环境变量不存在时才使用官方默认地址。
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
  // 入口模型选择是 provider/model 格式，这里由辅助函数取出模型名。
  const defaultModel = defaultModelFromEnv();
  // 创建适配器时把配置封装进去，后续 chat() 只接收统一 request。
  const adapter = createDeepSeekAdapter(apiKey, baseUrl);

  // ctx.effect 注册一个可撤销的副作用。
  // 插件卸载时会调用 register 返回的 disposer，把 DeepSeek 从 LlmRuntime 移除。
  ctx.effect(
    () =>
      ctx.llm.register('deepseek', adapter, {
        defaultModel,
      }),
    'register deepseek provider',
  );
}
