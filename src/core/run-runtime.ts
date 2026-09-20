// src/core/run-runtime.ts
//
// 这一层把“每次 Agent 请求”从一个裸 Promise 提升成有边界的 Run。
//
// 真实 DSH 会把一次用户交互拆成 turn，把一次模型请求及其工具执行拆成 step，
// 并在持久会话日志中记录开始、结束和结束原因。本项目先使用更直观的 Run 名称，
// 但保留同样的核心思想：生命周期可观察、边界可执行、结束原因可解释。

/** 一次运行的生命周期状态。 */
export type RunStatus =
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'timed_out'
  | 'budget_exceeded'
  | 'failed';

/**
 * Run 的结束原因。
 *
 * 这相当于真实 DSH `turn/end.reason` 的学习版：
 * 调用者不应该只看到一个模糊的 Error，而应该知道运行为什么结束。
 */
export type RunEndReason =
  | { kind: 'completed' }
  | { kind: 'cancelled'; source: 'caller' | 'shutdown' }
  | { kind: 'timeout'; timeoutMs: number }
  | { kind: 'max-steps'; limit: number }
  | { kind: 'max-tool-calls'; limit: number }
  | { kind: 'max-output-bytes'; limit: number }
  | {
      kind: 'error';
      error: { name: string; message: string };
    };

/** Run 的执行边界。0 表示该项不设置上限，仅用于学习和测试。 */
export interface RunLimits {
  maxSteps: number;
  maxToolCalls: number;
  maxDurationMs: number;
  /** 模型流式 reasoning/content 的 UTF-8 字节预算。 */
  maxOutputBytes: number;
}

/** 创建 Run 时允许覆盖的部分限制。 */
export type RunLimitsInput = Partial<RunLimits>;

/** 可以写入日志或 UI 的 Run 状态快照。 */
export interface RunState {
  id: string;
  traceId: string;
  agentId: string;
  sessionId: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  currentStep: number;
  toolCalls: number;
  outputBytes: number;
  limits: RunLimits;
  stopReason?: RunEndReason;
}

/** RunRuntime 启动一次运行所需的信息。 */
export interface StartRunOptions {
  agentId: string;
  sessionId: string;
  signal?: AbortSignal;
  limits?: RunLimitsInput;
}

/** Agent Loop 依赖的最小 Run 管理接口。 */
export interface RunRegistry {
  start(options: StartRunOptions): ActiveRun;
  get(id: string): RunState | undefined;
  list(): RunState[];
}

/**
 * 代表“边界被触发”的内部错误。
 *
 * 它不是普通业务失败：Loop 可以据此补齐未执行的工具结果，
 * 然后把 max-steps、timeout 等结构化原因交给上层。
 */
export class RunBoundaryError extends Error {
  readonly reason: Exclude<RunEndReason, { kind: 'completed' }>;

  constructor(reason: Exclude<RunEndReason, { kind: 'completed' }>) {
    super(messageForReason(reason));
    this.name = 'RunBoundaryError';
    this.reason = reason;
  }
}

const DEFAULT_LIMITS: RunLimits = {
  // 这个值不是“智能上限”，而是防止学习版 accidentally 无限运行的保险丝。
  maxSteps: 30,
  maxToolCalls: 100,
  // 十分钟足够本地学习任务；未来应迁移到配置 schema。
  maxDurationMs: 10 * 60 * 1000,
  // 防止一次模型回复无限刷屏；工具结果限制属于后续 ToolPolicy。
  maxOutputBytes: 128 * 1024,
};

/**
 * 一个正在运行的 Run。
 *
 * 外部只通过 beginStep/consumeToolCall/finish 等方法推进状态，
 * 这样 step 和 tool call 计数不会散落在 Agent Loop 的各处。
 */
export class ActiveRun {
  private readonly controller = new AbortController();
  private readonly startedAt = new Date().toISOString();
  private readonly upstream?: AbortSignal;
  private readonly onUpstreamAbort: () => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private current: RunState;
  private finished = false;
  private requestedReason?: Exclude<RunEndReason, { kind: 'completed' }>;

