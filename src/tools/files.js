// src/tools/files.js
//
// 这里把文件能力注册成五个普通 ToolRuntime 工具。
// 它们不自己判断“路径是否安全”，所有路径统一交给 ctx.sandbox。

import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInside } from '../utils/path.js';

const textParameters = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Path relative to the workspace' },
  },
  required: ['path'],
};

/**
 * 判断一个相对文件名是否匹配搜索模式。
 *
 * 不带通配符时使用子串匹配；带 * 时，* 不跨目录，** 可以跨目录。
 * 没有目录分隔符的模式（例如 *.md）按 basename 匹配，因此能找到嵌套目录中的文件。
 */
export function matchFilePattern(fileName, pattern) {
  if (typeof fileName !== 'string' || typeof pattern !== 'string') return false;

  const file = normalizeSeparators(fileName);
  const normalizedPattern = normalizeSeparators(pattern);
  if (!normalizedPattern.includes('*')) return file.includes(normalizedPattern);

  const candidate = normalizedPattern.includes('/')
    ? file
    : path.posix.basename(file);
  return globRegex(normalizedPattern).test(candidate);
}

/**
 * 注册 read/write/edit/glob/grep 五个文件工具。
 */
export const name = 'mini-tools-files';
export const inject = ['tools', 'sandbox'];

export function apply(ctx) {
  const definitions = createDefinitions(ctx.sandbox);
  const disposers = [];

  try {
    for (const definition of definitions) {
      disposers.push(ctx.tools.register(definition));
    }
  } catch (error) {
    // 如果中途有一个工具注册失败，撤销前面已经注册成功的工具。
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }

  // 插件卸载时移除这五个工具，避免热加载或重复装配产生重名工具。
  ctx.effect(
    () => () => {
      for (const dispose of disposers.reverse()) dispose();
    },
    'register file tools',
  );
}

function createDefinitions(sandbox) {
  return [
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file inside the workspace.',
      parameters: textParameters,
      execute: async args => {
        const target = resolveInside(sandbox.workspace, getPath(args));
        return fs.readFile(target, 'utf8');
      },
    },
    {
      name: 'write_file',
      description: 'Write a UTF-8 text file inside the workspace after approval.',
      parameters: {
        ...textParameters,
        properties: {
          ...textParameters.properties,
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
      execute: async (args) => {
        const target = resolveInside(sandbox.workspace, getPath(args));
        assertText(args?.content, 'content');
        await sandbox.approve({
          tool: 'write_file',
          summary: `write ${getPath(args)}`,
        });
        await fs.writeFile(target, args.content, 'utf8');
        return `Wrote ${target}`;
      },
    },
    {
      name: 'edit_file',
      description: 'Replace one unique text fragment in a workspace file after approval.',
      parameters: {
        ...textParameters,
        properties: {
          ...textParameters.properties,
          oldText: { type: 'string' },
          newText: { type: 'string' },
        },
        required: ['path', 'oldText', 'newText'],
      },
      execute: async (args) => {
        const requested = getPath(args);
        const target = resolveInside(sandbox.workspace, requested);
        assertText(args?.oldText, 'oldText');
        assertText(args?.newText, 'newText');
        const original = await fs.readFile(target, 'utf8');
        const matches = countOccurrences(original, args.oldText);
        if (matches === 0) throw new Error('oldText not found');
        if (matches > 1) {
          throw new Error('oldText is not unique; refusing an ambiguous edit');
        }

        await sandbox.approve({
          tool: 'edit_file',
          summary: `edit ${requested}`,
        });
        await fs.writeFile(target, original.replace(args.oldText, args.newText), 'utf8');
        return `Edited ${target}`;
      },
    },
    {
      name: 'glob',
      description: 'List workspace files matching a substring or glob pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Optional directory inside the workspace' },
        },
        required: ['pattern'],
      },
      execute: async args => {
        assertText(args?.pattern, 'pattern');
        const base = resolveInside(sandbox.workspace, args?.path ?? '.');
        const files = await collectFiles(base);
        return files
          .map(file => toWorkspaceRelative(sandbox.workspace, file))
          .filter(file => matchFilePattern(file, args.pattern))
          .sort();
      },
    },
    {
      name: 'grep',
      description: 'Search text in workspace files using a regular expression.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Optional file or directory inside the workspace' },
        },
        required: ['pattern'],
      },
      execute: async args => {
        assertText(args?.pattern, 'pattern');
        const base = resolveInside(sandbox.workspace, args?.path ?? '.');
        const files = await collectFiles(base);
        const expression = new RegExp(args.pattern);
        const matches = [];

        for (const file of files) {
          const content = await fs.readFile(file, 'utf8');
          content.split(/\r?\n/).forEach((line, lineIndex) => {
            if (expression.test(line)) {
              matches.push(`${toWorkspaceRelative(sandbox.workspace, file)}:${lineIndex + 1}:${line}`);
            }
            // 没有 g 标志时 lastIndex 不会变化；重置也能兼容未来传入带 g 的表达式。
            expression.lastIndex = 0;
          });
        }
        return matches.join('\n');
      },
    },
  ];
}

function getPath(args) {
  return args?.path ?? args?.file_path;
}

function assertText(value, name) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
}

function countOccurrences(text, fragment) {
  if (!fragment.length) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const found = text.indexOf(fragment, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + fragment.length;
  }
}

async function collectFiles(start) {
  // resolveInside 已经检查过软链边界，这里使用 stat 让“指向工作区内的软链文件”仍可被读取。
  const stat = await fs.stat(start);
  if (stat.isFile()) return [start];
  if (!stat.isDirectory()) return [];

  const files = [];
  await walkDirectory(start, files);
  return files;
}

async function walkDirectory(directory, files) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    // 不跟随软链遍历目录，避免搜索阶段把工作区外的内容带进来。
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walkDirectory(fullPath, files);
    else if (entry.isFile()) files.push(fullPath);
  }
}

function toWorkspaceRelative(workspace, file) {
  return path.relative(workspace, file).split(path.sep).join('/');
}

function normalizeSeparators(value) {
  return value.replaceAll('\\', '/');
}

function globRegex(pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          source += '(?:.*/)?';
          index += 1;
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else {
      source += escapeRegexCharacter(character);
    }
  }
  return new RegExp(`${source}$`);
}

function escapeRegexCharacter(character) {
  return /[\\^$+?.()|[\]{}]/.test(character) ? `\\${character}` : character;
}
