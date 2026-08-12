/**
 * Help text. One source of truth for both the command overview and the
 * per-command detail (`gcv-{service} help generate`). Not to be edited per
 * service: names are substituted from PROVIDER.
 *
 * Rule for the copy: first what the command does, then what it can cost you.
 * Commands that spend money are marked explicitly — that is not decoration.
 */

import { PROVIDER } from './provider.mjs';

const S = PROVIDER.id;
const NAME = `gcv-${S}`;
const CUR = PROVIDER.currency === 'usd' ? 'dollars' : 'credits';

export const GLOBAL_FLAGS = [
  ['--json', 'machine output: one envelope on stdout, events on stderr'],
  ['--quiet', 'no progress output'],
  ['--verbose', 'diagnostics on stderr'],
  ['--api-key K', 'key given explicitly, bypassing every other source'],
  ['--timeout S', 'request timeout, seconds'],
  ['--no-color', 'no ANSI colours'],
  ['--dry-run', 'compute everything, spend no money and touch no network'],
];

export const COMMANDS = {
  init: {
    group: 'Setup',
    summary: 'Setup wizard: key, rate, catalog — in one pass',
    usage: `${NAME} init [--api-key K] [--yes]`,
    details:
      'Checks the key, asks for one if needed, refreshes the model catalog.\n' +
      'In a non-interactive environment it asks nothing — it prints what is missing.',
    examples: [[`${NAME} init`, 'full setup with questions']],
  },
  auth: {
    group: 'Setup',
    summary: 'Access key: set it, show its source, test it, remove it',
    usage: `${NAME} auth <set|show|test|clear> [key]`,
    details:
      'set   — write the key into ~/.gcv/config.json (mode 600)\n' +
      'show  — where the key currently comes from, and its mask. The value is never printed\n' +
      'test  — a real balance request: is the key working or not\n' +
      'clear — remove the key from the config (environment variables are untouched)\n\n' +
      'Lookup order:\n' +
      `  --api-key → project .env → ${PROVIDER.apiKeyEnv} → ~/.gcv/config.json → MCP argument`,
    examples: [[`${NAME} auth set <key>`, ''], [`${NAME} auth test`, 'check that the key works']],
  },
  config: {
    group: 'Setup',
    summary: 'Other settings: base URL, rate, paths',
    usage: `${NAME} config <get|set|path> [path] [value]`,
    examples: [[`${NAME} config get`, 'the whole config, keys masked']],
  },
  doctor: {
    group: 'Setup',
    summary: 'Readiness check: key, connectivity, catalog, rate',
    usage: `${NAME} doctor`,
    details: 'The first thing to run on a confusing error. Spends no money.',
    examples: [[`${NAME} doctor`, '']],
  },

  models: {
    group: 'Catalog',
    summary: 'List models with prices and limits',
    usage: `${NAME} models [--type image|video|audio] [--search TEXT] [--sort price|name] [--limit N]`,
    details:
      'Data comes from the local cache. Empty or stale — run `sync` first.\n' +
      'A price shown as "7–14" means it depends on request parameters.',
    examples: [[`${NAME} models --type image --sort price`, 'images from cheapest to priciest']],
  },
  prices: {
    group: 'Catalog',
    summary: 'Detailed model pricing: every variant and surcharge',
    usage: `${NAME} prices [MODEL] [--type image|video|audio] [--limit N]`,
    examples: [[`${NAME} prices <model>`, 'every price variant of one model']],
  },
  schema: {
    group: 'Catalog',
    summary: 'Model parameter schema: fields, allowed values, limits',
    usage: `${NAME} schema MODEL [--raw]`,
    details: 'What you may pass in --input. Read it before generating, not after an error.',
    examples: [[`${NAME} schema <model>`, '']],
  },
  pick: {
    group: 'Catalog',
    summary: 'Pick a model for a task and a budget',
    usage: `${NAME} pick <image|video|audio> [--quality draft|good|best] [--budget N] [--refs N]`,
    details: 'Returns several candidates with prices and reasoning, rather than one "best" answer.',
    examples: [[`${NAME} pick image --quality draft`, 'cheap and plenty']],
  },
  sync: {
    group: 'Catalog',
    summary: 'Refresh the model and price catalog from the service sources',
    usage: `${NAME} sync [--timeout S]`,
    details:
      'What exactly gets fetched is decided by provider.refreshCatalog(). If the\n' +
      'service has no machine-readable source, the command says so honestly and\n' +
      'offers manual entry rather than filling the catalog with guesses.',
    examples: [[`${NAME} sync`, '']],
  },
  catalog: {
    group: 'Catalog',
    summary: 'Low-level operations on the catalog cache',
    usage: `${NAME} catalog <list|show|refresh|set|import> [...]`,
    details: 'For everyday work, models / prices / schema / sync are more convenient.',
    examples: [[`${NAME} catalog set --model <id> --type image --credits 5`, 'add a model by hand']],
  },

  estimate: {
    group: 'Generation',
    summary: 'What this will cost. Spends no money',
    usage: `${NAME} estimate --model MODEL [--count N] [--input JSON]`,
    details:
      'When the price depends on parameters, a range is returned. Safety limits use\n' +
      'the upper bound: understating an estimate is more dangerous than overstating it.',
    examples: [[`${NAME} estimate --model <model> --count 5`, '']],
  },
  generate: {
    group: 'Generation',
    summary: 'SPENDS MONEY. Create a generation and collect the result',
    usage:
      `${NAME} generate --model MODEL --prompt TEXT [--ref FILE]... [--count N]\n` +
      `${' '.repeat(NAME.length)}          [--out DIR] [--wait] [--max-cost N] [--input JSON]`,
    details:
      `When money is charged: ${PROVIDER.billing}\n\n` +
      'Therefore:\n' +
      '  --max-cost  always set it. A refusal (code 10) is cheaper than being off by 10x\n' +
      '  --dry-run   runs every check for free and without network access\n' +
      '  repeating the same command does not create a second task — idempotency holds',
    examples: [
      [`${NAME} generate --model <model> --prompt "..." --out ./out --wait --max-cost 20`, 'the usual case'],
      [`${NAME} generate --model <model> --prompt "..." --count 4 --dry-run`, 'check the plan for free'],
    ],
  },
  status: { group: 'Generation', summary: 'Task state by its id', usage: `${NAME} status TASK_ID`, examples: [] },
  wait: { group: 'Generation', summary: 'Wait for a task to finish', usage: `${NAME} wait TASK_ID [--poll S]`, examples: [] },
  download: { group: 'Generation', summary: 'Download the result of a finished task', usage: `${NAME} download TASK_ID [--out DIR]`, examples: [] },
  upload: {
    group: 'Generation',
    summary: 'Upload a file and get a public URL to use as a reference',
    usage: `${NAME} upload FILE [FILE...]`,
    details: 'Rarely needed by hand — generate does it for you.',
    examples: [],
  },
  cancel: {
    group: 'Generation',
    summary: PROVIDER.supports.cancel ? 'Cancel a task' : `Cancellation — ${PROVIDER.name} does not support it`,
    usage: `${NAME} cancel TASK_ID`,
    details: PROVIDER.supports.cancel ? '' : 'Always returns code 9.',
    examples: [],
  },

  balance: { group: 'Money', summary: `Account balance in ${CUR}`, usage: `${NAME} balance`, details: 'Alias: credits', examples: [] },
  jobs: {
    group: 'Money',
    summary: 'Recent tasks: what ran, how it ended, what it cost',
    usage: `${NAME} jobs [--limit N] [--failed]`,
    examples: [[`${NAME} jobs --failed`, 'failures only — those were charged too']],
  },
  spend: {
    group: 'Money',
    summary: 'Spend report for a period',
    usage: `${NAME} spend [--since ISO-DATE] [--by-model]`,
    details: 'Alias: ledger',
    examples: [[`${NAME} spend --by-model`, 'where the money actually went']],
  },

  version: { group: 'Other', summary: 'CLI and contract version', usage: `${NAME} version`, examples: [] },
  help: { group: 'Other', summary: 'Help. With an argument — details for one command', usage: `${NAME} help [COMMAND]`, examples: [] },
};

