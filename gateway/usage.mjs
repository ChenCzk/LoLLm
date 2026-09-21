import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const officialUsagePath = path.join(root, 'gateway', 'data', 'usage.json');
let writeQueue = Promise.resolve();

function emptyStats() {
  return {
    requests: 0,
    errors: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
}

function addStats(target, entry = {}) {
  target.requests += Number(entry.requests) || 0;
  target.errors += Number(entry.errors) || 0;
  target.promptTokens += Number(entry.promptTokens) || 0;
  target.completionTokens += Number(entry.completionTokens) || 0;
  target.totalTokens += Number(entry.totalTokens) || 0;
}

async function readJsonRecords(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (Array.isArray(parsed)) return parsed.filter(item => item && typeof item === 'object');
    if (Array.isArray(parsed.records)) return parsed.records.filter(item => item && typeof item === 'object');
    if (Array.isArray(parsed.buckets)) return parsed.buckets.filter(item => item && typeof item === 'object');
    return [];
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`[usage] read failed ${file}: ${error.message}`);
    return [];
  }
}

export async function recordOfficialUsage(entry) {
  const operation = writeQueue.then(async () => {
    const records = await readJsonRecords(officialUsagePath);
    records.push({
      at: new Date().toISOString(),
      source: 'glm-official',
      channelId: 'glm-official',
      requests: 1,
      errors: 0,
      ...entry,
    });
    await mkdir(path.dirname(officialUsagePath), { recursive: true });
    const temp = `${officialUsagePath}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, officialUsagePath);
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

function workbuddyEntry(row) {
  const rawModel = String(row.m || row.model || '');
  const match = /^(cn|global):(.+)$/u.exec(rawModel);
  const model = (match ? match[2] : rawModel).trim();
  if (!model) return null;
  return {
    source: (row.r || row.realm) === 'global' ? 'wbAI' : 'wb',
    model,
    requests: Number(row.q ?? row.requests) || 0,
    errors: Number(row.e ?? row.errors) || 0,
    promptTokens: Number(row.p ?? row.promptTokens) || 0,
    completionTokens: Number(row.c ?? row.completionTokens) || 0,
    totalTokens: Number(row.t ?? row.totalTokens) || 0,
  };
}

function officialEntry(row) {
  const model = String(row.model || '').trim();
  if (!model) return null;
  return {
    source: row.source || 'glm-official',
    model,
    requests: Number(row.requests) || 0,
    errors: Number(row.errors) || 0,
    promptTokens: Number(row.promptTokens) || 0,
    completionTokens: Number(row.completionTokens) || 0,
    totalTokens: Number(row.totalTokens) || 0,
  };
}

export async function aggregateUsage(config) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const workbuddyPath = path.join(
    rootDir,
    config.engine?.cwd || 'channels/workbuddy2api-panel',
    'data/usage.json',
  );
  const [workbuddyRows, officialRows] = await Promise.all([
    readJsonRecords(workbuddyPath),
    readJsonRecords(officialUsagePath),
  ]);

  const totals = emptyStats();
  const sources = new Map();
  const models = new Map();
  let truncated = false;

  for (const row of [...workbuddyRows, ...officialRows]) {
    const entry = row.source === 'glm-official' ? officialEntry(row) : workbuddyEntry(row);
    if (!entry) continue;

    if (!sources.has(entry.source)) sources.set(entry.source, emptyStats());
    const sourceStats = sources.get(entry.source);
    if (!models.has(entry.model)) models.set(entry.model, new Map());
    const modelSources = models.get(entry.model);
    if (!modelSources.has(entry.source)) modelSources.set(entry.source, emptyStats());
    const modelStats = modelSources.get(entry.source);

    addStats(totals, entry);
    addStats(sourceStats, entry);
    addStats(modelStats, entry);
  }

  if (workbuddyRows.length > 20000 || officialRows.length > 20000) truncated = true;
  const sourceObject = Object.fromEntries([...sources.entries()].sort(([left], [right]) => left.localeCompare(right)));
  const modelObject = Object.fromEntries([...models.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([model, modelSources]) => [model, Object.fromEntries(modelSources)]));

  return {
    generatedAt: new Date().toISOString(),
    totals,
    sources: sourceObject,
    models: modelObject,
    inputs: {
      workbuddyRecords: workbuddyRows.length,
      officialRecords: officialRows.length,
      workbuddyPath,
      officialPath: officialUsagePath,
      truncated,
    },
  };
}
