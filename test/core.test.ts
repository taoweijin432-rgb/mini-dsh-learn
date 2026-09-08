// test/core.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoopRuntime } from '../src/core/agent-loop-runtime.js';
import { AgentRuntime } from '../src/core/agent-runtime.js';
import { LlmRuntime } from '../src/core/llm-runtime.js';
import { SessionRuntime } from '../src/core/session-runtime.js';
import { SystemPromptRuntime } from '../src/core/system-prompt-runtime.js';
import { ToolRuntime } from '../src/core/tool-runtime.js';

test('Session derives tool-call history from the event log and keeps reasoning_content', () => {
  const sessions = new SessionRuntime();
  const s = sessions.create();

  sessions.append(s.id, 'user/message', { content: 'what time is it' });
  sessions.append(s.id, 'assistant/tool_calls', {
    reasoningContent: 'I need to call bash date',
    toolCalls: [{ id: 'c1', name: 'bash', arguments: { command: 'date' } }],
  });
  sessions.append(s.id, 'tool/result', {
    toolCallId: 'c1',
    content: '12:00',
  });

  const messages = sessions.deriveMessages(s.id);
  const assistant = messages[1];
  const tool = messages[2];
  assert.ok(assistant);
  assert.ok(tool);
  assert.equal(assistant.reasoning_content, 'I need to call bash date');
  assert.equal(assistant.tool_calls?.[0]?.function.name, 'bash');
  assert.equal(tool.role, 'tool');
});

test('Session clear keeps the same id and drops derived chat history', () => {
  const sessions = new SessionRuntime();
  const s = sessions.create();
  const id = s.id;

  sessions.append(id, 'user/message', { content: 'hello' });
  sessions.append(id, 'assistant/message', { content: 'hi' });
  sessions.clear(id);

  assert.equal(sessions.get(id).id, id);
  assert.equal(sessions.get(id).events[0].type, 'session/start');
  assert.equal(sessions.get(id).events[0].data.reset, true);
  assert.deepEqual(sessions.deriveMessages(id), []);
});
test('ToolRuntime register returns a disposer and renders results as text', async () => {
  const { ToolRuntime } = await import('../src/core/tool-runtime.js');
  const tools = new ToolRuntime();

  const dispose = tools.register({
    name: 'echo',
    description: 'echo',
    parameters: { type: 'object' },
    execute: async (args: any) => args,
  });

  assert.equal(tools.schemas().length, 1);// 1. 注册成功
  const result = await tools.execute('echo', { a: 1 });// 2. 执行成功
  // 默认渲染为 JSON 字符串
  assert.match(tools.renderResult(result), /"a": 1/);// 3. 默认 JSON 渲染正确

  dispose(); // 4. 销毁
  assert.equal(tools.schemas().length, 0);// 5. 已被移除
});

// ----- System Prompt 测试 -----
test('SystemPrompt assembles by order and disposer unregisters fragments', async () => {
  const { SystemPromptRuntime } = await import('../src/core/system-prompt-runtime.js');
  const prompt = new SystemPromptRuntime();

  prompt.section({ name: 'b', order: 20, text: 'B' });
  const dispose = prompt.context({ name: 'a', order: 10, text: async () => 'A' });

  assert.equal(await prompt.assemble(), 'A\n\nB');
  dispose();
  assert.equal(await prompt.assemble(), 'B');
});

// ----- LLM Runtime 测试 -----
test('LlmRuntime routes chat to the selected provider and disposer unregisters it', async () => {
  const { LlmRuntime } = await import('../src/core/llm-runtime.js');
  const llm = new LlmRuntime();
  const calls: any[] = [];

  const dispose = llm.register('mock', {
    models: ['fast'],
    chat: async (request: any) => {
      calls.push(request);
      return { content: 'ok' };
    },
  });

  assert.equal(llm.defaultSelection(), 'mock/fast');
  assert.deepEqual(llm.models(), ['mock/fast']);
  assert.equal(llm.has('mock/fast'), true);

  const reply = await llm.chat({ messages: [] });
  assert.equal(reply.content, 'ok');
  assert.equal(calls[0].model, 'fast');

  dispose();
  assert.deepEqual(llm.models(), []);
});

test('LlmRuntime selects an upstream model with provider/model', async () => {
  const { LlmRuntime } = await import('../src/core/llm-runtime.js');
  const llm = new LlmRuntime();
  let receivedModel: string | null = null;

  llm.register('mock', {
    models: ['a', 'b'],
    async chat({ model }: any) {
      receivedModel = model;
      return { content: model, toolCalls: [] };
    },
  }, { defaultModel: 'a' });

  assert.deepEqual(llm.models(), ['mock/a', 'mock/b']);
  assert.equal(llm.has('mock/b'), true);

  const result = await llm.chat({messages: [] }, 'mock/b');
  assert.equal(result.content, 'b');
  assert.equal(receivedModel, 'b');
});

