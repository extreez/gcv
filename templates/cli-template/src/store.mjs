/**
 * Model catalog (CLI-CONTRACT §8), spend ledger and idempotency (§10).
 * Not to be edited per service.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CATALOG_PATH, LEDGER_PATH, IDEMPOTENCY_PATH, ensureHome, toUsd, SERVICE } from './config.mjs';
import { GcvError, validation } from './errors.mjs';
import * as provider from './provider.mjs';

const TTL_DAYS = 7;
const SEED = JSON.parse(readFileSync(new URL('./models.seed.json', import.meta.url), 'utf8'));

// ── catalog ──────────────────────────────────────────────────────────────────

export function load() {
  ensureHome();
  if (!existsSync(CATALOG_PATH)) {
    return { models: SEED.models || [], fetchedAt: null, ttlDays: TTL_DAYS, isStale: true, seeded: true };
  }
  try {
    const raw = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
    const ageDays = raw.fetchedAt ? (Date.now() - Date.parse(raw.fetchedAt)) / 86_400_000 : Infinity;
    return { models: raw.models || [], fetchedAt: raw.fetchedAt || null, ttlDays: TTL_DAYS, isStale: ageDays > TTL_DAYS, seeded: false };
  } catch (e) {
    throw new GcvError('INTERNAL', `Catalog cache is corrupted (${CATALOG_PATH}): ${e.message}`);
  }
}

export function save(models, extra = {}) {
  ensureHome();
  const payload = { contract: '1', provider: SERVICE, fetchedAt: new Date().toISOString(), ...extra, models };
  writeFileSync(CATALOG_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

export function normalizeModel(m) {
  if (!m?.id) throw validation('Model entry has no id field');
  const amount = m.price?.credits ?? m.price?.amount ?? null;
  const amountMax = m.price?.creditsMax ?? amount;
  return {
    id: String(m.id),
    provider: SERVICE,
    type: m.type ?? null,
    modes: m.modes ?? [],
    price: {
      unit: m.price?.unit ?? null,
      credits: amount,
      // Upper bound: with many services the price depends on resolution.
      creditsMax: amountMax,
      usd: m.price?.usd ?? toUsd(amount),
      usdMax: m.price?.usdMax ?? toUsd(amountMax),
      batch: m.price?.batch ?? 1,
      variants: m.price?.variants ?? (amount != null ? 1 : 0),
      basis: m.price?.basis ?? (amount != null ? 'single' : null),
      // Surcharge for input images, when the service bills it as a separate row
      inputSurcharge: m.price?.inputSurcharge ?? null,
    },
    priceVariants: m.priceVariants ?? null,
    required: m.required ?? null,
    endpoint: m.endpoint ?? null,
    title: m.title ?? null,
    limits: {
      maxRefs: m.limits?.maxRefs ?? null,
      maxPromptChars: m.limits?.maxPromptChars ?? null,
      aspectRatios: m.limits?.aspectRatios ?? null,
      maxDurationSec: m.limits?.maxDurationSec ?? null,
      resolutions: m.limits?.resolutions ?? null,
    },
    inputSchema: m.inputSchema ?? null,
    notes: m.notes ?? null,
    source: m.source ?? null,
    verified: m.verified === true,
    fetchedAt: m.fetchedAt ?? new Date().toISOString(),
  };
}

export function list({ type, mode, query } = {}) {
  const cat = load();
  let models = cat.models.map(normalizeModel);
  if (type) models = models.filter((m) => m.type === type);
  if (mode) models = models.filter((m) => m.modes?.includes(mode));
  if (query) {
    const q = query.toLowerCase();
    models = models.filter((m) => m.id.toLowerCase().includes(q) || (m.notes || '').toLowerCase().includes(q));
  }
  return { models, staleness: { fetchedAt: cat.fetchedAt, ttlDays: cat.ttlDays, isStale: cat.isStale, seeded: cat.seeded } };
}

export function show(id) {
  const { models, staleness } = list();
  const model = models.find((m) => m.id === id) || models.find((m) => m.id.endsWith(`/${id}`));
  if (!model) {
    throw validation(
      `Model "${id}" is not in the catalog. See what is available: gcv-${SERVICE} catalog list\n` +
        `To add a new model: gcv-${SERVICE} catalog set --model ${id} --type image --credits N`,
    );
  }
  return { model, staleness };
}

export function upsert(entry) {
  const cat = load();
  const models = (cat.seeded ? SEED.models || [] : cat.models).map(normalizeModel);
  const norm = normalizeModel(entry);
  const i = models.findIndex((m) => m.id === norm.id);
  if (i >= 0) models[i] = { ...models[i], ...norm };
  else models.push(norm);
  save(models, { fetchedAt: cat.fetchedAt || new Date().toISOString() });
  return norm;
}

export function importModels(entries, { replace = false } = {}) {
  const cat = load();
  const base = replace ? [] : (cat.seeded ? SEED.models || [] : cat.models).map(normalizeModel);
  const byId = new Map(base.map((m) => [m.id, m]));
  for (const e of entries) {
    const norm = normalizeModel(e);
    byId.set(norm.id, { ...(byId.get(norm.id) || {}), ...norm });
  }
  const models = [...byId.values()];
  save(models);
  return { count: models.length, added: entries.length };
}

/** Refresh is delegated to the provider: only it knows where models come from. */
export async function refresh(opts = {}) {
  const r = await provider.refreshCatalog(opts);
  if (r?.models?.length) {
    save(r.models.map(normalizeModel), { refreshedFrom: r.source ?? null });
    return { updated: true, count: r.models.length, source: r.source ?? null, needsManual: false };
  }
  const cat = load();
  return {
    updated: false,
    count: cat.models.length,
    source: null,
    needsManual: true,
    hint: r?.hint || `The catalog could not be refreshed machine-readably. Fill it by hand: gcv-${SERVICE} catalog set --model <id> --credits <N>`,
  };
}

