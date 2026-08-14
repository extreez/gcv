/**
 * Model catalog (CLI-CONTRACT §8), spend ledger and idempotency (§10).
 * Not to be edited per service.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { CATALOG_PATH, LEDGER_PATH, IDEMPOTENCY_PATH, ensureHome, toUsd, SERVICE } from './config.mjs';
import { GcvError, validation } from './errors.mjs';
import * as provider from './provider.mjs';

const TTL_DAYS = 7;
const SEED = JSON.parse(readFileSync(new URL('./models.seed.json', import.meta.url), 'utf8'));

/**
 * Two files, and the split matters.
 *
 * CATALOG_PATH is a CACHE: `refresh` rewrites it whole, because a price that
 * survived a rewrite is a price nobody can vouch for any more.
 *
 * These two are USER DATA — what the user typed or decided — and `refresh` must
 * never touch them. Keeping manual models in the catalog file means every sync
 * silently deletes them, which is exactly the bug this layout prevents.
 */
const OVERRIDES_PATH = join(dirname(CATALOG_PATH), 'overrides.json');
const DISABLED_PATH = join(dirname(CATALOG_PATH), 'disabled.json');

const readJson = (path, fallback) => {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new GcvError('INTERNAL', `${path} is corrupted: ${e.message}`);
  }
};

/** @returns {Record<string, object>} models entered by hand, keyed by id */
export const readOverrides = () => readJson(OVERRIDES_PATH, {});

/** @returns {Set<string>} ids the user has switched off */
export const readDisabled = () => new Set(readJson(DISABLED_PATH, { models: [] }).models ?? []);

const writeOverrides = (m) => {
  ensureHome();
  writeFileSync(OVERRIDES_PATH, JSON.stringify(m, null, 2) + '\n', 'utf8');
};

/**
 * Manual entries win over fetched ones — the user typed them on purpose, and a
 * sync must not quietly undo that. Marked, never merged silently, so a listing
 * can show where a value came from.
 */
function mergeManual(models, manual, off) {
  const byId = new Map(models.map((m) => [m.id, m]));
  for (const id of Object.keys(manual)) byId.set(id, { ...(byId.get(id) ?? {}), ...manual[id], manual: true });
  return [...byId.values()].map((m) => (off.has(m.id) ? { ...m, disabled: true } : m));
}

/** @param {{overrides?: boolean}} [opts] overrides:false gives the fetched catalog alone */
export function load({ overrides = true } = {}) {
  ensureHome();
  const manual = overrides ? readOverrides() : {};
  const off = readDisabled();
  if (!existsSync(CATALOG_PATH)) {
    const models = mergeManual(SEED.models || [], manual, off);
    return { models, fetchedAt: null, ttlDays: TTL_DAYS, isStale: true, seeded: true, manual: Object.keys(manual).length };
  }
  try {
    const raw = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
    const ageDays = raw.fetchedAt ? (Date.now() - Date.parse(raw.fetchedAt)) / 86_400_000 : Infinity;
    const models = mergeManual(raw.models || [], manual, off);
    return { models, fetchedAt: raw.fetchedAt || null, ttlDays: TTL_DAYS, isStale: ageDays > TTL_DAYS, seeded: false, manual: Object.keys(manual).length };
  } catch (e) {
    if (e instanceof GcvError) throw e;
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
      // Where reference images go, null when the model takes none. This — not
      // maxRefs — answers 'does it accept references': maxRefs null next to a
      // refField means 'accepts them, no limit declared'.
      refField: m.limits?.refField ?? null,
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
    // Entered by hand rather than fetched — lives in overrides.json, survives refresh.
    manual: m.manual === true,
    // Switched off by the user — listings skip it, generate refuses it.
    disabled: m.disabled === true,
    fetchedAt: m.fetchedAt ?? new Date().toISOString(),
  };
}

