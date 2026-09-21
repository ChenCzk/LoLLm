import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncDshCredentials } from '../gateway/dsh-bridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(root, 'gateway/config.json'), 'utf8'));
const result = await syncDshCredentials(config.dsh);
console.log(JSON.stringify(result, null, 2));
