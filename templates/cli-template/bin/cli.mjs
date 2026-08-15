#!/usr/bin/env node
/** CLI per CLI-CONTRACT v1. No logic here: parse arguments → src/ → envelope. Not to be edited per service. */

import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import * as cfg from '../src/config.mjs';
import * as store from '../src/store.mjs';
import * as gen from '../src/generate.mjs';
import * as provider from '../src/provider.mjs';
import { EXIT, GcvError, usage, notSupported } from '../src/errors.mjs';
import { initOutput, ok, fail, table, color, event, downloadTo } from '../src/io.mjs';
import { ALIASES, renderOverview, renderCommand } from '../src/help.mjs';

const VERSION = '0.1.0';
const S = cfg.SERVICE;

const REPEATABLE = new Set(['ref', 'file']);
const BOOLEAN = new Set(['json', 'quiet', 'verbose', 'no-color', 'yes', 'dry-run', 'wait', 'force',
  'replace', 'help', 'version', 'raw', 'failed', 'by-model', 'no-download', 'all']);

function parseArgs(argv) {
  const flags = {}; const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    const name = (eq === -1 ? a.slice(2) : a.slice(2, eq)).trim();
    let value;
    if (eq !== -1) value = a.slice(eq + 1);
    else if (BOOLEAN.has(name)) value = true;
    else {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw usage(`Flag --${name} requires a value`);
      i++;
    }
    if (REPEATABLE.has(name)) (flags[name] ??= []).push(value);
    else flags[name] = value;
  }
  return { flags, positional };
}

/**
 * `--file <field>=<path|url>`, repeatable. Split on the FIRST `=`, because a URL
 * carries its own. A bare `--file ./x.png` is rejected rather than guessed at:
 * which field it belongs in is the question this flag exists to answer, and the
 * wrong answer is a paid generation that ignored the file.
 *
 * @returns {{field: string, value: string}[]}
 */
function parseFileFlags(raw) {
  return (raw ?? []).map((entry) => {
    const s = String(entry);
    const eq = s.indexOf('=');
    if (eq < 1) throw usage(`--file needs a field name: --file <field>=<path|url> (got "${s}")`);
    return { field: s.slice(0, eq).trim(), value: s.slice(eq + 1) };
  });
}

function parseInput(raw) {
  if (!raw) return {};
  try {
    const text = raw.startsWith('@') ? readFileSync(resolve(raw.slice(1)), 'utf8') : raw;
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw usage('--input must be a JSON object');
    return parsed;
  } catch (e) {
    if (e instanceof GcvError) throw e;
    throw usage(`--input could not be parsed as JSON: ${e.message}`);
  }
}

const num = (v, name) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw usage(`--${name} must be a number, got "${v}"`);
  return n;
};

