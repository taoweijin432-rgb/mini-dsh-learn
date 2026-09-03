// src/core/session-runtime.ts

/**
 * 会话事件的类型。
 *
 * Session 不直接保存“最后一份聊天消息”，而是按时间顺序保存事件：
 * 谁说了什么、助手调用了什么工具、工具返回了什么。
 * 这种设计通常叫“事件日志”。
 */
type EventType =
  | 'session/start' // 会话创建或清空后的起点
  | 'user/message' // 用户发送了一条消息
  | 'assistant/message' // 助手发送了一条普通消息
  | 'assistant/tool_calls' // 助手请求调用工具
  | 'tool/result'; // 工具返回结果

/**
 * 事件日志中的一条记录。
 */
interface BaseEvent {
  seq: number; // 全局递增序号，用于判断事件顺序
  type: EventType; // 事件属于哪一种
  at: string; // 发生时间，使用 ISO datetime 字符串
  data: any; // 当前事件携带的数据
}

/**
 * 一个完整会话。
 */
export interface Session {
  id: string; // 会话唯一 ID，clear 后也保持不变
  meta: any; // 创建会话时的额外信息
  events: BaseEvent[]; // 事件日志
  createdAt: string; // 会话创建时间
}

/**
 * 从事件日志“投影”出来的聊天消息。
 *
 * “投影”可以理解为：原始数据是事件，调用 deriveMessages 后，
 * 把事件翻译成 OpenAI/DeepSeek Chat Completions 能理解的 messages 数组。
 */
export type Message = {
  role: 'user' | 'assistant' | 'tool'; // 消息发送者角色
  content?: string | null; // 普通文本内容
  reasoning_content?: string; // DeepSeek 风格的思考内容
  tool_calls?: Array<{
    id: string; // 工具调用 ID
    type: 'function'; // 当前只支持 function 类型
    function: {
      name: string; // 工具名称
      arguments: string; // 工具参数必须是 JSON 字符串
    };
  }>;
  tool_call_id?: string; // tool 消息对应的调用 ID
};

/**
 * 会话运行时。
 *
 * 当前版本使用内存 Map 保存数据，程序退出后会话就会消失。
 * 将来可以把 Map 换成数据库，而上层调用方式基本不变。
 */
export class SessionRuntime {
  // key 是会话 ID，value 是会话对象。
  private sessions = new Map<string, Session>();

  // 所有会话共用一个递增序号，方便记录事件先后。
  private seqCounter = 0;

  /**
   * 创建一个新会话。
   */
  create(meta: any = {}): Session {
    // randomUUID 会生成类似 "550e8400-e29b-..." 的唯一字符串。
    const id = globalThis.crypto.randomUUID();
    const now = new Date().toISOString();

    // 创建会话时，先写入一个 session/start 事件作为日志起点。
    const events: BaseEvent[] = [
      {
        seq: ++this.seqCounter,
        type: 'session/start',
        at: now,
        data: { ...meta, reset: false },
      },
    ];

    const session: Session = { id, meta, events, createdAt: now };
    this.sessions.set(id, session);
    return session;
  }

  /**
   * 根据 ID 获取会话。
   *
   * 找不到时直接抛错，这样调用方不会误以为自己拿到了有效会话。
   */
  get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Session ${id} not found`);
    return s;
  }

  /**
   * 向指定会话追加一条事件。
   */
  append(id: string, type: EventType, data: any): void {
    // 先确认会话存在，再修改它。
    const session = this.get(id);
    const seq = ++this.seqCounter;
    const at = new Date().toISOString();
    session.events.push({ seq, type, at, data });
  }

  /**
   * 清空会话历史，但保留会话 ID。
   *
   * 保留 ID 的好处是：前端或 Agent 不需要切换到新的会话编号。
   */
  clear(id: string): void {
    const session = this.get(id);

    // 删除旧事件，然后写入一个标记 reset=true 的新起点。
    session.events = [];
    const seq = ++this.seqCounter;
    const at = new Date().toISOString();
    session.events.push({
      seq,
      type: 'session/start',
      at,
      data: { reset: true },
    });
  }

  /**
   * 列出当前内存中的全部会话。
   */
  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * 把事件日志转换成模型需要的 messages 数组。
   */
  deriveMessages(id: string): Message[] {
    const session = this.get(id);
    const messages: Message[] = [];

    // 按事件原有顺序逐条翻译。
    for (const event of session.events) {
      switch (event.type) {
        case 'user/message':
          // 用户事件直接变成 role=user 的消息。
          messages.push({ role: 'user', content: event.data.content ?? '' });
          break;

        case 'assistant/message':
          // 助手普通回复直接变成 role=assistant 的消息。
          messages.push({ role: 'assistant', content: event.data.content ?? '' });
          break;

        case 'assistant/tool_calls': {
          // 一个事件可能包含多个工具调用，所以需要逐个转换。
          const toolCalls = (event.data.toolCalls || []).map((tc: any) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              // API 通常要求 arguments 是字符串，而不是对象。
              arguments: JSON.stringify(tc.arguments || {}),
            },
          }));

          const msg: Message = {
            role: 'assistant',
            // 助手只调用工具、没有普通文字时，content 使用 null。
            content: event.data.content ?? null,
            tool_calls: toolCalls,
          };

          // reasoningContent 是事件内部使用的驼峰命名，
          // 输出给模型时转换成 API 常用的下划线命名。
          if (event.data.reasoningContent) {
            msg.reasoning_content = event.data.reasoningContent;
          }
          messages.push(msg);
          break;
        }

        case 'tool/result':
          // 工具结果必须带上 tool_call_id，模型才能知道它对应哪次调用。
          messages.push({
            role: 'tool',
            tool_call_id: event.data.toolCallId,
            // 文本直接保留；对象或数组则转成 JSON 字符串。
            content:
              typeof event.data.content === 'string'
                ? event.data.content
                : JSON.stringify(event.data.content),
          });
          break;

        case 'session/start':
          // session/start 只是日志控制事件，不应该发送给大模型。
          break;
      }
    }
    return messages;
  }
}
