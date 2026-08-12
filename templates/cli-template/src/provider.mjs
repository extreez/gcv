/**
 * ══════════════════════════════════════════════════════════════════════════════
 *  THE ONLY FILE YOU WRITE FOR A SPECIFIC SERVICE.
 *  Nothing else in src/ needs to be touched.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Fill this in from the service documentation. Rules:
 *   · an unknown value is null, never a guess
 *   · createTask is NEVER retried automatically — that is where money is spent
 *   · state is mapped to five values: waiting | queuing | generating | success | fail
 *   · if the service cannot do something, throw notSupported() — do not emulate it
 */

import { request, downloadTo } from './io.mjs';
import { BASE_URL } from './config.mjs';
import { GcvError, notSupported } from './errors.mjs';

// ── 1. Service identity ──────────────────────────────────────────────────────

export const PROVIDER = {
  id: '__SERVICE__',                    // slug: kie, fal, wavespeed
  name: '__SERVICE_NAME__',             // human-readable name: fal.ai
  baseUrl: '__BASE_URL__',              // https://api.example.com
  currency: 'credits',                  // 'credits' | 'usd'
  docs: '__DOCS_URL__',
  apiKeyEnv: '__SERVICE_UPPER___API_KEY',
  apiKeyUrl: '__API_KEY_URL__',
  billing: 'TODO: when money is charged — at task creation or on delivery',
  supports: {
    cancel: false,    // can it cancel a task
    upload: true,     // does it need file uploads for references
    webhook: false,   // does it support callbacks
    sync: false,      // does it answer with the result directly, without a taskId
  },
};

/** Is the response successful by its body (not only by HTTP code). Some APIs put the code inside. */
const okWhen = (json) => json?.code === undefined || json.code === 200 || json.success === true;

// ── 2. Balance ───────────────────────────────────────────────────────────────

export async function getBalance(apiKey, timeoutMs) {
  // TODO: balance endpoint
  const json = await request(`${BASE_URL()}/v1/account/balance`, {
    apiKey, timeoutMs, retries: 2, context: 'balance', okWhen,
  });

  const amount = Number(json?.data?.balance ?? json?.balance);
  if (!Number.isFinite(amount)) {
    throw new GcvError('PROVIDER_ERROR', 'Balance came back in an unexpected format', { details: { raw: json } });
  }
  return { amount, currency: PROVIDER.currency };
}

// ── 3. Task creation — THIS IS WHERE MONEY IS SPENT ──────────────────────────

export async function createTask(apiKey, { model, input, callBackUrl }, timeoutMs) {
  // TODO: request body shape
  const body = { model, input };
  if (callBackUrl && PROVIDER.supports.webhook) body.callBackUrl = callBackUrl;

  const json = await request(`${BASE_URL()}/v1/jobs`, {
    method: 'POST', apiKey, body, timeoutMs,
    retries: 0,              // DO NOT CHANGE: an auto-retry here means paying twice
    context: `createTask ${model}`, okWhen,
  });

  const taskId = json?.data?.taskId ?? json?.id ?? json?.request_id;
  if (!taskId) {
    throw new GcvError('PROVIDER_ERROR', 'The service returned no task id — its status is unknown', { details: { raw: json } });
  }
  return String(taskId);

  // For synchronous services (supports.sync === true) do this instead:
  //   1. perform the request and get the whole result
  //   2. store it in a module-level cache under a synthetic id
  //   3. return that id; getTask() will hand it back with state: 'success'
}

// ── 4. Task status ───────────────────────────────────────────────────────────

/** Maps the service's states onto the five contract states. */
const STATE_MAP = {
  // TODO: map the real values used by the service
  pending: 'waiting', queued: 'queuing', in_progress: 'generating', running: 'generating',
  completed: 'success', succeeded: 'success', failed: 'fail', error: 'fail', canceled: 'fail',
};

