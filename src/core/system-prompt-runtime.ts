// src/core/system-prompt-runtime.ts

/**
 * 一段系统提示词。
 *
 * 提示词不是写死在一个大字符串里，而是拆成很多 fragment。
 * 例如：角色设定、输出格式、当前时间、工具使用规则等。
 */
export type PromptFragment = {
  name: string; // 唯一名称，用于注册、查找和撤销
  order: number; // 数字越小越靠前

  // text 可以是固定字符串，也可以是“生成字符串的函数”。
  // 函数允许异步，因此可以在组装时读取文件、数据库或当前时间。
  text: string | ((assembleContext: any) => string | Promise<string>);
};

/**
 * 组装动态提示词时传入的上下文。
 */
export type AssembleContext = {
  agent?: any; // 当前 Agent
  sessionId?: string; // 当前会话 ID
  step?: number; // Agent Loop 当前步数
  [key: string]: any; // 允许业务继续扩展字段
};

/**
 * 系统提示词运行时。
 *
 * 它维护两类片段：
 * - sections：通常是固定的规则或说明；
 * - contexts：通常是随会话或每一步变化的动态信息。
 */
export class SystemPromptRuntime {
  // 用 Map 按名称保存片段，便于判断重名和快速删除。
  private sections = new Map<string, PromptFragment>();
  private contexts = new Map<string, PromptFragment>();

  /**
   * 注册一个 section。
   *
   * 返回 disposer，调用 disposer 就会移除这段提示词。
   */
  section(
    fragment: Omit<PromptFragment, 'text'> & {
      text: string | (() => string | Promise<string>);
    }
  ): () => void {
    return this.registerFragment(this.sections, fragment);
  }

  /**
   * 注册一个动态 context。
   *
   * 和 section 的主要区别是语义：
   * context 的函数可以接收 assemble 时传入的上下文对象。
   */
  context(
    fragment: Omit<PromptFragment, 'text'> & {
      text: string | ((ctx: any) => string | Promise<string>);
    }
  ): () => void {
    return this.registerFragment(this.contexts, fragment);
  }

  /**
   * 注册片段的公共内部实现。
   *
   * section() 和 context() 的保存逻辑相同，
   * 所以抽成一个方法，避免复制两份代码。
   */
  private registerFragment(
    map: Map<string, PromptFragment>,
    fragment: { name: string; order: number; text: string | ((...args: any[]) => any) }
  ): () => void {
    // 尽早校验，错误配置在注册时就应该失败。
    if (!fragment.name) throw new Error('fragment.name is required');
    if (map.has(fragment.name)) {
      throw new Error(`fragment "${fragment.name}" already exists`);
    }
    if (fragment.order == null) {
      throw new Error(`fragment.order is required for "${fragment.name}"`);
    }

    // 保存一份标准化后的对象。
    const entry: PromptFragment = {
      name: fragment.name,
      order: fragment.order,
      text: fragment.text,
    };
    map.set(fragment.name, entry);

    // disposer 只撤销自己注册的 entry，避免误删同名的其他对象。
    let disposed = false;
    return () => {
      if (disposed) return;
      if (map.get(fragment.name) === entry) {
        map.delete(fragment.name);
      }
      disposed = true;
    };
  }

  /**
   * 组装最终的 system prompt。
   */
  async assemble(context: AssembleContext = {}): Promise<string> {
    // section 和 context 最终都属于 system prompt，所以先合并。
    const allFragments = [...this.sections.values(), ...this.contexts.values()];

    // 按 order 从小到大排序，决定最终提示词中的出现顺序。
    allFragments.sort((a, b) => a.order - b.order);

    const pieces: string[] = [];
    for (const frag of allFragments) {
      let text: string;

      if (typeof frag.text === 'function') {
        // 动态片段在组装时才执行，并等待异步结果。
        text = await frag.text(context);
      } else {
        // 静态片段直接使用已有字符串。
        text = frag.text;
      }

      // 忽略空字符串，并去掉片段两端多余的空白。
      if (text && text.trim()) {
        pieces.push(text.trim());
      }
    }

    // 片段之间用两个换行分隔，让最终 prompt 更易读。
    return pieces.join('\n\n');
  }

  /**
   * 返回片段清单，不返回实际文本。
   *
   * 适合 CLI 调试：可以看到有哪些片段和顺序，
   * 但不会把可能包含敏感信息的 prompt 内容直接打印出来。
   */
  inspect(): {
    sections: { name: string; order: number }[];
    contexts: { name: string; order: number }[];
  } {
    // 只提取名称和顺序，不暴露 text。
    const toEntry = (frag: PromptFragment) => ({
      name: frag.name,
      order: frag.order,
    });

    return {
      sections: Array.from(this.sections.values()).map(toEntry),
      contexts: Array.from(this.contexts.values()).map(toEntry),
    };
  }
}
