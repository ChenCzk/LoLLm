#!/usr/bin/env node
// 拉取并编译两个第三方渠道，补上 Qoder 的 CN 补丁。
//
// 这两个子项目都不进版本库：它们各自有上游仓库与自己的许可证
// （engine 是 MIT，qodercli2api 是 AGPL-3.0），本仓库只保存「从哪来、
// 哪个 commit、打了什么补丁」，别人拉下来跑一次本脚本即可复现。
import { spawn } from 'node:child_process';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEngine, engineBinary } from './build-engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ENGINE = {
  name: 'workbuddy2api-panel',
  dir: path.join(root, 'channels', 'workbuddy2api-panel'),
  repo: 'https://github.com/linguo2625469/workbuddy2api-panel.git',
  commit: 'c192fd18a4fb9483b7f9563ebb39ee319c9ba91b',
};

const QODER = {
  name: 'qodercli2api',
  dir: path.join(root, '.qoder-src'),
  repo: 'https://github.com/Liki4/qodercli2api.git',
  commit: 'b8b595fabbed733c5899019fed4b660ea23d94e0',
  patch: path.join(root, 'patches', 'qodercli2api-cn-queue.patch'),
  binary: path.join(root, '.qoder-src', `qodercli2api${process.platform === 'win32' ? '.exe' : ''}`),
};

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', error => reject(
      error.code === 'ENOENT'
        ? new Error(`找不到 ${command}，请先安装（git 与 go 都需要在 PATH 里）`)
        : error,
    ));
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`))));
  });
}

async function exists(target) {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// 已经 clone 过就跳过，避免覆盖用户手动改过的代码。
async function ensureSource(spec) {
  if (await exists(path.join(spec.dir, '.git'))) {
    console.log(`[setup] ${spec.name} 已存在，跳过 clone`);
    return;
  }
  if (await exists(spec.dir)) {
    const entries = await readdir(spec.dir);
    if (entries.length) {
      console.warn(`[setup] ${spec.dir} 已存在且非空但不是 git 仓库，跳过 clone（需要的话请手动清理）`);
      return;
    }
  }
  await mkdir(path.dirname(spec.dir), { recursive: true });
  console.log(`[setup] clone ${spec.name} @ ${spec.commit.slice(0, 12)}`);
  await run('git', ['clone', '--no-checkout', spec.repo, spec.dir]);
  await run('git', ['-C', spec.dir, 'checkout', spec.commit]);
}

async function setupEngine() {
  await ensureSource(ENGINE);
  await mkdir(path.join(ENGINE.dir, 'auths'), { recursive: true });
  await mkdir(path.join(ENGINE.dir, 'data'), { recursive: true });
  console.log('[setup] 编译 engine...');
  await buildEngine();
  console.log(`[setup] engine 就绪：${engineBinary()}`);
}

async function setupQoder() {
  await ensureSource(QODER);
  if (await exists(QODER.patch)) {
    const marker = path.join(QODER.dir, '.cn-queue-patch-applied');
    if (await exists(marker)) {
      console.log('[setup] qodercli2api CN 补丁已打过，跳过');
    } else {
      console.log('[setup] 应用 CN 队列补丁...');
      try {
        await run('git', ['-C', QODER.dir, 'apply', '-p1', '--check', QODER.patch]);
        await run('git', ['-C', QODER.dir, 'apply', '-p1', QODER.patch]);
        await writeFile(marker, 'patches/qodercli2api-cn-queue.patch\n');
      } catch (error) {
        // 上游更新后补丁可能冲突，别让整个 setup 挂掉：Qoder 只是其中一个渠道。
        console.warn(`[setup] 补丁未能应用：${error.message}`);
        console.warn('[setup] Qoder 渠道仍可用，但 CN 侧排队（10605）不会自动重试');
      }
    }
  }
  console.log('[setup] 编译 qodercli2api...');
  await run('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', QODER.binary, '.'], {
    cwd: QODER.dir,
    env: {
      ...process.env,
      CGO_ENABLED: '0',
      GOPROXY: process.env.GOPROXY || 'https://goproxy.cn,https://proxy.golang.org,direct',
    },
  });
  console.log(`[setup] qodercli2api 就绪：${QODER.binary}`);

  const cache = path.join(homedir(), '.qoder-cn', '.models');
  if (!await exists(cache)) {
    console.warn(`[setup] 未发现 Qoder CN 模型目录缓存：${cache}`);
    console.warn('[setup] 装好 Qoder CN 客户端并登录一次，或手工登录：');
    console.warn(`[setup]   ${QODER.binary} -auth-dir ${path.join(root, '.qoder-auth-cn')} -login \\`);
    console.warn('[setup]     -web-endpoint https://qoder.com.cn -openapi-endpoint https://openapi.qoder.com.cn');
  } else {
    const credDir = path.join(root, '.qoder-auth-cn');
    if (!await exists(path.join(credDir, 'user'))) {
      console.warn(`[setup] Qoder 凭据缺失：${path.join(credDir, 'user')}`);
      console.warn(`[setup]   ${QODER.binary} -auth-dir ${credDir} -login \\`);
      console.warn('[setup]     -web-endpoint https://qoder.com.cn -openapi-endpoint https://openapi.qoder.com.cn');
    }
  }
}

async function main() {
  const only = process.argv.find(arg => arg.startsWith('--only='))?.slice('--only='.length);
  console.log(`[setup] 平台 ${process.platform}，项目根 ${root}`);
  if (!only || only === 'engine') await setupEngine();
  if (!only || only === 'qoder') await setupQoder();

  const configPath = path.join(root, 'gateway', 'config.json');
  if (!await exists(configPath)) {
    const example = await readFile(path.join(root, 'gateway', 'config.example.json'), 'utf8');
    JSON.parse(example);
    await writeFile(configPath, example, { mode: 0o600 });
    console.log('[setup] 已从 config.example.json 生成 gateway/config.json，请按需修改凭据');
  }
  console.log('[setup] 完成。下一步：npm start');
}

main().catch(async error => {
  console.error(`[setup] ${error.message}`);
  process.exit(1);
});
