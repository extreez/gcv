/**
 * Output (CLI-CONTRACT §4, §6) and the HTTP layer. Not to be edited per service.
 * Service specifics plug in through provider.mapError().
 */

import { CONTRACT, SERVICE } from './config.mjs';
import { EXIT, GcvError, defaultFromHttp, fromNetwork } from './errors.mjs';
import { mapError } from './provider.mjs';

// ── output ────────────────────────────────────────────────────────────────────

let state = { json: false, quiet: false, verbose: false, color: true, command: '?', started: Date.now() };

export function initOutput({ json, quiet, verbose, color, command }) {
  state = { json: !!json, quiet: !!quiet, verbose: !!verbose, color: color !== false, command, started: Date.now() };
}

export const color = {
  dim: (s) => (state.color ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (state.color ? `\x1b[1m${s}\x1b[0m` : s),
  red: (s) => (state.color ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s) => (state.color ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (state.color ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s) => (state.color ? `\x1b[36m${s}\x1b[0m` : s),
};

export function event(name, payload = {}) {
  if (state.quiet) return;
  if (state.json) return void process.stderr.write(JSON.stringify({ event: name, ...payload }) + '\n');
  const t = payload.taskId ? color.dim(` ${payload.taskId}`) : '';
  const line = {
    submitted: () => `${color.cyan('→')} task created${t} ${color.dim(payload.model || '')}`,
    progress: () => `${color.dim('·')} ${payload.state || ''} ${payload.progress ?? ''}%${t}`,
    succeeded: () => `${color.green('✓')} done${t} ${color.dim(String(payload.costActual ?? ''))}`,
    failed: () => `${color.red('✗')} ${payload.message || 'failed'}${t}`,
    downloaded: () => (payload.files || []).map((f) => `${color.green('↓')} ${f}`).join('\n'),
    retry: () => `${color.yellow('↻')} retry ${payload.attempt}/${payload.max}: ${payload.reason}`,
  }[name];
  process.stderr.write((line ? line() : `${color.dim('·')} ${name} ${JSON.stringify(payload)}`) + '\n');
}

export const debug = (msg) => {
  if (state.verbose) process.stderr.write(color.dim(`[debug] ${msg}`) + '\n');
};

const meta = (extra = {}) => ({ durationMs: Date.now() - state.started, cliVersion: '0.1.0', ...extra });

export function ok(data, extraMeta = {}, human = null) {
  if (state.json) {
    process.stdout.write(
      JSON.stringify({ ok: true, contract: CONTRACT, provider: SERVICE, command: state.command, data, meta: meta(extraMeta) }, null, 2) + '\n',
    );
  } else process.stdout.write((human ? human(data) : JSON.stringify(data, null, 2)) + '\n');
  return EXIT.OK;
}

export function fail(err, extraMeta = {}) {
  const e = err instanceof GcvError ? err : new GcvError('INTERNAL', err?.message || String(err), { details: { stack: err?.stack } });
  if (state.json) {
    process.stdout.write(
      JSON.stringify({ ok: false, contract: CONTRACT, provider: SERVICE, command: state.command, error: e.toJSON(), meta: meta(extraMeta) }, null, 2) + '\n',
    );
  } else {
    process.stderr.write(`${color.red('Error')} [${e.code}] ${e.message}\n`);
    if (state.verbose && e.details?.stack) process.stderr.write(color.dim(e.details.stack) + '\n');
  }
  return e.exitCode;
}

export function table(rows, columns) {
  if (!rows.length) return color.dim('(empty)');
  const w = columns.map((c) => Math.max(c.title.length, ...rows.map((r) => String(c.get(r) ?? '').length)));
  const line = (cells) => cells.map((v, i) => String(v ?? '').padEnd(w[i])).join('  ');
  return [
    color.bold(line(columns.map((c) => c.title))),
    color.dim(w.map((n) => '─'.repeat(n)).join('  ')),
    ...rows.map((r) => line(columns.map((c) => c.get(r)))),
  ].join('\n');
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Single place where errors are mapped: ask the provider first, then fall back. */
function toError(status, body, context) {
  return mapError?.(status, body, context) || defaultFromHttp(status, body, context);
}

export async function request(url, opts) {
  const { method = 'GET', apiKey, body, formData, headers: extraHeaders = {},
          timeoutMs = DEFAULT_TIMEOUT_MS, retries = 0, context = '', okWhen = null } = opts;

  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', ...extraHeaders };
  let payload;
  if (formData) payload = formData;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(1000 * 2 ** (attempt - 1), 8000);
      event('retry', { attempt, max: retries, reason: lastError?.code || 'unknown', backoffMs: backoff });
      await sleep(backoff);
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      debug(`${method} ${url}`);
      const res = await fetch(url, { method, headers, body: payload, signal: ac.signal });
      const text = await res.text();

      let json = null;
      try { json = text ? JSON.parse(text) : null; }
      catch {
        if (!res.ok) {
          lastError = new GcvError('PROVIDER_ERROR', `Response is not JSON (HTTP ${res.status})`, {
            providerCode: res.status, retryable: res.status >= 500, details: { bodyPreview: text.slice(0, 200) },
          });
          if (lastError.retryable && attempt < retries) continue;
          throw lastError;
        }
        throw new GcvError('PROVIDER_ERROR', 'Unreadable service response', { details: { bodyPreview: text.slice(0, 200) } });
      }

      // Some services put the error in the body on HTTP 200 — okWhen catches that.
      const bodyOk = okWhen ? okWhen(json) : true;
      if (!res.ok || !bodyOk) {
        lastError = toError(res.ok ? (json?.code ?? 200) : res.status, json, context);
        if (lastError.retryable && attempt < retries) continue;
        throw lastError;
      }
      return json;
    } catch (err) {
      if (err instanceof GcvError) {
        if (err.retryable && attempt < retries) { lastError = err; continue; }
        throw err;
      }
      lastError = fromNetwork(err);
      if (attempt < retries) continue;
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new GcvError('INTERNAL', 'Request was not performed');
}

export async function downloadTo(url, filePath, timeoutMs = 300_000) {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) {
      throw new GcvError('PROVIDER_ERROR', `Could not download the result: HTTP ${res.status}`, {
        providerCode: res.status, retryable: res.status >= 500,
      });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, buf);
    return { path: filePath, bytes: buf.length };
  } catch (err) {
    if (err instanceof GcvError) throw err;
    throw fromNetwork(err);
  } finally {
    clearTimeout(timer);
  }
}
