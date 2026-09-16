// test/integration.test.ts
//
// 这些测试不直接 new ToolRuntime，而是使用真实 Cordis Context 装配插件。
// 这样可以验证“插件依赖注入 -> ctx.sandbox/ctx.tools -> 工具执行”的完整接线。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';

test('Cordis Context wires sandbox, file tools, and bash tools', async () => {
  const root = new Context();
  // Cordis 会在运行时把插件服务混入 ctx；当前测试文件只需告诉 TS 允许动态属性。
  const ctx: any = root;
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-integration-'));
  const fibers = [];

  try {
    const systemPrompt = await import('../src/plugins/system-prompt.js');
    const tools = await import('../src/plugins/tools.js');
    const sandbox = await import('../src/plugins/sandbox.js');
    const fileTools = await import('../src/tools/files.js');
    const bashTool = await import('../src/tools/bash.js');

    // 按依赖顺序加载：prompt -> tools -> sandbox -> 具体工具。
    fibers.push(await root.plugin(systemPrompt));
    fibers.push(await root.plugin(tools));
    fibers.push(await root.plugin(sandbox, { workspace, autoApprove: true }));
    fibers.push(await root.plugin(fileTools));
    fibers.push(await root.plugin(bashTool));

    assert.equal(ctx.sandbox.workspace, path.resolve(workspace));
    assert.deepEqual(
      ctx.tools.list().map((tool: any) => tool.name),
      ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash'],
    );

    const written = await ctx.tools.execute('write_file', {
      path: 'hello.txt',
      content: 'hello from Cordis',
    });
    assert.equal(written.isError, false);

    const read = await ctx.tools.execute('read_file', { path: 'hello.txt' });
    assert.equal(read.value, 'hello from Cordis');

    const command = await ctx.tools.execute('bash', { command: 'printf cordis-ok' });
    assert.equal(command.isError, false);
    assert.equal(command.value, 'cordis-ok');

    const prompt = await ctx.systemPrompt.assemble();
    assert.match(prompt, /application-layer sandbox/);
  } finally {
    // 子 fiber 逆序卸载，模拟 Cordis 正常的生命周期回收。
    for (const fiber of fibers.reverse()) await fiber.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('Cordis Context disposes file tools and sandbox policy with their fibers', async () => {
  const root = new Context();
  const ctx: any = root;
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-dispose-'));
  const fibers = [];

  try {
    const systemPrompt = await import('../src/plugins/system-prompt.js');
    const tools = await import('../src/plugins/tools.js');
    const sandbox = await import('../src/plugins/sandbox.js');
    const fileTools = await import('../src/tools/files.js');
    const bashTool = await import('../src/tools/bash.js');

    fibers.push(await root.plugin(systemPrompt));
    fibers.push(await root.plugin(tools));
    const sandboxFiber = await root.plugin(sandbox, { workspace, autoApprove: true });
    fibers.push(sandboxFiber);
    const fileFiber = await root.plugin(fileTools);
    fibers.push(fileFiber);
    const bashFiber = await root.plugin(bashTool);
    fibers.push(bashFiber);

    await fileFiber.dispose();
    await bashFiber.dispose();
    assert.deepEqual(ctx.tools.list(), []);

    await sandboxFiber.dispose();
    const prompt = await ctx.systemPrompt.assemble();
    assert.doesNotMatch(prompt, /application-layer sandbox/);
  } finally {
    // 已经单独 dispose 的 fiber 可以安全再次 dispose，Cordis disposer 是幂等的。
    for (const fiber of fibers.reverse()) await fiber.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