/** @param {{includeDisabled?: boolean}} [opts] switched-off models are hidden by default */
export function list({ type, mode, query, includeDisabled = false } = {}) {
  const cat = load();
  let models = cat.models.map(normalizeModel);
  const hiddenDisabled = includeDisabled ? 0 : models.filter((m) => m.disabled).length;
  if (!includeDisabled) models = models.filter((m) => !m.disabled);
  if (type) models = models.filter((m) => m.type === type);
  if (mode) models = models.filter((m) => m.modes?.includes(mode));
  if (query) {
    const q = query.toLowerCase();
    models = models.filter((m) => m.id.toLowerCase().includes(q) || (m.notes || '').toLowerCase().includes(q));
  }
  return { models, hiddenDisabled, staleness: { fetchedAt: cat.fetchedAt, ttlDays: cat.ttlDays, isStale: cat.isStale, seeded: cat.seeded } };
}

export function show(id) {
  // Includes switched-off models on purpose: `show` is how you inspect one
  // before deciding to switch it back on.
  const { models, staleness } = list({ includeDisabled: true });
  const model = models.find((m) => m.id === id) || models.find((m) => m.id.endsWith(`/${id}`));
  if (!model) {
    throw validation(
      `Model "${id}" is not in the catalog. See what is available: gcv-${SERVICE} catalog list\n` +
        `To add a new model: gcv-${SERVICE} catalog set --model ${id} --type image --credits N`,
    );
  }
  return { model, staleness };
}

/** Adds or updates a manual entry. Goes to overrides.json, never to the cache. */
export function upsert(entry) {
  const norm = normalizeModel({ ...entry, manual: true });
  const manual = readOverrides();
  manual[norm.id] = manual[norm.id] ? { ...manual[norm.id], ...norm } : norm;
  writeOverrides(manual);
  return norm;
}

/** Removes a manual entry. @returns {boolean} false when there was none */
export function unset(id) {
  const manual = readOverrides();
  if (!manual[id]) return false;
  delete manual[id];
  writeOverrides(manual);
  return true;
}

/**
 * Switches a model off or on. Listings skip a switched-off model and generate
 * must refuse it — see assertEnabled.
 */
export function setEnabled(id, enabled) {
  ensureHome();
  const off = readDisabled();
  const had = off.has(id);
  if (enabled) off.delete(id);
  else off.add(id);
  writeFileSync(DISABLED_PATH, JSON.stringify({ models: [...off] }, null, 2) + '\n', 'utf8');
  return { model: id, disabled: !enabled, changed: had === enabled };
}

/** Call before anything that would actually use the model. */
export function assertEnabled(id) {
  if (!readDisabled().has(id)) return;
  throw validation(
    `Model "${id}" is switched off in this installation and will not be called.\n` +
      `Switch it back on: gcv-${SERVICE} catalog enable ${id}`,
  );
}

/** @param {{replace?: boolean}} [opts] replace:true discards existing manual entries */
export function importModels(entries, { replace = false } = {}) {
  const manual = replace ? {} : readOverrides();
  for (const e of entries) {
    const norm = normalizeModel({ ...e, manual: true });
    manual[norm.id] = manual[norm.id] ? { ...manual[norm.id], ...norm } : norm;
  }
  writeOverrides(manual);
  return { manual: Object.keys(manual).length, added: entries.length, count: load().models.length };
}

/**
 * Refresh is delegated to the provider: only it knows where models come from.
 * It rewrites the CACHE only — manual entries and the off-switch live in their
 * own files and come back through load().
 */
export async function refresh(opts = {}) {
  const r = await provider.refreshCatalog(opts);
  if (r?.models?.length) {
    save(r.models.map(normalizeModel), { refreshedFrom: r.source ?? null });
    const manual = readOverrides();
    return {
      updated: true,
      count: r.models.length,
      source: r.source ?? null,
      needsManual: false,
      manual: Object.keys(manual).length,
      // Models the service now publishes itself, where hand-entered values go
      // on winning until removed. Worth reporting, never worth fixing silently.
      shadowed: r.models.filter((m) => manual[m.id]).map((m) => m.id),
    };
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
