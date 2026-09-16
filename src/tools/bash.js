// src/tools/bash.js
//
// Bash 工具故意很小：先经过 SandboxRuntime 的命令策略，再请求用户批准，
// 最后在 workspace 作为 cwd 启动 bash。它不是一个安全容器。

import { spawn } from 'node:child_process';

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 32 * 1024;

export const name = 'mini-tools-bash';
export const inject = ['tools', 'sandbox'];

/** 注册 bash 工具。 */
export function apply(ctx) {
  const dispose = ctx.tools.register({
    name: 'bash',
    description: 'Run an approved bash command inside the workspace.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
      },
      required: ['command'],
    },
    execute: async (args, exec) => {
      const command = args?.command;
      // 顺序很重要：命令策略必须先于 Approval，危险命令不应该交给用户确认。
      ctx.sandbox.assertCommand(command);
      await ctx.sandbox.approve({
        tool: 'bash',
        summary: `bash: ${command}`,
      });
      return runBash(command, ctx.sandbox.workspace, exec.signal);
    },
  });

  // 工具插件卸载时撤销注册。
  ctx.effect(() => dispose, 'register bash tool');
}

/**
 * 在工作区启动 bash，并把 stdout/stderr 合并成一段最多 32 KiB 的文本。
 */
export function runBash(command, workspace, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-lc', command], {
      cwd: workspace,
      env: process.env,
    });

    let output = '';
    let outputBytes = 0;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const append = (chunk) => {
      if (outputBytes >= MAX_OUTPUT_BYTES) return;
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const remaining = MAX_OUTPUT_BYTES - outputBytes;
      const clipped = Buffer.byteLength(text) <= remaining
        ? text
        : Buffer.from(text).subarray(0, remaining).toString('utf8');
      output += clipped;
      outputBytes += Buffer.byteLength(clipped);
    };

    const stop = (reason) => {
      if (settled) return;
      if (reason === 'timeout') timedOut = true;
      if (reason === 'cancel') cancelled = true;
      child.kill('SIGTERM');
    };

    const onAbort = () => stop('cancel');
    const timer = setTimeout(() => stop('timeout'), COMMAND_TIMEOUT_MS);

    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', error => finish(error));
    child.once('close', code => {
      if (timedOut) {
        finish(new Error('command timed out after 30s'));
      } else if (cancelled) {
        finish(new Error('command cancelled'));
      } else if (code !== 0) {
        finish(new Error(`bash exited with code ${code}\n${output}`.trim()));
      } else {
        finish(null, output);
      }
    });

    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    }
  });
}
