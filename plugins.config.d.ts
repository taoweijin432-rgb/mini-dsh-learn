// plugins.config.js 的类型声明。
// 它只描述默认导出的配置数组，不参与运行时执行。

type ExternalPluginConfig = {
  package: string;
  required?: boolean;
  config?: Record<string, unknown>;
};

declare const config: ExternalPluginConfig[];
export default config;