test('Agent loop completes a model -> tool -> model turn', async () => {
  // Arrange：准备 Agent Loop 需要的五个内存 Runtime。
  const sessions = new SessionRuntime();
  const systemPrompt = new SystemPromptRuntime();
  const tools = new ToolRuntime();
  const llm = new LlmRuntime();
  const agents = new AgentRuntime();

  // Arrange：注册一个结果固定的 clock，避免测试依赖真实系统时间。
  tools.register({
    name: 'clock',
    description: 'clock',
    parameters: { type: 'object', properties: {} },
    execute: async () => '2026-08-25T17:25:00+08:00',
  });

  // calls 用来区分模型的第一轮和第二轮，同时验证模型总调用次数。
  let calls = 0;
  llm.register(
    'mock',
    {
      models: ['demo'],
      async chat({ messages }) {
        calls += 1;
        if (calls === 1) {
          // 第一轮模型不直接回答，而是要求 Agent Loop 执行 clock。
          return {
            reasoningContent: 'look up the time first',
            toolCalls: [{ id: 't1', name: 'clock', arguments: {} }],
          };
        }

        // 第二轮必须已经看到上一轮写回 Session 的工具结果。
        const toolMessage = messages.at(-1);
        assert.equal(toolMessage.role, 'tool');

        // 模型使用工具结果生成普通文本；空 toolCalls 表示循环可以结束。
        return { content: `it is ${toolMessage.content}`, toolCalls: [] };
      },
    },
    { defaultModel: 'demo' },
  );

  // Arrange：把 Session、模型和 Loop 绑定成一个可调用的 Agent。
  const s = sessions.create();
  const loop = new AgentLoopRuntime({ sessions, systemPrompt, tools, llm });
  const agent = agents.create({
    sessionId: s.id,
    model: 'mock/demo',
    loop,
  });

  // Act：只通过公开入口 send() 启动完整的模型 -> 工具 -> 模型流程。
  const answer = await agent.send('what time is it');

  // Assert：最终回答包含工具结果，并且模型刚好运行了两轮。
  assert.match(answer, /2026-08-25/);
  assert.equal(calls, 2);
});

test('Agent loop has no 12-step cap and finishes after 20 tool calls', async () => {
  // Arrange：仍然使用纯内存依赖，测试不会发起真实网络请求。
  const sessions = new SessionRuntime();
  const systemPrompt = new SystemPromptRuntime();
  const tools = new ToolRuntime();
  const llm = new LlmRuntime();
  const agents = new AgentRuntime();

  // 每轮 tick 都快速返回 ok，让测试只关注 Loop 的轮数而不是工具逻辑。
  tools.register({
    name: 'tick',
    description: 'tick',
    parameters: { type: 'object', properties: {} },
    execute: async () => 'ok',
  });

  // modelCalls 同时充当当前轮次计数器。
  let modelCalls = 0;
  llm.register(
    'mock',
    {
      models: ['long'],
      async chat() {
        modelCalls += 1;
        if (modelCalls <= 20) {
          // 前 20 轮始终要求调用工具；调用 ID 每轮都不同。
          return {
            toolCalls: [
              {
                id: `call-${modelCalls}`,
                name: 'tick',
                arguments: {},
              },
            ],
          };
        }

        // 第 21 轮不再请求工具，Agent Loop 应在这里自然返回。
        return { content: 'done', toolCalls: [] };
      },
    },
    { defaultModel: 'long' },
  );

  // Arrange：创建本次长任务专用的 Session、Loop 和 Agent。
  const s = sessions.create();
  const loop = new AgentLoopRuntime({ sessions, systemPrompt, tools, llm });
  const agent = agents.create({
    sessionId: s.id,
    model: 'mock/long',
    loop,
  });

  // Act：如果实现里存在隐藏的 12 步上限，这里会提前抛错。
  const answer = await agent.send('run a long task');

  // Assert：20 次工具调用后还要再调用一次模型，才能得到最终答案。
  assert.equal(answer, 'done');
  assert.equal(modelCalls, 21);
});

