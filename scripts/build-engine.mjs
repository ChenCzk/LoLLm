#!/usr/bin/env node
// 编译 WorkBuddy Channel Engine（channels/workbuddy2api-panel）。
//
// 用 Node 而不是 bash：Git Bash 在 Windows 上不是默认就有，而这些脚本
// 只是「拼一条命令 + 传退出码」，Node 在三个平台行为一致。
import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = path.join(root, 'channels', 'workbuddy2api-panel');
const suffix = process.platform === 'win32' ? '.exe' : '';
const output = `wb2api${suffix}`;

export function engineBinary() {
  return path.join(engineDir, output);
}

export async function engineBuilt() {
  try {
    await access(engineBinary(), fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function buildEngine() {
  return new Promise((resolve, reject) => {
    // cgo 关掉，产出静态单文件；goproxy.cn 优先，国内网络不用额外配。
    const env = {
      ...process.env,
      CGO_ENABLED: '0',
      GOPROXY: process.env.GOPROXY || 'https://goproxy.cn,https://proxy.golang.org,direct',
    };
    const child = spawn(
      'go',
      ['build', '-trimpath', '-ldflags=-s -w', '-o', output, './cmd/server'],
      { cwd: engineDir, env, stdio: 'inherit' },
    );
    child.on('error', error => {
      reject(new Error(
        error.code === 'ENOENT'
          ? '找不到 go 命令。装一个 Go 1.22+ 并确保在 PATH 里：https://go.dev/dl/'
          : error.message,
      ));
    });
    child.on('exit', code => {
      if (code === 0) resolve(engineBinary());
      else reject(new Error(`go build 失败，退出码 ${code}`));
    });
  });
}

async function main() {
  await mkdir(path.join(engineDir, 'auths'), { recursive: true });
  await mkdir(path.join(engineDir, 'data'), { recursive: true });
  const bin = await buildEngine();
  console.log(`[build:engine] 完成：${bin}`);
}

// Windows 上 import.meta.url 与 argv[1] 的分隔符/盘符写法不一致，必须归一化后比较。
const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntry) {
  main().catch(error => {
    console.error(`[build:engine] ${error.message}`);
    process.exit(1);
  });
}
