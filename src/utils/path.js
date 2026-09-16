// src/utils/path.js
//
// 这里是工作区路径的“两道闸门”：
// 1. 先用 path.resolve() + path.relative() 做词法判断；
// 2. 再用 fs.realpathSync() 检查软链实际指向的位置。
//
// 这样既能挡住 ../etc/passwd，也能挡住 workspace/link/passwd 这种
// “表面在工作区内、实际通过软链跳到外面”的路径。

import fs from 'node:fs';
import path from 'node:path';

function assertPathString(value) {
  if (typeof value !== 'string') {
    throw new TypeError('path must be a string');
  }
}

/**
 * 只做词法上的“是否位于目录内”判断。
 *
 * 注意：这个函数不会访问文件系统，也不会解析软链。
 * 因此它适合做第一道快速判断；真正需要安全放行时请调用 resolveInside。
 */
export function isInside(workspace, target) {
  assertPathString(workspace);
  assertPathString(target);

  const workspacePath = path.resolve(workspace);
  const targetPath = path.resolve(target);
  const relative = path.relative(workspacePath, targetPath);

  // relative === '' 表示 target 就是 workspace 根目录本身。
  // 只有“恰好是 ..”或“以 ../ 开头”才代表向工作区父目录逃逸。
  // 不能直接用 startsWith('..')，因为合法文件名 ..hidden 也会以 .. 开头。
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/**
 * 解析一个位于 workspace 内的路径，并返回词法路径。
 *
 * 返回词法路径而不是 realpath：用户输入 /tmp/workspace/file 时，
 * 报错和工具输出也应该继续显示这条用户熟悉的路径。
 */
export function resolveInside(workspace, requested) {
  assertPathString(workspace);
  assertPathString(requested);

  // path.resolve 会处理相对路径、绝对路径和中间的 .. 片段。
  const workspacePath = path.resolve(workspace);
  const targetPath = path.resolve(workspacePath, requested);

  // 第一关：判断规范化后的词法路径是否越过工作区边界。
  if (!isInside(workspacePath, targetPath)) {
    throw new Error('path escapes the workspace');
  }

  // 第二关：分别解析根目录和目标路径。
  // 两边都解析很重要：macOS 的 /tmp 可能本身就是指向 /private/tmp 的软链。
  const realWorkspace = realpathWithMissingTail(workspacePath);
  const realTarget = realpathWithMissingTail(targetPath);

  if (!isInside(realWorkspace, realTarget)) {
    throw new Error('path escapes the workspace through a symlink');
  }

  return targetPath;
}

/**
 * 解析路径中已经存在的最长前缀，并把不存在的尾部接回来。
 *
 * 写入新文件时，完整目标往往还不存在；如果直接调用 realpathSync，
 * 会把所有新文件都误判成错误。因此需要逐级向上寻找已存在的父目录。
 */
function realpathWithMissingTail(input) {
  let current = input;
  const missingParts = [];

  while (true) {
    try {
      const realPrefix = fs.realpathSync(current);

      // missingParts 是从后往前收集的，所以要 reverse() 后再接回去。
      return missingParts
        .reverse()
        .reduce((resolved, part) => path.join(resolved, part), realPrefix);
    } catch (error) {
      // 只有“路径还不存在”才继续向父目录走；权限等其他错误必须保留。
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        throw error;
      }

      const parent = path.dirname(current);
      // 根目录也不存在时理论上不会发生；这是防止意外死循环的保护。
      if (parent === current) throw error;

      missingParts.push(path.basename(current));
      current = parent;
    }
  }
}
