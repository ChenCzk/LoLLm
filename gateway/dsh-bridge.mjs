import { mkdir, readFile, readdir, rename, unlink, watch, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const REGION_REALM = { cn: 'cn', ai: 'global' };

function expandHome(input) {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return path.join(homedir(), input.slice(2));
  return input;
}

function unixSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  if (value > 1_000_000_000_000) return Math.floor(value / 1000);
  if (value > 1_000_000_000) return Math.floor(value);
  return 0;
}

function slug(value) {
  return String(value || 'account')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'account';
}

function maskUid(value) {
  const text = String(value || '');
  if (text.length <= 12) return `${text.slice(0, 4)}...`;
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function realmFromDomain(domain) {
  const value = String(domain || '').toLowerCase();
  return value === 'workbuddy.ai' || value.endsWith('.workbuddy.ai') ? 'global' : 'cn';
}

function parseDocument(raw, source) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const auth = parsed.auth && typeof parsed.auth === 'object' ? parsed.auth : parsed;
  const account = parsed.account && typeof parsed.account === 'object' ? parsed.account : parsed;
  if (typeof auth.accessToken !== 'string' || auth.accessToken === '') return null;
  if (typeof account.uid !== 'string' || account.uid === '') return null;
  return { auth, account };
}

function targetName(realm, uid) {
  return `workbuddy-dsh-${realm}-${slug(uid)}.json`;
}

async function scanRegion(root, region) {
  const dir = path.join(root, region);
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const found = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.info') || name === 'active.info') continue;
    const source = path.join(dir, name);
    let raw;
    try {
      raw = await readFile(source, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseDocument(raw, source);
    if (!parsed) continue;
    const realm = REGION_REALM[region] ?? realmFromDomain(parsed.auth.domain);
    found.push({
      id: `${realm}:${parsed.account.uid}`,
      realm,
      uid: parsed.account.uid,
      label: parsed.account.nickname || maskUid(parsed.account.uid),
      domain: parsed.auth.domain || '',
      expiresAt: unixSeconds(parsed.auth.expiresAt),
      sourceName: name,
      source,
      document: {
        auth: {
          ...parsed.auth,
          expiresAt: unixSeconds(parsed.auth.expiresAt),
          realm,
        },
        account: { ...parsed.account },
      },
    });
  }
  return found;
}

async function readTarget(authDir, file) {
  try {
    return parseDocument(await readFile(path.join(authDir, file), 'utf8'), file);
  } catch {
    return null;
  }
}

export async function syncDshCredentials(config) {
  const root = expandHome(config.root);
  const authDir = path.resolve(config.authDir);
  await mkdir(authDir, { recursive: true });

  const accounts = [
    ...(await scanRegion(root, 'cn')),
    ...(await scanRegion(root, 'ai')),
  ];
  const imported = [];
  let changed = false;

  for (const account of accounts) {
    const file = targetName(account.realm, account.uid);
    const target = path.join(authDir, file);
    const current = await readTarget(authDir, file);
    if (current && unixSeconds(current.auth.expiresAt) >= account.expiresAt) continue;

    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(account.document, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, target);
    imported.push(account.label);
    changed = true;
  }

  return {
    changed,
    imported,
    total: accounts.length,
    accounts: accounts.map(account => ({
      label: account.label,
      uidMasked: maskUid(account.uid),
      realm: account.realm,
      domain: account.domain,
      source: account.sourceName,
      expiresAt: account.expiresAt || null,
      file: targetName(account.realm, account.uid),
    })),
  };
}

export function watchDshCredentials(config, onChange) {
  if (!config.watch) return () => {};
  const root = expandHome(config.root);
  const watchers = [];
  let timer;

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const result = await syncDshCredentials(config);
        if (result.changed) onChange(result);
      } catch (error) {
        console.error(`[dsh-bridge] 同步失败: ${error.message}`);
      }
    }, 500);
  };

  for (const region of ['cn', 'ai']) {
    const dir = path.join(root, region);
    try {
      const watcher = watch(dir, { persistent: true }, schedule);
      watchers.push(watcher);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  return () => {
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}