export const ALIASES = {
  run: 'generate',
  credits: 'balance',
  ledger: 'spend',
  setup: 'init',
  key: 'auth',
  recommend: 'pick',
  refresh: 'sync',
};

const EXIT_TABLE = [
  ['0', 'success'], ['2', 'bad arguments'], ['3', 'key missing or rejected'],
  ['4', 'insufficient funds'], ['5', 'service failure'], ['6', 'timeout'],
  ['7', 'generation failed — money spent'], ['8', 'network unavailable'],
  ['9', 'the service cannot do this'], ['10', 'estimate above --max-cost'],
  ['11', 'parameter validation failed — no money spent'],
];

export function renderOverview(version, c) {
  const groups = new Map();
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    if (!groups.has(cmd.group)) groups.set(cmd.group, []);
    groups.get(cmd.group).push([name, cmd.summary]);
  }
  const w = Math.max(...Object.keys(COMMANDS).map((n) => n.length)) + 2;
  const out = [
    `${c.bold(`${NAME} ${version}`)} — generation through ${PROVIDER.name}`,
    '',
    `${c.dim('Getting started:')}  ${NAME} init  →  ${NAME} pick image  →  ${NAME} generate ...`,
    '',
  ];
  for (const [group, items] of groups) {
    out.push(c.bold(group.toUpperCase()));
    for (const [name, summary] of items) {
      out.push(`  ${c.cyan(name.padEnd(w))}${name === 'generate' ? c.yellow(summary) : summary}`);
    }
    out.push('');
  }
  out.push(c.bold('GLOBAL FLAGS'));
  for (const [flag, desc] of GLOBAL_FLAGS) out.push(`  ${c.cyan(flag.padEnd(w + 4))}${desc}`);
  out.push('');
  out.push(c.bold('SAFETY LIMITS') + c.dim('  (generate)'));
  out.push(`  ${c.cyan('--max-cost N'.padEnd(w + 4))}refuse if the estimate exceeds N`);
  out.push(`  ${c.cyan('--idempotency-key K'.padEnd(w + 4))}a repeat with the same key creates no second task`);
  out.push(`  ${c.cyan('--force'.padEnd(w + 4))}ignore idempotency`);
  out.push('');
  out.push(c.bold('ALIASES'));
  out.push('  ' + Object.entries(ALIASES).map(([a, t]) => `${a} → ${t}`).join('  ·  '));
  out.push('');
  out.push(c.bold('EXIT CODES'));
  out.push('  ' + EXIT_TABLE.map(([code, d]) => `${code} ${c.dim(d)}`).join('  ·  '));
  out.push('');
  out.push(c.dim(`Details for a command:  ${NAME} help <command>`));
  if (PROVIDER.apiKeyUrl) out.push(c.dim(`API key:                ${PROVIDER.apiKeyUrl}`));
  return out.join('\n');
}

export function renderCommand(name, c) {
  const cmd = COMMANDS[name];
  if (!cmd) return null;
  const out = [`${c.bold(name)} — ${cmd.summary}`, '', c.bold('USAGE')];
  out.push(cmd.usage.split('\n').map((l) => '  ' + l).join('\n'));
  if (cmd.details) out.push('', cmd.details.split('\n').map((l) => (l ? '  ' + l : '')).join('\n'));
  if (cmd.examples?.length) {
    out.push('', c.bold('EXAMPLES'));
    for (const [ex, note] of cmd.examples) {
      out.push('  ' + c.cyan(ex));
      if (note) out.push('  ' + c.dim(note));
      out.push('');
    }
  }
  const aliases = Object.entries(ALIASES).filter(([, t]) => t === name).map(([a]) => a);
  if (aliases.length) out.push(c.dim(`Aliases: ${aliases.join(', ')}`));
  return out.join('\n').trimEnd();
}
