/** Error taxonomy per CLI-CONTRACT v1 §5. Not to be edited per service. */

export const EXIT = {
  OK: 0, INTERNAL: 1, USAGE: 2, AUTH: 3, INSUFFICIENT_FUNDS: 4, PROVIDER_ERROR: 5,
  TIMEOUT: 6, JOB_FAILED: 7, NETWORK: 8, NOT_SUPPORTED: 9, BUDGET_EXCEEDED: 10,
  VALIDATION: 11, INTERRUPTED: 130,
};

export class GcvError extends Error {
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'GcvError';
    this.code = code;
    this.exitCode = EXIT[code] ?? EXIT.INTERNAL;
    this.providerCode = opts.providerCode != null ? String(opts.providerCode) : null;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details ?? null;
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      providerCode: this.providerCode,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export const usage = (m) => new GcvError('USAGE', m);
export const auth = (m) => new GcvError('AUTH', m);
export const validation = (m, details) => new GcvError('VALIDATION', m, { details });
export const notSupported = (m) => new GcvError('NOT_SUPPORTED', m);
export const budget = (m, details) => new GcvError('BUDGET_EXCEEDED', m, { details });

/**
 * Default HTTP response mapping. provider.mapError() is called first and may
 * return its own error; when it returns null, this logic takes over.
 */
export function defaultFromHttp(status, body, context = '') {
  const msg = body?.msg || body?.message || body?.error || body?.detail || `HTTP ${status}`;
  const providerCode = body?.code ?? status;
  const where = context ? ` (${context})` : '';
  const text = typeof msg === 'string' ? msg : JSON.stringify(msg);

  if (status === 401 || status === 403) return new GcvError('AUTH', `API key rejected: ${text}${where}`, { providerCode });
  if (status === 402 || /insufficient|balance|quota|credit/i.test(text))
    return new GcvError('INSUFFICIENT_FUNDS', `Insufficient funds: ${text}${where}`, { providerCode });
  if (status === 429)
    return new GcvError('PROVIDER_ERROR', `Rate limit: ${text}${where}`, { providerCode, retryable: true });
  if (status === 400 || status === 422)
    return new GcvError('VALIDATION', `Parameters rejected: ${text}${where}`, { providerCode });
  if (status >= 500)
    return new GcvError('PROVIDER_ERROR', `Service-side failure: ${text}${where}`, { providerCode, retryable: true });
  return new GcvError('PROVIDER_ERROR', `${text}${where}`, { providerCode });
}

export function fromNetwork(err) {
  const code = err?.cause?.code || err?.code || '';
  if (code === 'ETIMEDOUT' || err.name === 'TimeoutError' || err.name === 'AbortError') {
    return new GcvError('TIMEOUT', `Connection timed out: ${err.message}`, { retryable: true });
  }
  return new GcvError('NETWORK', `Network unavailable: ${err.message}${code ? ` [${code}]` : ''}`, { retryable: true });
}
