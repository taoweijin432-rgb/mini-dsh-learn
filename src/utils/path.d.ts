// src/utils/path.d.ts
// path.js 的类型声明，帮助 TypeScript 检查使用方。

export function isInside(workspace: string, target: string): boolean;
export function resolveInside(workspace: string, requested: string): string;