const commands = {
  async doctor(flags) {
    const key = cfg.resolveApiKey(flags['api-key']);
    const checks = [{ name: 'Node', ok: true, detail: process.version }];
    checks.push({ name: 'API key', ok: !!key.key, detail: key.key ? `${key.source} (${cfg.maskKey(key.key)})` : 'not found' });

    let balance = null;
    if (key.key) {
      try {
        const b = await provider.getBalance(key.key, 20_000);
        balance = b.amount;
        checks.push({ name: `${provider.PROVIDER.name} connectivity`, ok: true, detail: `balance ${b.amount} ${b.currency}` });
      } catch (e) {
        checks.push({ name: `${provider.PROVIDER.name} connectivity`, ok: false, detail: e.message });
      }
    }
    const cat = store.load();
    checks.push({
      name: 'Model catalog', ok: !cat.isStale && !cat.seeded,
      detail: cat.seeded ? 'seed only, no prices — run `catalog refresh`' : `${cat.models.length} models, refreshed ${cat.fetchedAt}${cat.isStale ? ' (stale)' : ''}`,
    });
    const rate = cfg.unitUsdRate();
    checks.push({ name: 'USD rate', ok: rate != null, detail: rate != null ? `1 = ${rate}` : 'unset — estimates will use the internal currency' });

    return ok({ healthy: checks.every((c) => c.ok), checks, balance, apiKeySource: key.source, baseUrl: cfg.BASE_URL(), version: VERSION, provider: provider.PROVIDER },
      { apiKeySource: key.source },
      (d) => d.checks.map((c) => `${c.ok ? color.green('✓') : color.red('✗')} ${c.name.padEnd(20)} ${color.dim(c.detail)}`).join('\n') +
             `\n\n${d.healthy ? color.green('Ready to go.') : color.yellow('Some checks are open — see above.')}`);
  },

  async balance(flags) {
    const { key, source } = cfg.requireApiKey(flags['api-key']);
    const b = await provider.getBalance(key, (num(flags.timeout) ?? 20) * 1000);
    const usd = cfg.toUsd(b.amount);
    return ok({ ...b, usd }, { apiKeySource: source },
      (d) => `${color.bold(String(d.amount))} ${d.currency}${d.usd != null ? color.dim(`  ≈ ${d.usd}`) : color.dim('  (rate not set)')}`);
  },

  async catalog(flags, positional) {
    const sub = positional[0];
    if (sub === 'refresh') {
      const r = await store.refresh({ timeoutMs: (num(flags.timeout) ?? 30) * 1000 });
      return ok(r, {}, (d) => (d.updated ? `${color.green('✓')} catalog refreshed: ${d.count} models` : `${color.yellow('!')} ${d.hint}`));
    }
    if (sub === 'show') {
      const id = positional[1] || flags.model;
      if (!id) throw usage(`gcv-${S} catalog show <model>`);
      return ok(store.show(id), {}, (d) => JSON.stringify(d.model, null, 2));
    }
    if (sub === 'set') {
      if (!flags.model) throw usage(`gcv-${S} catalog set --model <id> [--type image] [--credits N]`);
      const saved = store.upsert({
        id: flags.model, type: flags.type ?? null,
        modes: flags.modes ? String(flags.modes).split(',').map((s) => s.trim()) : [],
        price: { unit: flags['price-unit'] ?? null, credits: num(flags.credits, 'credits') ?? null },
        limits: {
          refField: flags['ref-field'] ?? null,
          maxRefs: num(flags['max-refs'], 'max-refs') ?? null,
          maxPromptChars: num(flags['max-prompt-chars'], 'max-prompt-chars') ?? null,
          aspectRatios: flags['aspect-ratios'] ? String(flags['aspect-ratios']).split(',') : null,
          maxDurationSec: num(flags['max-duration'], 'max-duration') ?? null,
        },
        inputSchema: flags['input-schema'] ? parseInput(flags['input-schema']) : null,
        notes: flags.notes ?? null, source: flags.source ?? 'manual', verified: flags.verified !== 'false',
      });
      return ok({ model: saved }, {}, (d) =>
        `${color.green('✓')} stored by hand: ${d.model.id}\n` +
        color.dim(`  Kept apart from the fetched catalog — sync will not remove it.\n`) +
        color.dim(`  Undo: gcv-${S} catalog unset ${d.model.id}`),
      );
    }
    if (sub === 'unset') {
      const id = positional[1] || flags.model;
      if (!id) throw usage(`gcv-${S} catalog unset <model>`);
      const removed = store.unset(id);
      return ok({ model: id, removed }, {}, (d) =>
        d.removed
          ? `${color.green('✓')} manual entry removed: ${d.model}`
          : `${color.yellow('!')} ${d.model} was not entered by hand — nothing to remove.`,
      );
    }
    if (sub === 'disable' || sub === 'enable') {
      const id = positional[1] || flags.model;
      if (!id) throw usage(`gcv-${S} catalog ${sub} <model>`);
      const r = store.setEnabled(id, sub === 'enable');
      return ok(r, {}, (d) =>
        d.disabled
          ? `${color.yellow('○')} switched off: ${d.model}\n` +
            color.dim('  Hidden from listings, and generate will refuse it. Survives sync.')
          : `${color.green('●')} switched on: ${d.model}`,
      );
    }
    if (sub === 'import') {
      const path = positional[1] || flags.file;
      if (!path) throw usage(`gcv-${S} catalog import <file.json>`);
      const raw = JSON.parse(readFileSync(resolve(String(path)), 'utf8'));
      const entries = Array.isArray(raw) ? raw : raw.models || [];
      if (!entries.length) throw usage('No models in the file (expected an array or {models: []})');
      return ok(store.importModels(entries, { replace: !!flags.replace }), {}, (d) =>
        `${color.green('✓')} imported ${d.added}, ${d.manual} manual models total ${color.dim(`(${d.count} in the catalog)`)}`,
      );
    }
    const r = store.list({ type: flags.type, mode: flags.mode, query: flags.query });
    return ok(r, {}, (d) => {
      const head = d.staleness.seeded ? color.yellow(`Catalog is empty. Run: gcv-${S} catalog refresh\n\n`)
        : d.staleness.isStale ? color.yellow(`Catalog is stale (${d.staleness.fetchedAt ?? 'never'})\n\n`) : '';
      return head + table(d.models, [
        { title: 'MODEL', get: (m) => m.id }, { title: 'TYPE', get: (m) => m.type ?? '—' },
        { title: 'PRICE', get: (m) => m.price.credits ?? '?' }, { title: 'USD', get: (m) => (m.price.usd != null ? `${m.price.usd}` : '?') },
        { title: 'MAX REFS', get: (m) => m.limits.maxRefs ?? '—' }, { title: '✓', get: (m) => (m.verified ? 'yes' : 'no') },
      ]);
    });
  },

  async upload(flags, positional) {
    const { key, source } = cfg.requireApiKey(flags['api-key']);
    const files = [...positional, ...(flags.file || [])];
    if (!files.length) throw usage(`gcv-${S} upload <file> [file...]`);
    const uploaded = [];
    for (const f of files) {
      const r = await provider.uploadFile(key, resolve(f), { timeoutMs: num(flags.timeout) * 1000 });
      event('uploaded', { file: f, url: r.url });
      uploaded.push({ source: f, ...r });
    }
    return ok({ files: uploaded }, { apiKeySource: source }, (d) => d.files.map((f) => `${f.source}\n  → ${f.url}`).join('\n'));
  },

  async estimate(flags) {
    if (!flags.model) throw usage(`gcv-${S} estimate --model <id> [--count N]`);
    const r = gen.estimate({ model: flags.model, count: num(flags.count, 'count') ?? 1, input: parseInput(flags.input) });
    return ok(r, {}, (d) => (d.known
      ? `${d.model} × ${d.count} = ${color.bold(String(d.estCredits))}${d.estUsd != null ? color.dim(`  ≈ $${d.estUsd}`) : ''}`
      : color.yellow(d.hint)));
  },

  async generate(flags) {
    if (!flags.model) throw usage(`gcv-${S} generate --model <id> --prompt <text> [--wait] [--out DIR] [--no-download]`);
    // Before the key: a model switched off here will not be called whatever the
    // key says, and "set up an API key first" would be a misleading answer.
    store.assertEnabled(flags.model);
    const { key, source } = cfg.requireApiKey(flags['api-key']);

    let balance = null;
    if (!flags['dry-run']) {
      try { balance = (await provider.getBalance(key, 20_000)).amount; } catch { /* the safety check just gets weaker */ }
    }

    // Downloading is ON by default. --out is an explicit path. --no-download is
    // an explicit opt-out for this call. With neither, take the path from the
    // config (download.dir) or the default inside GCV_HOME/output, creating it.
    let out = null;
    let outInfo;
    if (flags['no-download']) {
      outInfo = { dir: null, source: 'flag:--no-download', enabled: false };
    } else if (flags.out) {
      out = resolve(flags.out);
      outInfo = { dir: out, source: 'flag:--out', enabled: true };
    } else {
      outInfo = cfg.resolveOutputDir();
      if (outInfo.enabled && outInfo.dir) { out = outInfo.dir; mkdirSync(out, { recursive: true }); }
    }

    const r = await gen.generate(key, {
      model: flags.model, prompt: flags.prompt, input: parseInput(flags.input), refs: flags.ref || [],
      // --ref covers the primary image input. Everything else the model declares
      // in limits.inputFiles — a closing frame, a mask, a clip — is addressed by
      // name, because only the model knows what it calls those fields.
      files: parseFileFlags(flags.file),
      count: num(flags.count, 'count') ?? 1, out,
      wait: !!flags.wait, pollSec: num(flags.poll, 'poll') ?? 10,
      waitTimeoutSec: num(flags['wait-timeout'], 'wait-timeout') ?? 900,
      timeoutMs: (num(flags.timeout, 'timeout') ?? 60) * 1000,
      maxCostCredits: num(flags['max-cost'], 'max-cost') ?? null,
      idempotencyKey: flags['idempotency-key'] ?? null, force: !!flags.force,
      dryRun: !!flags['dry-run'], runId: flags['run-id'] ?? null, balance,
    });

    return ok(r, { apiKeySource: source, balanceBefore: balance, output: outInfo }, (d) => {
      if (d.dryRun) return color.yellow('dry-run: ') + JSON.stringify(d.estimate, null, 2);
      const warn = d.warnings?.length ? d.warnings.map((w) => color.yellow(`! ${w}`)).join('\n') + '\n\n' : '';
      const downloadNote = !outInfo.enabled
        ? color.yellow(`Downloading is off (${outInfo.source}). The result exists only as a link in the FILES column.\n\n`)
        : outInfo.source === 'default'
          ? color.dim(`No path was set — saved to ${outInfo.dir} (default). Your own permanent path: gcv-${S} config set download.dir <path>\n\n`)
          : '';
      const t = d.totals;
      return warn + downloadNote + table(d.tasks, [
        { title: 'TASK', get: (x) => x.taskId }, { title: 'STATE', get: (x) => x.state },
        { title: 'COST', get: (x) => x.creditsConsumed ?? '—' },
        { title: 'FILES', get: (x) => x.files.join(', ') || x.resultUrls[0] || '—' },
      ]) + `\n\n${color.bold('Total:')} ${t.succeeded}/${t.count} succeeded, ${t.creditsConsumed}${t.actualUsd != null ? ` ≈ ${t.actualUsd}` : ''}`;
    });
  },

  async status(flags, positional) {
    const { key, source } = cfg.requireApiKey(flags['api-key']);
    const taskId = positional[0] || flags.task;
    if (!taskId) throw usage(`gcv-${S} status <taskId>`);
    const t = await provider.getTask(key, taskId, (num(flags.timeout) ?? 60) * 1000);
    return ok({ task: t }, { apiKeySource: source }, (d) =>
      `${d.task.taskId}  ${color.bold(d.task.state)}  ${d.task.progress ?? '—'}%` +
      (d.task.failMsg ? `\n${color.red(d.task.failMsg)}` : '') +
      (d.task.resultUrls?.length ? `\n${d.task.resultUrls.join('\n')}` : ''));
  },

  async wait(flags, positional) {
    const { key, source } = cfg.requireApiKey(flags['api-key']);
    const taskId = positional[0] || flags.task;
    if (!taskId) throw usage(`gcv-${S} wait <taskId>`);
    const t = await gen.pollUntilDone(key, taskId, {
      pollSec: num(flags.poll, 'poll') ?? 10, waitTimeoutSec: num(flags['wait-timeout'], 'wait-timeout') ?? 900,
    });
    if (t.state === 'fail') throw new GcvError('JOB_FAILED', t.failMsg || 'Generation failed', { providerCode: t.failCode });
    return ok({ task: t }, { apiKeySource: source }, (d) => d.task.resultUrls.join('\n') || d.task.state);
  },

  async download(flags, positional) {
    const { key, source } = cfg.requireApiKey(flags['api-key']);
    const taskId = positional[0] || flags.task;
    if (!taskId) throw usage(`gcv-${S} download <taskId> [--out DIR]`);
    const out = resolve(flags.out || '.');
    const t = await provider.getTask(key, taskId, 60_000);
    if (t.state !== 'success') throw new GcvError('JOB_FAILED', `Task ${taskId} is in state "${t.state}" — nothing to download`);
    const files = [];
    for (const [i, url] of (t.resultUrls || []).entries()) {
      const ext = (url.split('?')[0].match(/\.([a-z0-9]{2,4})$/i) || [, 'bin'])[1];
      files.push((await downloadTo(url, resolve(out, `${taskId}_${i + 1}.${ext}`))).path);
    }
    event('downloaded', { taskId, files });
    return ok({ taskId, files }, { apiKeySource: source }, (d) => d.files.join('\n'));
  },

  async cancel(flags, positional) {
    if (!provider.PROVIDER.supports.cancel) throw notSupported(`${provider.PROVIDER.name} does not support task cancellation`);
    const { key } = cfg.requireApiKey(flags['api-key']);
    const taskId = positional[0];
    if (!taskId) throw usage(`gcv-${S} cancel <taskId>`);
    return ok(await provider.cancelTask(key, taskId), {}, () => 'cancelled');
  },

  async ledger(flags) {
    const r = store.readLedger({ since: flags.since, runId: flags['run-id'], limit: num(flags.limit, 'limit') ?? 200 });
    return ok(r, {}, (d) => table(d.entries, [
      { title: 'TIME', get: (e) => e.ts.slice(0, 19).replace('T', ' ') }, { title: 'MODEL', get: (e) => e.model ?? '—' },
      { title: 'STATE', get: (e) => e.state ?? '—' }, { title: 'COST', get: (e) => e.creditsConsumed ?? '—' },
    ]) + `\n\n${color.bold('Total:')} ${d.totals.tasks} tasks, ${d.totals.credits}, ${d.totals.failed} failed`);
  },

  async config(flags, positional) {
    const sub = positional[0];
    if (sub === 'path') return ok({ path: cfg.CONFIG_PATH, home: cfg.GCV_HOME }, {}, (d) => d.path);
    if (sub === 'set') {
      const [, path, ...rest] = positional;
      const value = rest.join(' ');
      if (!path || value === '') throw usage(`gcv-${S} config set <path> <value>`);
      const parsed = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value === 'true' ? true : value === 'false' ? false : value;
      cfg.setConfigValue(path, parsed);
      return ok({ path, value: /apikey/i.test(path) ? cfg.maskKey(value) : parsed }, {}, (d) => `${color.green('✓')} ${d.path} = ${d.value}`);
    }
    if (sub === 'get') {
      const path = positional[1];
      if (!path) {
        const c = structuredClone(cfg.readConfig());
        for (const p of Object.values(c.providers || {})) if (p?.apiKey) p.apiKey = cfg.maskKey(p.apiKey);
        return ok({ config: c }, {}, (d) => JSON.stringify(d.config, null, 2));
      }
      const v = cfg.getConfigValue(path);
      return ok({ path, value: /apikey/i.test(path) ? cfg.maskKey(String(v ?? '')) : v }, {}, (d) => String(d.value ?? ''));
    }
    throw usage(`gcv-${S} config <get|set|path>`);
  },

  // ── Setup ──────────────────────────────────────────────────────────────────

  async init(flags) {
    const steps = [];
    const interactive = process.stdin.isTTY && !flags.yes;

    let { key, source } = cfg.resolveApiKey(flags['api-key']);
    if (!key && interactive) {
      key = (await prompt(`${provider.PROVIDER.name} API key${provider.PROVIDER.apiKeyUrl ? ` (${provider.PROVIDER.apiKeyUrl})` : ''}: `)).trim();
      if (key) {
        cfg.setConfigValue(`providers.${S}.apiKey`, key);
        source = `config:${cfg.CONFIG_PATH}`;
      }
    }
    steps.push({ step: 'key', ok: !!key, detail: key ? source : 'not set' });
    if (!key) {
      return ok({ done: false, steps }, {}, () => `${color.red('✗')} no key.\n  ${color.cyan(`gcv-${S} auth set <key>`)}`);
    }

    try {
      const b = await provider.getBalance(key, 20_000);
      steps.push({ step: 'connection', ok: true, detail: `balance ${b.amount} ${b.currency}` });
    } catch (e) {
      steps.push({ step: 'connection', ok: false, detail: e.message });
      return ok({ done: false, steps }, {}, () => `${color.red('✗')} key rejected: ${e.message}`);
    }

    const cat = store.load();
    let sync = null;
    if (cat.seeded || cat.isStale || flags.force) {
      sync = await store.refresh({ timeoutMs: (num(flags.timeout) ?? 120) * 1000 });
      steps.push({ step: 'catalog', ok: sync.updated, detail: sync.updated ? `${sync.count} models` : sync.hint });
    } else {
      steps.push({ step: 'catalog', ok: true, detail: `${cat.models.length} models, fresh` });
    }

    return ok({ done: true, steps }, {}, (d) =>
      d.steps.map((x) => `${x.ok ? color.green('✓') : color.red('✗')} ${x.step.padEnd(10)} ${color.dim(x.detail)}`).join('\n') +
      `\n\n${color.green('Done.')} Next: ${color.cyan(`gcv-${S} pick image`)}`,
    );
  },

  async auth(flags, positional) {
    const sub = positional[0] || 'show';
    if (sub === 'set') {
      const value = positional[1] || flags['api-key'];
      if (!value) throw usage(`gcv-${S} auth set <key>`);
      cfg.setConfigValue(`providers.${S}.apiKey`, value);
      return ok({ stored: cfg.CONFIG_PATH, masked: cfg.maskKey(value) }, {}, (d) =>
        `${color.green('✓')} key written to ${d.stored} ${color.dim(`(${d.masked})`)}`);
    }
    if (sub === 'clear') {
      cfg.setConfigValue(`providers.${S}.apiKey`, undefined);
      return ok({ cleared: true }, {}, () => `${color.green('✓')} key removed from the config ${color.dim('(environment untouched)')}`);
    }
    if (sub === 'test') {
      const { key, source } = cfg.requireApiKey(flags['api-key']);
      const b = await provider.getBalance(key, 20_000);
      return ok({ valid: true, source, ...b }, {}, (d) =>
        `${color.green('✓')} key works ${color.dim(`(${d.source})`)}\n  balance ${color.bold(String(d.amount))} ${d.currency}`);
    }
    const r = cfg.resolveApiKey(flags['api-key']);
    return ok({ found: !!r.key, source: r.source, masked: cfg.maskKey(r.key) }, {}, (d) =>
      d.found
        ? `${color.green('✓')} key found\n  source: ${color.bold(d.source)}\n  value:  ${color.dim(d.masked)}`
        : `${color.red('✗')} key not found. ${color.cyan(`gcv-${S} auth set <key>`)}`);
  },

  // ── Catalog ────────────────────────────────────────────────────────────────

  async sync(flags) {
    const r = await store.refresh({ timeoutMs: (num(flags.timeout) ?? 120) * 1000 });
    return ok(r, {}, (d) =>
      d.updated
        ? `${color.green('✓')} catalog refreshed: ${d.count} models${d.source ? color.dim(` (${d.source})`) : ''}`
        : `${color.yellow('!')} ${d.hint}`);
  },

  async models(flags) {
    const r = store.list({ type: flags.type, mode: flags.mode, query: flags.search ?? flags.query });
    let models = r.models;
    if (flags.sort === 'price') models = [...models].sort((a, b) => (a.price.credits ?? Infinity) - (b.price.credits ?? Infinity));
    else if (flags.sort === 'name') models = [...models].sort((a, b) => a.id.localeCompare(b.id));
    const shown = models.slice(0, num(flags.limit, 'limit') ?? 40);

    return ok({ models: shown, total: models.length, staleness: r.staleness }, {}, (d) =>
      staleHeader(d.staleness) +
      table(shown, [
        { title: 'MODEL', get: (m) => m.id },
        { title: 'TYPE', get: (m) => m.type ?? '—' },
        { title: 'PRICE', get: (m) => priceCell(m.price) },
        { title: 'USD', get: (m) => usdCell(m.price) },
        { title: 'REFS', get: (m) => m.limits.maxRefs ?? '—' },
      ]) +
      (d.total > shown.length ? color.dim(`\n\nShowing ${shown.length} of ${d.total}. More: --limit ${d.total}`) : ''));
  },

  async prices(flags, positional) {
    const id = positional[0] || flags.model;
    if (id) {
      const { model } = store.show(id);
      return ok({ model }, {}, () => {
        const p = model.price;
        const lines = [`${color.bold(model.id)}  ${color.dim(model.type ?? '')}`, '',
          `Generation price: ${color.bold(priceCell(p))} ${p.unit ?? ''}  ${usdCell(p)}`];
        if (p.inputSurcharge) lines.push(color.yellow(`Input image surcharge: ${p.inputSurcharge.credits}`));
        const vars = model.priceVariants ?? [];
        if (vars.length > 1) {
          lines.push('', color.bold('VARIANTS'), table(vars, [
            { title: 'VARIANT', get: (v) => v.variant ?? '(main)' },
            { title: 'KIND', get: (v) => (v.kind === 'input' ? 'input' : 'output') },
            { title: 'PRICE', get: (v) => v.credits },
            { title: 'UNIT', get: (v) => v.unit ?? '—' },
          ]));
        }
        return lines.join('\n');
      });
    }
    const r = store.list({ type: flags.type });
    const priced = r.models.filter((m) => m.price.credits != null).sort((a, b) => a.price.credits - b.price.credits);
    const shown = priced.slice(0, num(flags.limit, 'limit') ?? 30);
    return ok({ models: shown, total: priced.length, staleness: r.staleness }, {}, (d) =>
      staleHeader(d.staleness) + table(shown, [
        { title: 'MODEL', get: (m) => m.id },
        { title: 'TYPE', get: (m) => m.type ?? '—' },
        { title: 'PRICE', get: (m) => priceCell(m.price) },
        { title: 'UNIT', get: (m) => m.price.unit ?? '—' },
        { title: 'USD', get: (m) => usdCell(m.price) },
      ]));
  },

  async schema(flags, positional) {
    const id = positional[0] || flags.model;
    if (!id) throw usage(`gcv-${S} schema <model>`);
    const { model } = store.show(id);
    if (flags.raw) return ok({ inputSchema: model.inputSchema }, {}, (d) => JSON.stringify(d.inputSchema, null, 2));

    const props = Object.entries(model.inputSchema ?? {});
    return ok({ model: model.id, required: model.required, inputSchema: model.inputSchema, limits: model.limits }, {}, () => {
      if (!props.length) return color.yellow(`The schema for ${model.id} was not parsed. Open ${model.source ?? 'the service documentation'}`);
      const req = new Set(model.required ?? []);
      return `${color.bold(model.id)}\n${color.dim(model.source ?? '')}\n\n` +
        table(props.map(([name, def]) => ({ name, def })), [
          { title: 'FIELD', get: (x) => (req.has(x.name) ? `${x.name}*` : x.name) },
          { title: 'TYPE', get: (x) => x.def.type ?? '—' },
          { title: 'DEFAULT', get: (x) => (x.def.default !== undefined ? JSON.stringify(x.def.default) : '—') },
          { title: 'ALLOWED', get: (x) => (x.def.enum ? x.def.enum.slice(0, 6).join(', ') : x.def.maxLength ? `up to ${x.def.maxLength} chars` : '—') },
        ]) + `\n\n${color.dim('* — required. Passed via --input')}`;
    });
  },

  async pick(flags, positional) {
    const type = positional[0] || flags.type;
    if (!type) throw usage(`gcv-${S} pick <image|video|audio> [--quality draft|good|best] [--budget N]`);
    const quality = flags.quality ?? 'good';
    const budget = num(flags.budget, 'budget') ?? null;
    const refs = num(flags.refs, 'refs') ?? 0;

    const GEN_MODES = { image: ['text-to-image', 'image-to-image'], video: ['text-to-video', 'image-to-video'], audio: ['text-to-music'] }[type] ?? [];
    let pool = store.list({ type }).models.filter((m) => m.price.credits != null);
    // Utilities (upscale, background removal) are not generation — keep them out.
    pool = pool.filter((m) => !/upscale|remove-background|background-removal|separate|isolation/i.test(m.id));
    if (GEN_MODES.length) pool = pool.filter((m) => !m.modes?.length || m.modes.some((x) => GEN_MODES.includes(x)));
    // A model qualifies when it HAS a reference field and its declared ceiling is
    // not lower than asked. An undeclared ceiling is not a zero.
    if (refs > 0) pool = pool.filter((m) => m.limits.refField && (m.limits.maxRefs == null || m.limits.maxRefs >= refs));
    if (budget != null) pool = pool.filter((m) => (m.price.creditsMax ?? m.price.credits) <= budget);

    if (!pool.length) {
      return ok({ candidates: [] }, {}, () => color.yellow('Nothing matched the criteria.') + color.dim(`\nRelax the criteria or refresh the catalog: gcv-${S} sync`));
    }
    const sorted = [...pool].sort((a, b) => a.price.credits - b.price.credits);
    const pickBy = {
      draft: () => sorted.slice(0, 3),
      best: () => sorted.slice(-3).reverse(),
      good: () => sorted.slice(Math.max(0, Math.floor(sorted.length / 2) - 1), Math.floor(sorted.length / 2) + 2),
    }[quality];
    if (!pickBy) throw usage(`--quality must be draft, good or best, got "${quality}"`);

    const candidates = pickBy().map((m) => ({
      id: m.id, price: m.price, limits: m.limits,
      why: quality === 'draft' ? 'lowest price in the category' : quality === 'best' ? 'top price segment' : 'mid-range by price',
    }));
    return ok({ quality, candidates, poolSize: pool.length }, {}, (d) =>
      `${color.dim(`category ${type}, quality ${d.quality}, ${d.poolSize} candidates`)}\n\n` +
      table(d.candidates, [
        { title: 'MODEL', get: (m) => m.id },
        { title: 'PRICE', get: (m) => priceCell(m.price) },
        { title: 'USD', get: (m) => usdCell(m.price) },
        { title: 'REFS', get: (m) => m.limits.maxRefs ?? '—' },
        { title: 'WHY', get: (m) => m.why },
      ]));
  },

  // ── Money ──────────────────────────────────────────────────────────────────

  async jobs(flags) {
    const r = store.readLedger({ runId: flags['run-id'], limit: num(flags.limit, 'limit') ?? 20 });
    let entries = r.entries.filter((e) => e.state && e.state !== 'submitted');
    if (flags.failed) entries = entries.filter((e) => e.state === 'fail');
    return ok({ jobs: entries, totals: r.totals }, {}, (d) =>
      table(d.jobs, [
        { title: 'TIME', get: (e) => e.ts.slice(5, 16).replace('T', ' ') },
        { title: 'MODEL', get: (e) => e.model ?? '—' },
        { title: 'TASK', get: (e) => (e.taskId ?? '—').slice(0, 18) },
        { title: 'RESULT', get: (e) => (e.state === 'fail' ? color.red('failed') : 'done') },
        { title: 'COST', get: (e) => e.creditsConsumed ?? '—' },
      ]) + `\n\n${color.dim(`${d.totals.tasks} tasks, ${d.totals.credits}, ${d.totals.failed} failed`)}`);
  },

  async spend(flags) {
    const r = store.readLedger({ since: flags.since, runId: flags['run-id'], limit: num(flags.limit, 'limit') ?? 1000 });
    if (flags['by-model']) {
      const byModel = new Map();
      for (const e of r.entries) {
        if (e.creditsConsumed == null) continue;
        const cur = byModel.get(e.model) ?? { model: e.model, tasks: 0, credits: 0, failed: 0 };
        cur.tasks += 1; cur.credits += e.creditsConsumed;
        if (e.state === 'fail') cur.failed += 1;
        byModel.set(e.model, cur);
      }
      const rows = [...byModel.values()].sort((a, b) => b.credits - a.credits);
      return ok({ byModel: rows, totals: r.totals }, {}, (d) =>
        table(d.byModel, [
          { title: 'MODEL', get: (m) => m.model ?? '—' },
          { title: 'TASKS', get: (m) => m.tasks },
          { title: 'COST', get: (m) => m.credits },
          { title: 'FAILED', get: (m) => (m.failed ? color.red(String(m.failed)) : '0') },
        ]) + `\n\n${color.bold('Grand total:')} ${d.totals.credits}`);
    }
    return ok(r, {}, (d) =>
      table(d.entries.slice(-30), [
        { title: 'TIME', get: (e) => e.ts.slice(0, 16).replace('T', ' ') },
        { title: 'MODEL', get: (e) => e.model ?? '—' },
        { title: 'STATE', get: (e) => e.state ?? '—' },
        { title: 'COST', get: (e) => e.creditsConsumed ?? '—' },
      ]) + `\n\n${color.bold('Total:')} ${d.totals.tasks} tasks, ${d.totals.credits}, ${d.totals.failed} failed`);
  },

  async version() {
    return ok({ version: VERSION, contract: cfg.CONTRACT, provider: S }, {}, (d) => d.version);
  },

  async help(flags, positional) {
    const topic = positional[0];
    if (topic) {
      const text = renderCommand(ALIASES[topic] ?? topic, color);
      if (!text) {
        process.stderr.write(`No help for "${topic}". Command list: gcv-${S} help\n`);
        return EXIT.USAGE;
      }
      process.stdout.write(text + '\n');
      return EXIT.OK;
    }
    process.stdout.write(renderOverview(VERSION, color) + '\n');
    return EXIT.OK;
  },
};

