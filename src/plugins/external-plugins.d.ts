// external-plugins.js 的 TypeScript 类型声明。
// 实现保留为 JavaScript，但这个声明文件让 TypeScript 知道动态 import() 的导出形状。

type ExternalPluginEntry = {
  package: string;
  required?: boolean;
  config?: unknown;
};

export const name: string;
export const inject: string[];
export function apply(
  ctx: unknown,
  entries?: ExternalPluginEntry[],
): Promise<void>;