  constructor(
    options: StartRunOptions,
    limits: RunLimits,
  ) {
    this.upstream = options.signal;
    this.current = {
      id: globalThis.crypto.randomUUID(),
      // traceId 与 runId 分开：未来一个外部请求可以关联多个内部 Run。
      traceId: globalThis.crypto.randomUUID(),
      agentId: options.agentId,
      sessionId: options.sessionId,
      status: 'running',
      startedAt: this.startedAt,
      currentStep: 0,
      toolCalls: 0,
      outputBytes: 0,
      limits: { ...limits },
    };

    this.onUpstreamAbort = () => {
      this.requestStop({ kind: 'cancelled', source: 'caller' });
    };

    if (this.upstream?.aborted) this.onUpstreamAbort();
    else this.upstream?.addEventListener('abort', this.onUpstreamAbort, { once: true });

    if (limits.maxDurationMs > 0) {
      this.timer = setTimeout(() => {
        this.requestStop({ kind: 'timeout', timeoutMs: limits.maxDurationMs });
      }, limits.maxDurationMs);
    }
  }

  get id(): string {
    return this.current.id;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get state(): Readonly<RunState> {
    return cloneState(this.current);
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** 当前 Run 是否已经请求停止，但还可能正在等待一个可收尾的操作。 */
  get stopRequested(): boolean {
    return this.requestedReason !== undefined;
  }

  /** 返回当前已经确定的停止原因。 */
  get stopReason(): RunEndReason | undefined {
    return this.requestedReason;
  }

  /** 开始一个 step；一个 step 对应一次模型调用及其工具执行。 */
  beginStep(): number {
    this.assertRunning();

    if (this.current.limits.maxSteps > 0 && this.current.currentStep >= this.current.limits.maxSteps) {
      const reason: Exclude<RunEndReason, { kind: 'completed' }> = {
        kind: 'max-steps',
        limit: this.current.limits.maxSteps,
      };
      this.requestStop(reason);
      throw new RunBoundaryError(reason);
    }

    this.current.currentStep += 1;
    return this.current.currentStep;
  }

  /**
   * 记录模型流式输出的字节数。
   *
   * 真实 DSH 会把输出 token/usage 和 step 绑定；本项目先用 UTF-8 字节预算
   * 学习“边界必须由运行时统一执行”，而不是让每个 Provider 自己决定。
   */
  consumeOutput(chunk: string): boolean {
    this.assertRunning();
    const bytes = Buffer.byteLength(chunk, 'utf8');
    const next = this.current.outputBytes + bytes;
    if (
      this.current.limits.maxOutputBytes > 0 &&
      next > this.current.limits.maxOutputBytes
    ) {
      const reason: Exclude<RunEndReason, { kind: 'completed' }> = {
        kind: 'max-output-bytes',
        limit: this.current.limits.maxOutputBytes,
      };
      this.current.outputBytes = this.current.limits.maxOutputBytes;
      this.requestStop(reason);
      return false;
    }
    this.current.outputBytes = next;
    return true;
  }

  /** 在真正执行一个工具前消耗一次工具调用预算。 */
  consumeToolCall(): void {
    this.assertRunning();

    if (
      this.current.limits.maxToolCalls > 0 &&
      this.current.toolCalls >= this.current.limits.maxToolCalls
    ) {
      const reason: Exclude<RunEndReason, { kind: 'completed' }> = {
        kind: 'max-tool-calls',
        limit: this.current.limits.maxToolCalls,
      };
      this.requestStop(reason);
      throw new RunBoundaryError(reason);
    }

    this.current.toolCalls += 1;
  }

  /**
   * 请求停止运行。
   *
   * 只接受第一次原因，避免“用户取消”被后面的超时覆盖。
   * AbortSignal 只负责通知；具体模型请求或子进程如何终止由各自能力负责。
   */
  requestStop(reason: Exclude<RunEndReason, { kind: 'completed' }>): void {
    if (this.finished || this.requestedReason) return;

    this.requestedReason = reason;
    if (!this.controller.signal.aborted) {
      this.controller.abort(new RunBoundaryError(reason));
    }
  }

  /** 以最终原因关闭 Run，并清理监听器和定时器。 */
  finish(reason: RunEndReason): void {
    if (this.finished) return;

    const actualReason = reason.kind === 'completed' && this.requestedReason
      ? this.requestedReason
      : reason;

    this.current.status = statusForReason(actualReason);
    this.current.stopReason = actualReason;
    this.current.endedAt = new Date().toISOString();
    this.finished = true;

    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.upstream?.removeEventListener('abort', this.onUpstreamAbort);
  }

  /** 把当前停止原因转换成适合上层显示/抛出的 Error。 */
  toError(): Error {
    const reason = this.requestedReason;
    if (!reason) return new Error('run is still active');
    return new RunBoundaryError(reason);
  }

  /** 根据异常判断最终应该记录什么结束原因。 */
  reasonFor(error: unknown): Exclude<RunEndReason, { kind: 'completed' }> {
    if (this.requestedReason) return this.requestedReason;
    if (error instanceof RunBoundaryError) return error.reason;

    return {
      kind: 'error',
      error: serializeError(error),
    };
  }

  private assertRunning(): void {
    if (this.finished) throw new Error(`run "${this.id}" is already finished`);
    if (this.requestedReason) throw this.toError();
  }
}

/**
 * 管理进程内的 Run。
 *
 * 真实 DSH 会把 Session 的耐久事件和 Agent/Loop 的运行所有权拆开；
 * 这里先保留一个简单内存注册表，重点学习“Run 是有状态资源，而不是 Promise”。
 */
export class RunRuntime implements RunRegistry {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly defaults: RunLimits;

  constructor(defaults: RunLimitsInput = {}) {
    this.defaults = normalizeLimits(defaults, DEFAULT_LIMITS);
  }

  start(options: StartRunOptions): ActiveRun {
    if (!options?.agentId) throw new Error('agentId is required');
    if (!options?.sessionId) throw new Error('sessionId is required');

    const limits = normalizeLimits(options.limits ?? {}, this.defaults);
    const run = new ActiveRun(options, limits);
    this.runs.set(run.id, run);
    return run;
  }

  get(id: string): RunState | undefined {
    const run = this.runs.get(id);
    return run ? run.state : undefined;
  }

  list(): RunState[] {
    return Array.from(this.runs.values(), run => run.state);
  }
}

function normalizeLimits(input: RunLimitsInput, fallback: RunLimits): RunLimits {
  const limits = {
    maxSteps: input.maxSteps ?? fallback.maxSteps,
    maxToolCalls: input.maxToolCalls ?? fallback.maxToolCalls,
    maxDurationMs: input.maxDurationMs ?? fallback.maxDurationMs,
    maxOutputBytes: input.maxOutputBytes ?? fallback.maxOutputBytes,
  };

  assertLimit(limits.maxSteps, 'maxSteps', { allowZero: true, integer: true });
  assertLimit(limits.maxToolCalls, 'maxToolCalls', { allowZero: true, integer: true });
  assertLimit(limits.maxDurationMs, 'maxDurationMs', { allowZero: true, integer: false });
  assertLimit(limits.maxOutputBytes, 'maxOutputBytes', { allowZero: true, integer: true });
  return limits;
}

function assertLimit(
  value: number,
  name: string,
  options: { allowZero: boolean; integer: boolean },
): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  if ((!options.allowZero && value <= 0) || (options.allowZero && value < 0)) {
    throw new RangeError(`${name} must be ${options.allowZero ? 'non-negative' : 'positive'}`);
  }
  if (options.integer && !Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer`);
  }
}

function statusForReason(reason: RunEndReason): RunStatus {
  switch (reason.kind) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'timeout':
      return 'timed_out';
    case 'max-steps':
    case 'max-tool-calls':
    case 'max-output-bytes':
      return 'budget_exceeded';
    case 'error':
      return 'failed';
  }
}

function serializeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: 'UnknownError', message: String(error) };
}

function messageForReason(reason: Exclude<RunEndReason, { kind: 'completed' }>): string {
  switch (reason.kind) {
    case 'cancelled':
      return 'Agent run cancelled';
    case 'timeout':
      return `Agent run timed out after ${reason.timeoutMs}ms`;
    case 'max-steps':
      return `Agent run exceeded max steps (${reason.limit})`;
    case 'max-tool-calls':
      return `Agent run exceeded max tool calls (${reason.limit})`;
    case 'max-output-bytes':
      return `Agent run exceeded max output bytes (${reason.limit})`;
    case 'error':
      return reason.error.message;
  }
}

function cloneState(state: RunState): RunState {
  return {
    ...state,
    traceId: state.traceId,
    outputBytes: state.outputBytes,
    limits: { ...state.limits },
    stopReason: state.stopReason ? cloneReason(state.stopReason) : undefined,
  };
}

function cloneReason(reason: RunEndReason): RunEndReason {
  if (reason.kind !== 'error') return { ...reason };
  return { kind: 'error', error: { ...reason.error } };
}