// ── rendering helpers ────────────────────────────────────────────────────────

/** "7–14" for a range, "4" for an exact price, "?" when there is none. */
function priceCell(p) {
  if (!p || p.credits == null) return '?';
  return p.basis === 'range' && p.creditsMax !== p.credits ? `${p.credits}–${p.creditsMax}` : String(p.credits);
}

function usdCell(p) {
  if (!p || p.usd == null) return '?';
  return p.basis === 'range' && p.usdMax !== p.usd ? `$${p.usd}–$${p.usdMax}` : `$${p.usd}`;
}

function staleHeader(s) {
  if (s.seeded) return color.yellow(`Catalog is empty. Run: gcv-${S} sync\n\n`);
  if (s.isStale) return color.yellow(`Catalog is stale (${s.fetchedAt ?? 'never'}). Refresh: gcv-${S} sync\n\n`);
  return '';
}

/** Single-line input. Only in init, and only when a TTY is present. */
function prompt(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => resolve(String(d)));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  let parsed;
  try { parsed = parseArgs(argv); }
  catch (e) { initOutput({ command: 'parse', json: argv.includes('--json') }); return fail(e); }

  const { flags, positional } = parsed;
  let name = positional.shift() || (flags.version ? 'version' : 'help');
  if (flags.help) name = 'help';

  initOutput({
    json: !!flags.json, quiet: !!flags.quiet, verbose: !!flags.verbose,
    color: !flags['no-color'] && process.stdout.isTTY !== false, command: name,
  });

  name = ALIASES[name] ?? name;

  const cmd = commands[name];
  if (!cmd) return fail(usage(`Unknown command "${name}". Available: ${Object.keys(commands).join(', ')}`));
  try { return await cmd(flags, positional); } catch (e) { return fail(e); }
}

process.on('SIGINT', () => process.exit(EXIT.INTERRUPTED));

main().then((c) => process.exit(c ?? EXIT.OK)).catch((e) => {
  process.stderr.write(`Uncaught error: ${e?.stack || e}\n`);
  process.exit(EXIT.INTERNAL);
});
