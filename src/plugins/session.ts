// src/plugins/sessions.ts
import { Service } from '@deepseek-ai/cordis';
import { SessionRuntime, Session, Message } from '../core/session-runtime.js';

export class SessionsService extends Service {
  private runtime: SessionRuntime;

  constructor(ctx: any) {
    super(ctx, 'sessions');
    this.runtime = new SessionRuntime();
  }

  create(meta?: any) {
    return this.runtime.create(meta);
  }
  get(id: string): Session {
    return this.runtime.get(id);
  }
  append(id: string, type: string, data: any) {
    // 确保 type 是有效的 EventType
    return this.runtime.append(id, type as any, data);
  }
  clear(id: string) {
    return this.runtime.clear(id);
  }
  list(): Session[] {
    return this.runtime.list();
  }
  deriveMessages(id: string): Message[] {
    return this.runtime.deriveMessages(id);
  }
}

export const name = 'mini-sessions';
export function apply(ctx: any) {
  ctx.plugin(SessionsService);
}