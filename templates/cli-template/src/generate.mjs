/**
 * preflight → estimate → submit → poll → download. Not to be edited per service.
 * The point of no return is provider.createTask(): money is spent there.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import * as provider from './provider.mjs';
import * as store from './store.mjs';
import { toUsd } from './config.mjs';
import { GcvError, validation, budget } from './errors.mjs';
import { event, debug, downloadTo } from './io.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(['success', 'fail']);

/**
 * Fills in required schema fields for which the model already documents a
 * default but which neither the user nor the prompt supplied. Not a guess — the
 * value is documented in that model's own schema. A required field without a
 * default stays absent: preflight catches it before the request goes out.
 */
function applyRequiredDefaults(model, input) {
  const required = model.required || [];
  const schema = model.inputSchema || {};
  const out = { ...input };
  for (const field of required) {
    if (out[field] !== undefined) continue;
    const def = schema[field]?.default;
    if (def !== undefined) out[field] = def;
  }
  return out;
}

/** Returns the input with required-field defaults applied — that object, not
 * the original one, is what must flow on into estimate()/createTask(). */
export function preflight({ model: modelId, input, refs = [], count = 1 }) {
  const warnings = [];
  const { model, staleness } = store.show(modelId);
  input = applyRequiredDefaults(model, input);

  if (!model.verified) warnings.push(`Model "${model.id}" is unverified in the catalog — its slug and price may be wrong`);
  if (staleness.isStale) warnings.push(`Catalog is stale (${staleness.fetchedAt ?? 'never'}) — prices may not match reality`);

  const lim = model.limits || {};
  if (lim.maxRefs != null && refs.length > lim.maxRefs)
    throw validation(`Model ${model.id} accepts at most ${lim.maxRefs} references, ${refs.length} given`, { maxRefs: lim.maxRefs, given: refs.length });

  const prompt = input?.prompt;
  if (lim.maxPromptChars != null && typeof prompt === 'string' && prompt.length > lim.maxPromptChars)
    throw validation(`Prompt exceeds the model limit: ${prompt.length} > ${lim.maxPromptChars}`, { maxPromptChars: lim.maxPromptChars, given: prompt.length });

  const ar = input?.aspect_ratio ?? input?.aspectRatio;
  if (ar && Array.isArray(lim.aspectRatios) && lim.aspectRatios.length && !lim.aspectRatios.includes(ar))
    throw validation(`Model ${model.id} does not support aspect ratio ${ar}. Available: ${lim.aspectRatios.join(', ')}`, { allowed: lim.aspectRatios, given: ar });

  const dur = input?.duration ?? input?.duration_sec;
  if (dur != null && lim.maxDurationSec != null && Number(dur) > lim.maxDurationSec)
    throw validation(`Duration ${dur}s exceeds the limit of ${lim.maxDurationSec}s`, { maxDurationSec: lim.maxDurationSec, given: dur });

  if (!prompt && !input?.image_urls?.length && !refs.length)
    throw validation('Need --prompt, or at least one --ref/--input with model parameters');

  if (count < 1 || count > 50) throw validation(`--count is out of sane bounds: ${count} (allowed 1..50)`);

  for (const r of refs) {
    if (!/^https?:\/\//.test(r) && !existsSync(r)) throw validation(`Reference not found and is not a URL: ${r}`);
  }

  const missingRequired = (model.required || []).filter((f) => input[f] === undefined);
  if (missingRequired.length) {
    throw validation(
      `Model ${model.id} requires field(s) with no default: ${missingRequired.join(', ')}.`,
      { missingRequired },
    );
  }

  return { ok: true, warnings, model, input };
}

/**
 * Cost estimate. Spends no money.
 *
 * With many services the price depends on resolution, so the catalog stores a
 * range. The estimate returns both bounds: `estCredits` is the lower one,
 * `estCreditsMax` the upper. Every safety limit uses the UPPER bound:
 * understating an estimate is more dangerous than overstating it. An unknown
 * price stays unknown.
 */
export function estimate({ model: modelId, count = 1, input = {}, refs = [] }) {
  const { model, staleness } = store.show(modelId);
  const price = model.price ?? {};
  const perUnit = price.credits ?? null;
  const perUnitMax = price.creditsMax ?? perUnit;

  // Per-second pricing — multiply by duration when one is given.
  let units = count;
  const dur = Number(input.duration ?? input.duration_sec ?? 0);
  if (price.unit === 'per_second' && dur > 0) units = count * dur;
  // Per-batch pricing ("per 4 images") — round up to whole batches.
  const batch = price.batch && price.batch > 1 ? price.batch : 1;
  if (batch > 1) units = Math.ceil(units / batch);

  // Separate surcharge for input images, where the service charges one.
  const refCount = refs.length + (input.image_urls?.length ?? 0);
  const surcharge = price.inputSurcharge?.credits ? price.inputSurcharge.credits * refCount : 0;

  const estCredits = perUnit == null ? null : perUnit * units + surcharge;
  const estCreditsMax = perUnitMax == null ? null : perUnitMax * units + surcharge;
  const isRange = price.basis === 'range' && estCredits !== estCreditsMax;

  return {
    model: model.id,
    count,
    units,
    batch,
    priceUnit: price.unit ?? null,
    creditsPerUnit: perUnit,
    creditsPerUnitMax: perUnitMax,
    inputSurchargeCredits: surcharge || null,
    estCredits,
    estCreditsMax,
    estUsd: toUsd(estCredits),
    estUsdMax: toUsd(estCreditsMax),
    isRange,
    priceBasis: price.basis ?? null,
    priceVariants: price.variants ?? null,
    known: perUnit != null,
    staleness,
    ...(isRange
      ? {
          note:
            `Price depends on request parameters (${price.variants} variants in the price list, ` +
            `usually resolution). Range: ${estCredits}–${estCreditsMax} credits. ` +
            `Safety limits use the upper bound.`,
        }
      : {}),
    ...(perUnit == null
      ? {
          hint:
            `The price of model ${model.id} is unknown — the catalog does not have it. ` +
            `No estimate can be built. Refresh the catalog: sync`,
        }
      : {}),
  };
}

/**
 * Local safety limits, applied before createTask.
 * They use the UPPER bound of the estimate: if the price depends on resolution,
 * the most expensive variant may apply, and finding that out after the charge is
 * too late.
 */
function guardBudget({ est, maxCostCredits, balance, count }) {
  const worst = est.estCreditsMax ?? est.estCredits;

  if (maxCostCredits != null) {
    if (worst == null) {
      throw budget(
        `--max-cost ${maxCostCredits} was given, but the model price is unknown — the limit cannot be checked. ` +
          `Refresh the catalog (sync) or drop --max-cost.`,
      );
    }
    if (worst > maxCostCredits) {
      throw budget(
        est.isRange
          ? `Estimate up to ${worst} credits (range ${est.estCredits}–${worst}) exceeds --max-cost ${maxCostCredits}`
          : `Estimate of ${worst} credits exceeds --max-cost ${maxCostCredits}`,
        { estCredits: est.estCredits, estCreditsMax: worst, maxCostCredits },
      );
    }
  }

  if (balance != null && worst != null && worst > balance) {
    throw new GcvError(
      'INSUFFICIENT_FUNDS',
      `Not enough credits: up to ${worst} needed, ${balance} on the account` + (count > 1 ? ` (${count} generations)` : ''),
      { details: { need: worst, have: balance, estCreditsMin: est.estCredits } },
    );
  }
}


/** Replaces local files in references with public URLs. */
async function resolveRefs(apiKey, refs, timeoutMs) {
  const urls = [];
  for (const r of refs) {
    if (/^https?:\/\//.test(r)) { urls.push(r); continue; }
    event('uploading', { file: r });
    const up = await provider.uploadFile(apiKey, r, { timeoutMs });
    debug(`ref ${r} → ${up.url}`);
    urls.push(up.url);
  }
  return urls;
}

export async function generate(apiKey, opts) {
  const {
    model: modelId, prompt, input: rawInput = {}, refs = [], count = 1, out = null,
    wait = false, pollSec = 10, timeoutMs = 60_000, waitTimeoutSec = 900,
    maxCostCredits = null, idempotencyKey: userKey = null, force = false,
    dryRun = false, runId = null, balance = null, callBackUrl = null,
  } = opts;

  let input = { ...rawInput };
  if (prompt) input.prompt = prompt;

  // pre.input carries the required-field defaults from the schema.
  const pre = preflight({ model: modelId, input, refs, count });
  input = pre.input;
  const est = estimate({ model: modelId, count, input, refs });
  guardBudget({ est, maxCostCredits, balance, count });

  if (dryRun) {
    return { dryRun: true, tasks: [], estimate: est, warnings: pre.warnings,
             totals: { estCredits: est.estCredits, creditsConsumed: 0, actualUsd: 0 } };
  }

  if (refs.length) {
    const urls = await resolveRefs(apiKey, refs, timeoutMs);
    input.image_urls = [...(input.image_urls || []), ...urls];
  }

  const key = userKey || store.idempotencyKey({ model: modelId, input, count });
  if (!force) {
    const hit = store.lookupIdempotent(key);
    if (hit) {
      event('idempotent-hit', { key, taskIds: hit.taskIds });
      const existing = [];
      for (const id of hit.taskIds) existing.push(await provider.getTask(apiKey, id, timeoutMs));
      const finished = wait
        ? await Promise.all(existing.map((t) => pollUntilDone(apiKey, t.taskId, { pollSec, waitTimeoutSec, timeoutMs })))
        : existing;
      return finalize({ tasks: finished, model: pre.model, est, out, runId, warnings: pre.warnings, reused: true });
    }
  }

  const taskIds = [];
  for (let i = 0; i < count; i++) {
    const taskId = await provider.createTask(apiKey, { model: modelId, input, callBackUrl }, timeoutMs);
    taskIds.push(taskId);
    event('submitted', { taskId, model: modelId, index: i + 1, of: count, estCredits: est.creditsPerUnit });
    // Ledger entry right after submit: the money is already gone even if we crash next.
    store.record({ model: modelId, taskId, runId, state: 'submitted', estCredits: est.creditsPerUnit, prompt: input.prompt });
  }
  store.rememberIdempotent(key, taskIds);

  const tasks = wait
    ? await Promise.all(taskIds.map((id) => pollUntilDone(apiKey, id, { pollSec, waitTimeoutSec, timeoutMs })))
    : await Promise.all(taskIds.map((id) => provider.getTask(apiKey, id, timeoutMs)));

  return finalize({ tasks, model: pre.model, est, out, runId, warnings: pre.warnings });
}

export async function pollUntilDone(apiKey, taskId, { pollSec = 10, waitTimeoutSec = 900, timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + waitTimeoutSec * 1000;
  let last = null;
  while (Date.now() < deadline) {
    last = await provider.getTask(apiKey, taskId, timeoutMs);
    if (TERMINAL.has(last.state)) {
      if (last.state === 'fail') event('failed', { taskId, message: last.failMsg || last.failCode || 'generation failed' });
      else event('succeeded', { taskId, costActual: last.costActual, costTimeMs: last.costTimeMs });
      return last;
    }
    event('progress', { taskId, state: last.state, progress: last.progress });
    await sleep(pollSec * 1000);
  }
  throw new GcvError('TIMEOUT', `Task ${taskId} did not finish within ${waitTimeoutSec}s (last state: ${last?.state})`, {
    retryable: true, details: { taskId, lastState: last?.state, progress: last?.progress },
  });
}

async function finalize({ tasks, model, est, out, runId, warnings, reused = false }) {
  const result = [];
  // The default download folder is flat (see config.resolveOutputDir) — the
  // timestamp in the file name is what prevents a second generation of the same
  // model on the same day from silently overwriting the first one's file.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  for (const [i, t] of tasks.entries()) {
    const files = [];
    if (out && t.state === 'success' && t.resultUrls?.length) {
      for (const [j, url] of t.resultUrls.entries()) {
        const name = `${stamp}_${String(i + 1).padStart(2, '0')}${t.resultUrls.length > 1 ? `_${j + 1}` : ''}_${slug(model.id)}${guessExt(url, model.type)}`;
        files.push((await downloadTo(url, join(out, name))).path);
      }
      event('downloaded', { taskId: t.taskId, files });
    }
    // On a reused result nothing was actually spent — the task was already
    // written to the ledger by the first, real call.
    if (!reused && TERMINAL.has(t.state)) {
      store.record({ model: model.id, taskId: t.taskId, runId, state: t.state, estCredits: est.creditsPerUnit, costActual: t.costActual });
    }
    result.push({
      taskId: t.taskId, model: model.id, state: t.state, progress: t.progress,
      estCredits: est.creditsPerUnit, creditsConsumed: t.costActual ?? null,
      estUsd: toUsd(est.creditsPerUnit), actualUsd: toUsd(t.costActual),
      resultUrls: t.resultUrls || [], files,
      failCode: t.failCode ?? null, failMsg: t.failMsg ?? null, costTimeMs: t.costTimeMs ?? null,
    });
  }
  const consumed = result.reduce((s, r) => s + (r.creditsConsumed ?? 0), 0);
  return {
    reused, tasks: result, warnings,
    totals: {
      count: result.length,
      succeeded: result.filter((r) => r.state === 'success').length,
      failed: result.filter((r) => r.state === 'fail').length,
      estCredits: est.estCredits, creditsConsumed: consumed, actualUsd: toUsd(consumed),
    },
  };
}

function guessExt(url, type) {
  const m = url.split('?')[0].match(/\.([a-z0-9]{2,4})$/i);
  return m ? `.${m[1].toLowerCase()}` : { image: '.png', video: '.mp4', audio: '.mp3' }[type] || '.bin';
}

const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
