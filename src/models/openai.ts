// src/models/openai.ts
//
// OpenAI 适配器把项目统一的 ChatRequest 翻译成 OpenAI Chat Completions
// 请求，再把返回的 SSE 流翻译回项目自己的 ChatResponse。
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
 * 读取 OpenAI 的 Server-Sent Events 流。
 *
 * 网络 chunk 可能截断一行，所以先缓存文本；遇到 data: [DONE] 时结束。
 */
export async function* parseOpenAISSE(response: SseResponse): AsyncGenerator<any> {
  if (!response.body) {
    throw new Error('OpenAI API returned no response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const parseLine = (line: string): any | undefined => {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!normalized || normalized.startsWith(':')) return undefined;

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

    // 有些兼容服务会在最后一行省略换行符，不能丢掉这部分内容。
    if (buffer) {
      const event = parseLine(buffer);
      if (event !== undefined) yield event;
    }
  } finally {
    reader.releaseLock?.();
  }
}

function accumulateToolCallDelta(
  calls: Map<number, ToolCallAccumulator>,
  delta: any,
): void {
  const index = Number(delta?.index ?? 0);
  const current = calls.get(index) ?? {
    index,
    id: '',
    name: '',
    arguments: '',
  };

  if (typeof delta?.id === 'string' && !current.id) current.id = delta.id;
  if (typeof delta?.function?.name === 'string') {
    current.name += delta.function.name;
  }
  if (typeof delta?.function?.arguments === 'string') {
    current.arguments += delta.function.arguments;
  }

  calls.set(index, current);
}

function parseToolArguments(text: string): any {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('incomplete OpenAI tool arguments JSON');
  }
}

function finalizeToolCalls(calls: Map<number, ToolCallAccumulator>) {
  return [...calls.values()]
    .sort((a, b) => a.index - b.index)
    .filter(call => call.name.trim())
    .map(call => ({
      id: call.id || `call_${call.index}`,
      name: call.name,
      arguments: parseToolArguments(call.arguments),
    }));
}

const DEFAULT_OPENAI_MODELS = [
  'gpt-5',
  'gpt-5-mini',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-5.6-sol'
];

function configuredModels(): string[] {
  const fromEnv = (process.env.OPENAI_MODELS ?? '')
    .split(',')
    .map(model => model.trim())
    .filter(Boolean);
  const configuredDefault = process.env.MINI_DSH_MODEL?.startsWith('openai/')
    ? process.env.MINI_DSH_MODEL.slice('openai/'.length)
    : undefined;

  return [...new Set([
    ...DEFAULT_OPENAI_MODELS,
    ...fromEnv,
    ...(configuredDefault ? [configuredDefault] : []),
  ])];
}

/**
 * 创建 OpenAI 适配器。
 *
 * 默认地址是官方 OpenAI API；OPENAI_BASE_URL 也支持兼容 OpenAI 协议的代理。
 */
export function createOpenAIAdapter(
  apiKey: string,
  baseUrl = 'https://api.openai.com/v1',
): ModelAdapter {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  return {
    models: configuredModels(),

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
          `OpenAI API request failed (${response.status}): ${detail || response.statusText}`,
        );
      }

      let content = '';
      let reasoningContent = '';
      const toolCalls = new Map<number, ToolCallAccumulator>();

      for await (const event of parseOpenAISSE(response)) {
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

export const name = 'mini-model-openai';
export const inject = ['llm'];

export function apply(ctx: any): void {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // OpenAI 是可选供应商；没有配置时不影响已有的 DeepSeek 配置启动。
    return;
  }

  const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  const adapter = createOpenAIAdapter(apiKey, baseUrl);
  const defaultModel = process.env.MINI_DSH_MODEL?.startsWith('openai/')
    ? process.env.MINI_DSH_MODEL.slice('openai/'.length)
    : adapter.models[0];

  ctx.effect(
    () =>
      ctx.llm.register('openai', adapter, {
        defaultModel,
      }),
    'register openai provider',
  );
}
