// src/tools/files.d.ts
// files.js 的类型声明，供测试和动态模块加载使用。

export const name: string;
export const inject: string[];
export function matchFilePattern(fileName: string, pattern: string): boolean;
export function apply(ctx: unknown): void;
