// src/core/sandbox-runtime.js
//
// SandboxRuntime 不是容器，也不是一个能抵御恶意攻击者的完整安全边界。
// 它做三件更具体的事：检查路径、拦截明显危险命令、在需要时请求用户批准。
// 真正的边界仍然是“用户是否批准这次写入或命令执行”。

import path from 'node:path';
import { resolveInside } from '../utils/path.js';

// 默认只允许访问本机服务；外部网络请求默认需要被策略拒绝。
const DEFAULT_ALLOW_HOSTS = ['localhost', '127.0.0.1', '::1'];

// shell 中这些字符会改变命令结构，tokenizer 会把它们单独保留下来。
const SHELL_OPERATORS = new Set(['|', '&', ';', '<', '>']);

/**
 * 负责工作区和命令策略的纯内存运行时。
 */
export class SandboxRuntime {
  constructor(options = {}) {
    // 工作区始终使用绝对路径，后续所有相对路径都从这里解释。
    this.workspace = path.resolve(options.workspace ?? process.cwd());
    this.autoApprove = options.autoApprove === true;
    this.allowHosts = new Set(
      (options.allowHosts ?? DEFAULT_ALLOW_HOSTS).map(normalizeHost),
    );
    this.approver = null;
  }

  /**
   * 检查命令是否属于“明显不应该直接执行”的范围。
   *
   * 返回 action 而不是直接抛错，是为了让 CLI、测试或未来 UI 能先展示原因。
   */
  inspectCommand(command) {
    if (typeof command !== 'string' || !command.trim()) {
      return deny('command is required');
    }

    const expanded = expandEnvironmentVariables(command);
    if (!expanded.ok) {
      return deny('command contains an unset environment variable');
    }

    const text = expanded.value;
    if (/\b(?:sudo|su)\b/i.test(text)) return deny('sudo/su is blocked');
    if (hasRecursiveDelete(text)) return deny('recursive delete is blocked');
    if (pipesNetworkIntoShell(text)) {
      return deny('piping curl/wget into a shell is blocked');
    }

    const tokens = tokenizeShell(text);
    const networkError = this.inspectOutboundHosts(tokens);
    if (networkError) return deny(networkError);

    const pathError = this.inspectCommandPaths(tokens);
    if (pathError) return deny(pathError);

    return { action: 'allow' };
  }

  /**
   * 只允许通过策略检查的命令继续执行；拒绝时转换成英文错误。
   */
  assertCommand(command) {
    const result = this.inspectCommand(command);
    if (result.action === 'deny') throw new Error(result.reason);
    return command;
  }

  /**
   * 请求一次写入或命令执行批准。
   */
  async approve(request) {
    if (this.autoApprove) {
      return { approved: true, source: 'auto' };
    }
    if (!this.approver) {
      throw new Error('write requires user approval, but no approval channel is set');
    }

    const approved = await this.approver(request);
    if (!approved) throw new Error('user rejected this operation');
    return { approved: true, source: 'user' };
  }

  /**
   * 设置交互式批准函数，并返回一个可以撤销它的 disposer。
   */
  setApprover(approver) {
    if (typeof approver !== 'function') {
      throw new TypeError('approver must be a function');
    }

    this.approver = approver;
    let disposed = false;
    return () => {
      if (disposed) return;
      if (this.approver === approver) this.approver = null;
      disposed = true;
    };
  }

  /** 清除当前批准通道，供 CLI 卸载时调用。 */
  disposeApprover() {
    this.approver = null;
  }

  inspectOutboundHosts(tokens) {
    const commandIndex = findCommandIndex(tokens);
    const command = tokens[commandIndex] ?? '';
    if (!/(?:^|\/)(?:curl|wget)$/i.test(command)) return null;

    const candidates = tokens
      .slice(commandIndex + 1)
      .filter(token => !SHELL_OPERATORS.has(token) && !token.startsWith('-'))
      .filter(token => token.includes('://') || looksLikeHost(token));

    if (!candidates.length) return 'unauthorized outbound request is blocked';

    for (const candidate of candidates) {
      const host = hostFromTarget(candidate);
      if (!host || !this.allowHosts.has(normalizeHost(host))) {
        return 'unauthorized outbound request is blocked';
      }
    }
    return null;
  }

