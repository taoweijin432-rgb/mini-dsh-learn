// src/models/deepseek.ts
//
// 这里实现的是“模型供应商适配器”，不是 Agent。
// Agent Loop 只认识统一的 ChatRequest / ChatResponse；
// 本文件负责把统一请求翻译成 DeepSeek Chat Completions 请求，
// 再把 DeepSeek 的 SSE 流翻译回项目自己的响应格式。

import type { ChatRequest, ChatResponse, ModelAdapter } from '../core/llm-runtime.js';

type SseReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock?: () => void;
};

type SseResponse = {
  body: {
    getReader(): SseReader;
  } | null;
};

type ToolCallAccumulator = {
  index: number;
  id: string;
  name: string;
  arguments: string;
};

/**
 * 读取 DeepSeek 的 Server-Sent Events 流。
 *
 * 每个 data: 行都是一个 JSON 事件；[DONE] 只是结束标记，不是模型事件。
 * 这里按“每一行”吐出事件，而不是等空行，因此也兼容最后一行没有换行符的情况。
 */
export async function* parseSSE(response: SseResponse): AsyncGenerator<any> {
  if (!response.body) {
    throw new Error('DeepSeek API returned no response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const parseLine = (line: string): any | undefined => {
    // 兼容 CRLF，并忽略 SSE 注释行和空行。
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!normalized || normalized.startsWith(':')) return undefined;

    // SSE 允许写成 data: xxx 或 data:xxx，所以空格必须是可选的。
    const match = normalized.match(/^data:\s?(.*)$/);
    if (!match) return undefined;

    const data = match[1];
    if (data === '[DONE]') return undefined;
    return JSON.parse(data);
  };

  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });

      // 只要遇到换行，就立即处理完整的一行。
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;

        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const event = parseLine(line);
        if (event !== undefined) yield event;
      }

      if (chunk.done) break;
    }

    // 最后一行可能没有 \n，必须在 done 时手动 flush。
    if (buffer) {
      const event = parseLine(buffer);
      if (event !== undefined) yield event;
    }
  } finally {
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
  const index = Number(toolCall.index ?? 0);
  const current = map.get(index) ?? {
    index,
    id: '',
    name: '',
    arguments: '',
  };

  if (typeof toolCall.id === 'string' && !current.id) {
    current.id = toolCall.id;
  }

  const fn = toolCall.function ?? {};
  if (typeof fn.name === 'string') {
    current.name += fn.name;
  }
  if (typeof fn.arguments === 'string') {
    current.arguments += fn.arguments;
  }

  map.set(index, current);
}

/**
 * 把累积好的工具调用转换成 Agent Loop 使用的统一格式。
 */
export function finalizeToolCalls(
  map: Map<number, ToolCallAccumulator>,
): Array<{ id: string; name: string; arguments: any }> {
  return [...map.values()]
    .sort((a, b) => a.index - b.index)
    // 某些不完整的流可能只有 arguments，没有工具名；这类调用不能执行。
    .filter(call => call.name.trim())
    .map(call => ({
      id: call.id || `call_${call.index}`,
      name: call.name,
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
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('incomplete tool arguments JSON');
  }
}

function normalizeThinking(value: string | undefined): 'enabled' | 'disabled' {
  return value === 'disabled' ? 'disabled' : 'enabled';
}

function defaultModelFromEnv(): string {
  const selection = process.env.MINI_DSH_MODEL;
  if (selection?.startsWith('deepseek/')) {
    return selection.slice('deepseek/'.length);
  }
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
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const thinkingType = normalizeThinking(thinking);

  return {
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],

    async chat(request: ChatRequest): Promise<ChatResponse> {
      const messages = [
        ...(request.system
          ? [{ role: 'system', content: request.system }]
          : []),
        ...request.messages,
      ];

      const body: Record<string, any> = {
        model: request.model,
        messages,
        stream: true,
        thinking: { type: thinkingType },
      };
      if (request.tools?.length) body.tools = request.tools;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `DeepSeek API request failed (${response.status}): ${detail || response.statusText}`,
        );
      }

      let content = '';
      let reasoningContent = '';
      const toolCalls = new Map<number, ToolCallAccumulator>();

      for await (const event of parseSSE(response)) {
        const delta = event?.choices?.[0]?.delta;
        if (!delta) continue;

        if (typeof delta.reasoning_content === 'string') {
          reasoningContent += delta.reasoning_content;
          request.onReasoning?.(delta.reasoning_content);
        }

        if (typeof delta.content === 'string') {
          content += delta.content;
          request.onContent?.(delta.content);
        }

        for (const toolCall of delta.tool_calls ?? []) {
          accumulateToolCallDelta(toolCalls, toolCall);
        }
      }

      const result: ChatResponse = {
        content: content || undefined,
        reasoningContent: reasoningContent || undefined,
      };
      const finalized = finalizeToolCalls(toolCalls);
      if (finalized.length) result.toolCalls = finalized;
      return result;
    },
  };
}

/**
 * Cordis 插件元信息：依赖已经注册好的 LlmService。
 */
export const name = 'mini-model-deepseek';
export const inject = ['llm'];

export function apply(ctx: any): void {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error(
      'missing DEEPSEEK_API_KEY; copy .env.example to .env and fill it in',
    );
  }

  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
  const defaultModel = defaultModelFromEnv();
  const adapter = createDeepSeekAdapter(apiKey, baseUrl);

  ctx.effect(
    () =>
      ctx.llm.register('deepseek', adapter, {
        defaultModel,
      }),
    'register deepseek provider',
  );
}