// ── spend ledger ─────────────────────────────────────────────────────────────

export function record(entry) {
  ensureHome();
  const line = {
    ts: new Date().toISOString(),
    provider: SERVICE,
    model: entry.model ?? null,
    taskId: entry.taskId ?? null,
    runId: entry.runId ?? null,
    state: entry.state ?? null,
    estCredits: entry.estCredits ?? null,
    creditsConsumed: entry.costActual ?? null,
    usd: entry.costActual != null ? toUsd(entry.costActual) : null,
    prompt: entry.prompt ? String(entry.prompt).slice(0, 500) : null,
  };
  appendFileSync(LEDGER_PATH, JSON.stringify(line) + '\n', 'utf8');
  return line;
}

const emptyTotals = () => ({ tasks: 0, credits: 0, usd: 0, failed: 0 });

export function readLedger({ since, runId, limit = 200 } = {}) {
  if (!existsSync(LEDGER_PATH)) return { entries: [], totals: emptyTotals() };
  const sinceTs = since ? Date.parse(since) : null;
  const entries = readFileSync(LEDGER_PATH, 'utf8')
    .split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter((e) => e.provider === SERVICE)
    .filter((e) => (sinceTs ? Date.parse(e.ts) >= sinceTs : true))
    .filter((e) => (runId ? e.runId === runId : true))
    .slice(-limit);

  const totals = entries.reduce((a, e) => {
    a.tasks += 1;
    a.credits += e.creditsConsumed ?? 0;
    a.usd += e.usd ?? 0;
    if (e.state === 'fail') a.failed += 1;
    return a;
  }, emptyTotals());
  totals.usd = Math.round(totals.usd * 1e6) / 1e6;
  return { entries, totals };
}

// ── idempotency ──────────────────────────────────────────────────────────

/**
 * Object keys are sorted recursively at every nesting level — otherwise two
 * logically identical requests whose input properties come in a different order
 * would hash differently, and idempotency would fail exactly where it matters.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export const idempotencyKey = ({ model, input, count = 1 }) =>
  createHash('sha256').update(stableStringify({ model, input, count })).digest('hex').slice(0, 24);

const readMap = () => {
  if (!existsSync(IDEMPOTENCY_PATH)) return {};
  try { return JSON.parse(readFileSync(IDEMPOTENCY_PATH, 'utf8')); } catch { return {}; }
};

export function lookupIdempotent(key) {
  const hit = readMap()[key];
  if (!hit) return null;
  return Date.now() - Date.parse(hit.ts) > 86_400_000 ? null : hit;
}

export function rememberIdempotent(key, taskIds) {
  ensureHome();
  const map = readMap();
  map[key] = { taskIds, ts: new Date().toISOString() };
  const keys = Object.keys(map);
  if (keys.length > 500) {
    const sorted = keys.sort((a, b) => Date.parse(map[a].ts) - Date.parse(map[b].ts));
    for (const k of sorted.slice(0, keys.length - 500)) delete map[k];
  }
  writeFileSync(IDEMPOTENCY_PATH, JSON.stringify(map, null, 2) + '\n', 'utf8');
}