  inspectCommandPaths(tokens) {
    const commandIndex = findCommandIndex(tokens);
    let redirectTarget = false;

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === '>') {
        redirectTarget = true;
        continue;
      }
      if (SHELL_OPERATORS.has(token)) continue;
      if (redirectTarget) {
        // 2>&1 会把 & 和 1 分成单独 token，直到真正目标出现前保持状态。
        if (token === '&' || /^\d+$/.test(token)) continue;
        redirectTarget = false;
        if (token === '/dev/null' || token === '/dev/stderr') continue;
      }
      // 管道后的第一个 token 是下一条命令的可执行文件，例如 /usr/bin/grep；
      // 它和开头的 /bin/ls 一样，不应被当成命令参数拦截。
      if (index === commandIndex || isCommandPosition(tokens, index) || token.startsWith('-')) continue;

      if (hasParentTraversal(token)) return '.. path escape is blocked';

      const candidate = expandTilde(token);
      if (isSystemPath(candidate)) return 'system path is blocked';

      // URL 和网络主机名不是本地文件路径，前面已经由 host 白名单检查。
      if (candidate.includes('://') || looksLikeHost(candidate)) continue;

      try {
        // 对普通参数也做一次工作区检查：README.md、src、foo 都可以自然解析到工作区内。
        resolveInside(this.workspace, candidate);
      } catch (error) {
        return error?.message ?? 'path escapes the workspace';
      }
    }
    return null;
  }
}

function deny(reason) {
  return { action: 'deny', reason };
}

function normalizeHost(host) {
  return String(host).trim().toLowerCase().replace(/^\[|\]$/g, '');
}

function expandEnvironmentVariables(command) {
  let ok = true;
  const value = command.replace(/\$(?:\{([^}]+)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_, braced, plain) => {
    const name = braced ?? plain;
    if (process.env[name] === undefined) {
      ok = false;
      return '';
    }
    return process.env[name];
  });
  return { ok, value };
}

function expandTilde(value) {
  if (value === '~') return process.env.HOME ?? value;
  if (value.startsWith('~/')) return `${process.env.HOME ?? '~'}${value.slice(1)}`;
  return value;
}

function tokenizeShell(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      pushToken(tokens, current);
      current = '';
    } else if (SHELL_OPERATORS.has(character)) {
      pushToken(tokens, current);
      current = '';
      tokens.push(character);
    } else {
      current += character;
    }
  }

  if (escaped) current += '\\';
  pushToken(tokens, current);
  return tokens;
}

function pushToken(tokens, token) {
  if (token) tokens.push(token);
}

function findCommandIndex(tokens) {
  return tokens.findIndex(token => !SHELL_OPERATORS.has(token));
}

function isCommandPosition(tokens, index) {
  return index > 0 && ['|', ';', '&'].includes(tokens[index - 1]);
}

function hasRecursiveDelete(command) {
  return /\brm\b[^\n;]*(?:--recursive|(?:^|\s)-[^\s]*r[^\s]*(?=\s|$))/i.test(command);
}

function pipesNetworkIntoShell(command) {
  return /\b(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash|zsh|ksh|dash)\b/i.test(command);
}

function hasParentTraversal(value) {
  return /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(value);
}

function isSystemPath(value) {
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  return [
    '/etc',
    '/usr',
    '/var',
    '/boot',
    '/dev',
    '/proc',
    '/sys',
    '/sbin',
    '/private/etc',
  ].some(prefix => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function looksLikeHost(value) {
  if (value.startsWith('/')) return false;
  return /^(?:localhost|\[[0-9a-f:]+\]|[0-9]{1,3}(?:\.[0-9]{1,3}){3}|[A-Za-z0-9.-]+\.[A-Za-z]{2,})(?::\d+)?(?:\/.*)?$/i.test(value);
}

function hostFromTarget(target) {
  try {
    if (target.includes('://')) return new URL(target).hostname;
    return target.split('/')[0].split(':')[0];
  } catch {
    return null;
  }
}
