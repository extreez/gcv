#!/usr/bin/env node
/**
 * MCP server. JSON-RPC 2.0 over stdio, zero dependencies.
 * Not to be edited per service — all specifics live in src/provider.mjs.
 *
 * Start: node mcp/server.mjs --api-key <k>   (or an environment variable)
 * A key in the arguments is visible in the OS process list — use env where that matters.
 */

import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import * as cfg from '../src/config.mjs';
import * as store from '../src/store.mjs';
import * as gen from '../src/generate.mjs';
import * as provider from '../src/provider.mjs';
import { GcvError } from '../src/errors.mjs';

const S = cfg.SERVICE;
const SERVER = { name: `gcv-${S}`, version: '0.1.0' };
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const argv = process.argv.slice(2);
const keyIdx = argv.findIndex((a) => a === '--api-key' || a.startsWith('--api-key='));
if (keyIdx !== -1) {
  const a = argv[keyIdx];
  cfg.setMcpApiKey(a.includes('=') ? a.split('=').slice(1).join('=') : argv[keyIdx + 1]);
}
const apiKey = () => cfg.requireApiKey(null).key;

const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });

const TOOLS = [
  {
    name: `${S}_doctor`,
    description: `${provider.PROVIDER.name} readiness check: is a key found and where from, does the API respond, is the catalog populated. Call this first whenever something is wrong.`,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const key = cfg.resolveApiKey(null);
      let balance = null, apiError = null;
      if (key.key) {
        try { balance = (await provider.getBalance(key.key, 20_000)).amount; }
        catch (e) { apiError = e.message; }
      }
      const cat = store.load();
      return {
        apiKeyFound: !!key.key, apiKeySource: key.source, balance, apiError,
        catalog: { models: cat.models.length, fetchedAt: cat.fetchedAt, isStale: cat.isStale, seeded: cat.seeded },
        usdRate: cfg.unitUsdRate(), baseUrl: cfg.BASE_URL(), provider: provider.PROVIDER,
      };
    },
  },
  {
    name: `${S}_balance`,
    description: 'Account balance. Cheap, no side effects.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const b = await provider.getBalance(apiKey(), 20_000);
      return { ...b, usd: cfg.toUsd(b.amount) };
    },
  },
  {
    name: `${S}_catalog_list`,
    description: 'Models from the local cache with prices and limits. The source of truth for choosing a model and building an estimate. seeded=true or isStale=true means the prices are unreliable.',
    inputSchema: { type: 'object', properties: { type: str('image | video | audio'), mode: str('mode'), query: str('search') } },
    handler: async (a) => store.list(a),
  },
  {
    name: `${S}_catalog_show`,
    description: 'Model card: input schema, limits, price. Call this BEFORE generating.',
    inputSchema: { type: 'object', properties: { model: str('model id') }, required: ['model'] },
    handler: async (a) => store.show(a.model),
  },
  {
    name: `${S}_catalog_refresh`,
    description: 'Attempts a machine-readable catalog refresh. It may return needsManual=true — models are then entered via catalog_set from the documentation.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => store.refresh(),
  },
  {
    name: `${S}_catalog_set`,
    description: 'Write a model into the catalog: id, type, price, limits. This is how documentation knowledge reaches the cache. Do NOT invent a price.',
    inputSchema: {
      type: 'object',
      properties: {
        model: str('model id'), type: str('image | video | audio'),
        credits: int('price per unit'), priceUnit: str('per_image | per_second | per_video | per_track'),
        maxRefs: int('maximum references'), maxDurationSec: int('maximum duration'),
        aspectRatios: { type: 'array', items: { type: 'string' } },
        inputSchema: { type: 'object' }, notes: str('model specifics'), source: str('documentation URL'),
      },
      required: ['model'],
    },
    handler: async (a) => store.upsert({
      id: a.model, type: a.type,
      price: { credits: a.credits ?? null, unit: a.priceUnit ?? null },
      limits: { maxRefs: a.maxRefs ?? null, maxDurationSec: a.maxDurationSec ?? null, aspectRatios: a.aspectRatios ?? null },
      inputSchema: a.inputSchema ?? null, notes: a.notes ?? null, source: a.source ?? 'mcp', verified: true,
    }),
  },
  {
    name: `${S}_estimate`,
    description: 'Cost estimate. Spends no money. known=false means the price is unknown and generation must not start without explicit consent.',
    inputSchema: { type: 'object', properties: { model: str('id'), count: int('how many'), input: { type: 'object' } }, required: ['model'] },
    handler: async (a) => gen.estimate({ model: a.model, count: a.count ?? 1, input: a.input ?? {} }),
  },
  {
    name: `${S}_generate`,
    description: 'SPENDS MONEY. It must be preceded by catalog_show (limits), estimate (price) and the user\'s explicit consent to the amount. maxCostCredits is the safety limit.',
    inputSchema: {
      type: 'object',
      properties: {
        model: str('model id'), prompt: str('prompt'), input: { type: 'object', description: 'other model parameters' },
        refs: { type: 'array', items: { type: 'string' }, description: 'URLs or local paths' },
        count: int('how many generations'), out: str('download folder'),
        wait: { type: 'boolean' }, maxCostCredits: int('safety limit'),
        dryRun: { type: 'boolean' }, runId: str('run id for the ledger'),
      },
      required: ['model'],
    },
    handler: async (a) => {
      const key = apiKey();
      let balance = null;
      if (!a.dryRun) {
        try { balance = (await provider.getBalance(key, 20_000)).amount; } catch { /* the safety check just gets weaker */ }
      }
      return gen.generate(key, {
        model: a.model, prompt: a.prompt, input: a.input ?? {},
        refs: (a.refs ?? []).map((r) => (/^https?:\/\//.test(r) ? r : resolve(r))),
        count: a.count ?? 1, out: a.out ? resolve(a.out) : null, wait: a.wait !== false,
        maxCostCredits: a.maxCostCredits ?? null, dryRun: !!a.dryRun, runId: a.runId ?? null, balance,
      });
    },
  },
  {
    name: `${S}_status`,
    description: 'Task state: state, progress, cost, result links.',
    inputSchema: { type: 'object', properties: { taskId: str('task id') }, required: ['taskId'] },
    handler: async (a) => provider.getTask(apiKey(), a.taskId, 60_000),
  },
  {
    name: `${S}_wait`,
    description: 'Wait for a task to finish, polling.',
    inputSchema: { type: 'object', properties: { taskId: str('id'), pollSec: int('interval'), timeoutSec: int('timeout') }, required: ['taskId'] },
    handler: async (a) => gen.pollUntilDone(apiKey(), a.taskId, { pollSec: a.pollSec ?? 10, waitTimeoutSec: a.timeoutSec ?? 900 }),
  },
  {
    name: `${S}_upload`,
    description: 'Upload a local file and get a public URL for use as a reference.',
    inputSchema: { type: 'object', properties: { path: str('path to the file') }, required: ['path'] },
    handler: async (a) => provider.uploadFile(apiKey(), resolve(a.path)),
  },
  {
    name: `${S}_ledger`,
    description: 'Spend ledger: what was generated and what it cost.',
    inputSchema: { type: 'object', properties: { since: str('ISO date'), runId: str('filter'), limit: int('how many entries') } },
    handler: async (a) => store.readLedger(a),
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return;   // notification

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return reply(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS.at(-1),
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions:
          `${provider.PROVIDER.name} tools. ${S}_generate spends real money: it must be preceded by ` +
          `${S}_catalog_show (limits), ${S}_estimate (price) and the user's explicit consent to the amount.`,
      });
    }
    case 'ping': return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = BY_NAME.get(params?.name);
      if (!tool) return replyError(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        const result = await tool.handler(params.arguments ?? {});
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false });
      } catch (e) {
        // A tool error is a result with isError, not a JSON-RPC error:
        // that way the model sees the structure and can correct itself.
        const payload = e instanceof GcvError ? e.toJSON() : { code: 'INTERNAL', message: e?.message || String(e), retryable: false };
        return reply(id, { content: [{ type: 'text', text: JSON.stringify({ error: payload }, null, 2) }], structuredContent: { error: payload }, isError: true });
      }
    }
    case 'resources/list': return reply(id, { resources: [] });
    case 'prompts/list': return reply(id, { prompts: [] });
    default: return replyError(id, -32601, `Method not supported: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); }
  catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON parse error' } }); }
  try { await handle(msg); }
  catch (e) { replyError(msg?.id ?? null, -32603, e?.message || 'Internal error'); }
});
rl.on('close', () => process.exit(0));
