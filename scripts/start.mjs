#!/usr/bin/env node
// 总启动入口：确保 engine 二进制在位，然后运行网关。
//
// 网关自己会拉起 engine 与各 channel 子进程，所以这里只负责「编译 + 前台运行」。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEngine, engineBuilt, engineBinary } from './build-engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gatewayPath = path.join(root, 'gateway', 'gateway.mjs');

async function hasGo() {
  return new Promise(resolve => {
    const child = spawn('go', ['version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', code => resolve(code === 0));
  });
}

async function ensureEngine({ force, skip }) {
  if (skip) {
    if (await engineBuilt()) {
      console.log('[start] --no-build：直接使用已有的 engine 二进制');
      return;
    }
    throw new Error(`engine 二进制不存在（${engineBinary()}）。去掉 --no-build 让脚本编译，或先跑 npm run setup`);
  }
  if (force || await hasGo()) {
    await buildEngine();
    return;
  }
  // 没装 Go 但二进制已经在位（比如从别处拷来的、或上游 release），允许直接跑。
  if (await engineBuilt()) {
    console.warn('[start] 未检测到 go，跳过编译，直接使用已有的 engine 二进制');
    return;
  }
  throw new Error(
    `engine 二进制不存在（${engineBinary()}），且未检测到 go。\n`
    + '  装 Go 1.22+ 后重试：https://go.dev/dl/\n'
    + '  或者运行 npm run setup 拉取并编译两个渠道',
  );
}

const force = process.argv.includes('--build');
const skip = process.argv.includes('--no-build');

await ensureEngine({ force, skip });
console.log('[start] 启动网关...');

// 前台运行网关；Ctrl+C 时网关自己会先收掉 engine 和 channel 子进程。
const gateway = spawn(process.execPath, [gatewayPath], { cwd: root, stdio: 'inherit' });
gateway.on('exit', code => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try {
      gateway.kill(signal);
    } catch {}
  });
}