export async function getTask(apiKey, taskId, timeoutMs) {
  // TODO: status endpoint
  const json = await request(`${BASE_URL()}/v1/jobs/${encodeURIComponent(taskId)}`, {
    apiKey, timeoutMs, retries: 3, context: `getTask ${taskId}`, okWhen,
  });
  const d = json?.data ?? json ?? {};

  return {
    taskId: String(d.id ?? taskId),
    model: d.model ?? null,
    state: STATE_MAP[d.status] ?? d.status ?? 'waiting',
    progress: typeof d.progress === 'number' ? d.progress : null,
    costActual: typeof d.cost === 'number' ? d.cost : null,   // ACTUAL cost, null if the service does not report it
    failCode: d.error?.code ?? null,
    failMsg: d.error?.message ?? null,
    costTimeMs: typeof d.duration_ms === 'number' ? d.duration_ms : null,
    resultUrls: extractUrls(d),
    result: d.output ?? d.result ?? null,
  };
}

/** Every service puts result links somewhere else — known fields first, then a tree walk. */
function extractUrls(node) {
  const urls = [];
  const push = (v) => { if (typeof v === 'string' && /^https?:\/\//.test(v)) urls.push(v); };
  for (const k of ['resultUrls', 'urls', 'images', 'video', 'audio', 'url', 'output']) {
    const v = node?.[k];
    if (Array.isArray(v)) v.forEach((x) => push(typeof x === 'string' ? x : x?.url));
    else if (typeof v === 'object') push(v?.url);
    else push(v);
  }
  if (!urls.length) {
    const seen = new Set();
    const walk = (n, depth = 0) => {
      if (depth > 6 || n == null || seen.has(n)) return;
      if (typeof n === 'object') { seen.add(n); Object.values(n).forEach((v) => walk(v, depth + 1)); }
      else push(n);
    };
    walk(node);
  }
  return [...new Set(urls)];
}

// ── 5. File uploads ──────────────────────────────────────────────────────────

export async function uploadFile(apiKey, filePath, { timeoutMs } = {}) {
  if (!PROVIDER.supports.upload) {
    throw notSupported(`${PROVIDER.name} needs no file uploads — pass references as public URLs`);
  }
  const { readFile } = await import('node:fs/promises');
  const { basename } = await import('node:path');
  const buf = await readFile(filePath);
  const name = basename(filePath);

  // TODO: endpoint and form fields
  const form = new FormData();
  form.append('file', new Blob([buf]), name);

  const json = await request(`${BASE_URL()}/v1/files`, {
    method: 'POST', apiKey, formData: form, timeoutMs: timeoutMs ?? 180_000,
    retries: 1, context: `upload ${name}`, okWhen,
  });

  const url = json?.data?.url ?? json?.url;
  if (!url) throw new GcvError('PROVIDER_ERROR', 'Upload succeeded but no URL came back');
  return {
    url, fileName: name, bytes: buf.length,
    mimeType: json?.data?.mimeType ?? null,
    expiresInDays: null,   // TODO: how long the file lives; null means unknown
  };
}

// ── 6. Catalog refresh ───────────────────────────────────────────────────────

/**
 * Return { models: [...], source } when a machine-readable fetch succeeded,
 * otherwise { needsManual: true, hint } — the catalog is then filled via `catalog set`.
 * Inventing models or prices here is not allowed.
 */
export async function refreshCatalog({ timeoutMs = 30_000 } = {}) {
  // TODO: if the service has a public model list, fetch it here
  return {
    needsManual: true,
    hint:
      `No model-list endpoint has been worked out for ${PROVIDER.name}.\n` +
      `Fill the catalog from the documentation at ${PROVIDER.docs}:\n` +
      `  gcv-${PROVIDER.id} catalog set --model <id> --type image --credits <N> --price-unit per_image`,
  };
}

// ── 7. Service-specific errors ───────────────────────────────────────────────

/**
 * Return a GcvError when the service signals errors in a non-standard way.
 * Return null to fall back to the shared mapping in errors.mjs (it covers
 * 401/402/429/4xx/5xx).
 */
export function mapError(status, body, context) {
  // Example: the service answers 200 with {"status":"ERROR","reason":"NSFW"}
  // if (body?.status === 'ERROR') return new GcvError('JOB_FAILED', body.reason, { providerCode: body.code });
  return null;
}

export { downloadTo };