test('Agent loop streams reasoning, content, tool-call, and tool-result chunks', async () => {
  // Arrange：创建核心依赖。
  const sessions = new SessionRuntime();
  const systemPrompt = new SystemPromptRuntime();
  const tools = new ToolRuntime();
  const llm = new LlmRuntime();
  const agents = new AgentRuntime();

  // search 会把参数 q 放进返回文本，便于验证工具结果是否正确透传。
  tools.register({
    name: 'search',
    description: 'search tool',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    execute: async args => `result for ${args.q}`,
  });

  // 这个 mock 模型会运行两轮：第一轮流出 reasoning，第二轮流出 content。
  let step = 0;
  llm.register(
    'mock',
    {
      models: ['stream-model'],
      async chat({ onReasoning, onContent }) {
        step += 1;
        if (step === 1) {
          // 模拟模型把推理文本分成两个 chunk 实时发送。
          onReasoning?.('think-1');
          onReasoning?.('think-2');

          // 完整响应仍要保存合并后的 reasoningContent 和工具调用。
          return {
            reasoningContent: 'think-1think-2',
            toolCalls: [{ id: 'tc1', name: 'search', arguments: { q: 'foo' } }],
          };
        }

        // 工具执行完后，第二轮模型把最终回答拆成两个 content chunk。
        onContent?.('hello ');
        onContent?.('world');
        return {
          content: 'hello world',
          toolCalls: [],
        };
      },
    },
    { defaultModel: 'stream-model' },
  );

  // Arrange：创建 Agent。
  const s = sessions.create();
  const loop = new AgentLoopRuntime({ sessions, systemPrompt, tools, llm });
  const agent = agents.create({
    sessionId: s.id,
    model: 'mock/stream-model',
    loop,
  });

  // 下面四个数组充当最简单的“事件接收器”，记录各类回调顺序和内容。
  const reasoningChunks: string[] = [];
  const contentChunks: string[] = [];
  const toolCalls: any[] = [];
  const toolResults: any[] = [];

  // Act：把四个观察回调传给 send()，Loop 会在对应时机调用它们。
  const answer = await agent.send('test stream', {
    onReasoning: chunk => reasoningChunks.push(chunk),
    onContent: chunk => contentChunks.push(chunk),
    onToolCall: call => toolCalls.push(call),
    onToolResult: result => toolResults.push(result),
  });

  // Assert：最终值和四类中间事件都必须被正确保留。
  assert.equal(answer, 'hello world');
  assert.deepEqual(reasoningChunks, ['think-1', 'think-2']);
  assert.deepEqual(contentChunks, ['hello ', 'world']);

  // 同一轮只有一次 search 调用，因此 call/result 应各收到一次。
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, 'search');
  assert.equal(toolResults.length, 1);
  assert.match(toolResults[0].renderedContent, /result for foo/);
});

test('Cancelling a multi-tool turn still records a result for every tool_call', async () => {
  // Arrange：准备核心依赖和一个由测试控制的取消器。
  const sessions = new SessionRuntime();
  const systemPrompt = new SystemPromptRuntime();
  const tools = new ToolRuntime();
  const llm = new LlmRuntime();
  const agents = new AgentRuntime();

  const abort = new AbortController();

  // slow 的第一次执行会触发取消，但仍返回当前这次调用的真实结果。
  tools.register({
    name: 'slow',
    description: 'slow',
    parameters: { type: 'object', properties: {} },
    // 在两个调用中的第一个执行期间触发取消。
    execute: async () => {
      abort.abort();
      return 'first result';
    },
  });

  llm.register(
    'mock',
    {
      models: ['demo'],
      async chat() {
        // 同一条 assistant 消息一次声明两个 tool call。
        // 因此 Session 最终也必须为 t1、t2 各保存一个 tool result。
        return {
          toolCalls: [
            { id: 't1', name: 'slow', arguments: {} },
            { id: 't2', name: 'slow', arguments: {} },
          ],
        };
      },
    },
    { defaultModel: 'demo' },
  );

  // Arrange：创建 Agent，并让它使用上面的取消信号运行。
  const s = sessions.create();
  const loop = new AgentLoopRuntime({ sessions, systemPrompt, tools, llm });
  const agent = agents.create({ sessionId: s.id, model: 'mock/demo', loop });

  // Act + Assert：对调用者来说，本次 send() 最终必须以取消异常结束。
  await assert.rejects(
    () => agent.send('run both', { signal: abort.signal }),
    /cancelled/i,
  );

  // Assert：取消异常不能破坏 Session 历史，下面检查调用与结果是否一一配对。
  const messages = sessions.deriveMessages(s.id);

  // requested 收集 assistant/tool_calls 中模型请求过的全部调用 ID。
  const requested = messages.flatMap(
    message => message.tool_calls?.map(call => call.id) ?? [],
  );

  // answered 收集 role=tool 消息已经回答过的全部调用 ID。
  const answered = messages.flatMap(
    message =>
      message.role === 'tool' && message.tool_call_id
        ? [message.tool_call_id]
        : [],
  );

  // t1 是真实执行结果，t2 是 CANCELLED_RESULT；两者都必须存在。
  assert.deepEqual(requested, ['t1', 't2']);
  assert.deepEqual(answered, ['t1', 't2']);
});
