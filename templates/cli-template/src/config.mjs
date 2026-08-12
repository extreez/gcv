/** Config and API key resolution. CLI-CONTRACT v1 §9. Not to be edited per service. */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { auth } from './errors.mjs';
import { PROVIDER } from './provider.mjs';

export const SERVICE = PROVIDER.id;
export const CONTRACT = '1';

export const GCV_HOME = process.env.GCV_HOME || join(homedir(), '.gcv');
export const CONFIG_PATH = join(GCV_HOME, 'config.json');
export const CACHE_DIR = join(GCV_HOME, 'cache', SERVICE);
export const CATALOG_PATH = join(CACHE_DIR, 'catalog.json');
export const LEDGER_PATH = join(GCV_HOME, 'ledger.jsonl');
export const IDEMPOTENCY_PATH = join(GCV_HOME, 'idempotency.json');
export const DEFAULT_OUTPUT_DIR = join(GCV_HOME, 'output');

const ENV_NAMES = [PROVIDER.apiKeyEnv, `GCV_${SERVICE.toUpperCase()}_API_KEY`].filter(Boolean);

let mcpApiKey = null;
export const setMcpApiKey = (k) => { mcpApiKey = k || null; };

export function ensureHome() {
  mkdirSync(GCV_HOME, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });
}

export function readConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { throw new Error(`Config file is corrupted (${CONFIG_PATH}): ${e.message}`); }
}

export function writeConfig(cfg) {
  ensureHome();
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  try { chmodSync(CONFIG_PATH, 0o600); } catch { /* Windows */ }
}

export function setConfigValue(path, value) {
  const cfg = readConfig();
  const parts = path.split('.');
  let node = cfg;
  for (const p of parts.slice(0, -1)) {
    if (typeof node[p] !== 'object' || node[p] === null) node[p] = {};
    node = node[p];
  }
  node[parts.at(-1)] = value;
  writeConfig(cfg);
  return cfg;
}

export const getConfigValue = (path) =>
  path.split('.').reduce((a, p) => (a == null ? a : a[p]), readConfig());

function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function findProjectEnv(startDir) {
  let dir = resolve(startDir);
  const stop = resolve(homedir(), '..');
  for (let i = 0; i < 24; i++) {
    for (const name of ['.env', '.env.local']) {
      const p = join(dir, name);
      if (existsSync(p)) {
        try { return { path: p, vars: parseEnvFile(readFileSync(p, 'utf8')) }; } catch { /* an unreadable .env must not crash the CLI */ }
      }
    }
    const parent = resolve(dir, '..');
    if (parent === dir || parent === stop) break;
    dir = parent;
  }
  return null;
}

export function resolveApiKey(explicitKey, cwd = process.cwd()) {
  if (explicitKey) return { key: explicitKey, source: 'flag:--api-key' };

  const envFile = findProjectEnv(cwd);
  if (envFile) {
    for (const n of ENV_NAMES) if (envFile.vars[n]) return { key: envFile.vars[n], source: `dotenv:${envFile.path}#${n}` };
  }
  for (const n of ENV_NAMES) if (process.env[n]) return { key: process.env[n], source: `env:${n}` };
  const fromConfig = getConfigValue(`providers.${SERVICE}.apiKey`);
  if (fromConfig) return { key: fromConfig, source: `config:${CONFIG_PATH}` };

  // Аргумент MCP-сервера — последний: ключ из конфига CLI работает везде.
  if (mcpApiKey) return { key: mcpApiKey, source: 'mcp:--api-key' };

  return { key: null, source: 'none' };
}

export function requireApiKey(explicitKey, cwd) {
  const r = resolveApiKey(explicitKey, cwd);
  if (!r.key) {
    throw auth(
      `${PROVIDER.name} API key not found. Set it in one of these ways:\n` +
        `  ${ENV_NAMES[0]}=... in the project .env\n` +
        `  export ${ENV_NAMES[0]}=...\n` +
        `  gcv-${SERVICE} config set providers.${SERVICE}.apiKey <key>\n` +
        (PROVIDER.apiKeyUrl ? `Get a key at ${PROVIDER.apiKeyUrl}` : ''),
    );
  }
  return r;
}

export const maskKey = (k) => (!k ? null : k.length <= 10 ? '***' : `${k.slice(0, 4)}…${k.slice(-4)}`);

/** Rate of the service's internal currency to USD. null when unset. Never invented. */
export function unitUsdRate() {
  if (PROVIDER.currency === 'usd') return 1;
  const v = getConfigValue(`providers.${SERVICE}.creditUsd`);
  return typeof v === 'number' && v > 0 ? v : null;
}

export function toUsd(amount) {
  const rate = unitUsdRate();
  if (rate == null || amount == null) return null;
  return Math.round(amount * rate * 1e6) / 1e6;
}

export const BASE_URL = () =>
  process.env[`${SERVICE.toUpperCase()}_BASE_URL`] ||
  getConfigValue(`providers.${SERVICE}.baseUrl`) ||
  PROVIDER.baseUrl;

/**
 * Where results go when --out is not passed explicitly. Downloading is ON by
 * default — with most services results live for a limited time, so silently
 * skipping the download means silently losing the result.
 * A flat folder, no per-date subfolder — the date is in the file name (see generate.mjs).
 * @returns {{dir: string|null, source: string, enabled: boolean}}
 */
export function resolveOutputDir() {
  if (getConfigValue('download.enabled') === false) {
    return { dir: null, source: 'config:download.enabled=false', enabled: false };
  }
  const configured = getConfigValue('download.dir');
  if (configured) return { dir: configured, source: `config:${CONFIG_PATH}#download.dir`, enabled: true };
  return { dir: DEFAULT_OUTPUT_DIR, source: 'default', enabled: true };
}
