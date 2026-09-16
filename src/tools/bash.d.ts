// src/tools/bash.d.ts
// bash.js 的类型声明。

export const name: string;
export const inject: string[];
export function apply(ctx: unknown): void;
export function runBash(
  command: string,
  workspace: string,
  signal?: AbortSignal,
): Promise<string>;
