#!/usr/bin/env node
/**
 * CLI-CONTRACT v1 conformance check.
 *
 *   node verify-contract.mjs ../packages/gcv-fal
 *
 * Runs only free commands: spends no money, needs no real API key.
 * Until this passes, treat the CLI as not ready — /creative relies on the
 * contract, not on the good will of an implementation.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const run = promisify(execFile);

const pkgDir = resolve(process.argv[2] || '.');
if (!existsSync(join(pkgDir, 'package.json'))) {
  process.stderr.write(`This does not look like a package: ${pkgDir}\n`);
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const service = pkg.name.replace(/^gcv-/, '');
const binName = Object.keys(pkg.bin || {}).find((b) => !b.endsWith('-mcp'));
const binPath = join(pkgDir, pkg.bin?.[binName] || `bin/gcv-${service}.mjs`);

if (!existsSync(binPath)) {
  process.stderr.write(`Executable not found: ${binPath}\n`);
  process.exit(2);
}

// Isolated GCV_HOME: the check must not touch the real config or spend ledger.
const sandbox = mkdtempSync(join(tmpdir(), 'gcv-verify-'));
const env = { ...process.env, GCV_HOME: sandbox };
delete env[`${service.toUpperCase()}_API_KEY`];
delete env[`GCV_${service.toUpperCase()}_API_KEY`];

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

async function cli(args, { expectExit = 0 } = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [binPath, ...args], { env, cwd: sandbox, timeout: 60_000 });
    return { exit: 0, stdout, stderr };
  } catch (e) {
    return { exit: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function parseEnvelope(stdout) {
  try { return JSON.parse(stdout); } catch { return null; }
}

function checkEnvelope(label, res, { expectOk }) {
  const env = parseEnvelope(res.stdout);
  if (!env) return check(`${label}: JSON envelope`, false, 'stdout did not parse as JSON');

  check(`${label}: JSON envelope`, true);
  check(`${label}: ok=${expectOk}`, env.ok === expectOk, `got ok=${env.ok}`);
  check(`${label}: contract="1"`, env.contract === '1', `got ${env.contract}`);
  check(`${label}: provider`, env.provider === service, `got ${env.provider}, expected ${service}`);
  check(`${label}: meta present`, typeof env.meta === 'object' && env.meta !== null);
  if (expectOk) check(`${label}: data present`, env.data !== undefined);
  else {
    check(`${label}: error.code present`, typeof env.error?.code === 'string', JSON.stringify(env.error));
    check(`${label}: error.retryable present`, typeof env.error?.retryable === 'boolean');
  }
  return env;
}

console.log(`Verifying ${pkg.name} → ${binPath}\n`);

// 1. Required commands are present
const REQUIRED = [
  'init', 'auth', 'config', 'doctor',
  'models', 'prices', 'schema', 'pick', 'sync', 'catalog',
  'estimate', 'generate', 'status', 'wait', 'download', 'upload',
  'balance', 'jobs', 'spend',
];
const help = await cli(['help']);
for (const c of REQUIRED) {
  check(`command "${c}" mentioned in help`, help.stdout.includes(c), '');
}
check('help: generate marked as paid', /SPENDS MONEY/.test(help.stdout));
check('help: exit codes listed', /EXIT CODES/.test(help.stdout));

// Per-command help
const helpGen = await cli(['help', 'generate']);
check('help <command>: exit 0', helpGen.exit === 0, `exit=${helpGen.exit}`);
check('help <command>: has examples', /EXAMPLES/.test(helpGen.stdout));
const helpBogus = await cli(['help', 'no-such-command']);
check('help for a missing command: exit 2', helpBogus.exit === 2, `exit=${helpBogus.exit}`);

// Aliases resolve
const aliasRun = await cli(['run', '--json']);
check('alias run → generate', aliasRun.exit === 2 || aliasRun.exit === 3, `exit=${aliasRun.exit}`);

// auth show does not reveal the key
const authShow = await cli(['auth', 'show', '--json']);
check('auth show: exit 0 without a key', authShow.exit === 0, `exit=${authShow.exit}`);
const authEnv = parseEnvelope(authShow.stdout);
check('auth show: key not revealed', !/[A-Za-z0-9_-]{24,}/.test(JSON.stringify(authEnv?.data ?? {})));

// 2. doctor — works without a key, exit 0, valid envelope
const doctor = await cli(['doctor', '--json']);
check('doctor: exit 0 without a key', doctor.exit === 0, `exit=${doctor.exit}`);
const doctorEnv = checkEnvelope('doctor', doctor, { expectOk: true });
check('doctor: healthy present', typeof doctorEnv?.data?.healthy === 'boolean');
check('doctor: key not revealed', !/[A-Za-z0-9_-]{24,}/.test(JSON.stringify(doctorEnv?.data?.checks ?? '')), 'output looks like it contains a raw key');

// 3. balance without a key → exit 3 AUTH
const bal = await cli(['balance', '--json']);
check('balance without a key: exit 3', bal.exit === 3, `exit=${bal.exit}`);
const balEnv = checkEnvelope('balance', bal, { expectOk: false });
check('balance: error.code=AUTH', balEnv?.error?.code === 'AUTH', balEnv?.error?.code);

// 4. Unknown command → exit 2 USAGE
const bogus = await cli(['no-such-command', '--json']);
check('unknown command: exit 2', bogus.exit === 2, `exit=${bogus.exit}`);
check('unknown command: USAGE', parseEnvelope(bogus.stdout)?.error?.code === 'USAGE');

// 5. catalog list — envelope with models and staleness
const cat = await cli(['catalog', 'list', '--json']);
check('catalog list: exit 0', cat.exit === 0, `exit=${cat.exit}`);
const catEnv = checkEnvelope('catalog list', cat, { expectOk: true });
check('catalog list: data.models is an array', Array.isArray(catEnv?.data?.models));
check('catalog list: data.staleness present', typeof catEnv?.data?.staleness === 'object');

// 6. catalog set → estimate → dry-run, the full free cycle
await cli(['catalog', 'set', '--model', 'verify/test-model', '--type', 'image', '--credits', '10', '--price-unit', 'per_image', '--max-refs', '2', '--json']);
const est = await cli(['estimate', '--model', 'verify/test-model', '--count', '3', '--json']);
check('estimate: exit 0', est.exit === 0, `exit=${est.exit}`);
const estEnv = checkEnvelope('estimate', est, { expectOk: true });
check('estimate: estCredits = 30', estEnv?.data?.estCredits === 30, `got ${estEnv?.data?.estCredits}`);
check('estimate: known=true', estEnv?.data?.known === true);

// 7. preflight catches an exceeded reference limit → exit 11
const val = await cli(['generate', '--model', 'verify/test-model', '--prompt', 'x', '--ref', 'https://e.com/1.png', '--ref', 'https://e.com/2.png', '--ref', 'https://e.com/3.png', '--api-key', 'FAKE', '--dry-run', '--json']);
check('preflight reference limit: exit 11', val.exit === 11, `exit=${val.exit}`);
check('preflight: VALIDATION', parseEnvelope(val.stdout)?.error?.code === 'VALIDATION');

// 8. Budget safety limit → exit 10
const bud = await cli(['generate', '--model', 'verify/test-model', '--prompt', 'x', '--count', '5', '--max-cost', '20', '--api-key', 'FAKE', '--dry-run', '--json']);
check('budget safety limit: exit 10', bud.exit === 10, `exit=${bud.exit}`);
check('safety limit: BUDGET_EXCEEDED', parseEnvelope(bud.stdout)?.error?.code === 'BUDGET_EXCEEDED');

// 9. dry-run touches no network and spends no money
const dry = await cli(['generate', '--model', 'verify/test-model', '--prompt', 'x', '--count', '2', '--api-key', 'FAKE', '--dry-run', '--json']);
check('dry-run: exit 0', dry.exit === 0, `exit=${dry.exit}`);
check('dry-run: dryRun=true', parseEnvelope(dry.stdout)?.data?.dryRun === true);
check('dry-run: no tasks created', (parseEnvelope(dry.stdout)?.data?.tasks ?? []).length === 0);

// 10. stdout stays clean: progress must never land there
check('stdout holds exactly one JSON object', (dry.stdout.match(/^\{/gm) || []).length === 1);

// 11. MCP server answers tools/list
const mcpPath = join(pkgDir, 'mcp', 'server.mjs');
if (existsSync(mcpPath)) {
  const mcp = await new Promise((res) => {
    const child = execFile(process.execPath, [mcpPath], { env, timeout: 20_000 }, (err, stdout) => res(stdout || ''));
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    child.stdin.end();
  });
  let tools = [];
  try { tools = JSON.parse(mcp.trim().split('\n')[0])?.result?.tools ?? []; } catch { /* no answer */ }
  check('MCP: tools/list responds', tools.length > 0, `tools: ${tools.length}`);
  check('MCP: generate present', tools.some((t) => t.name.endsWith('_generate')));
  check('MCP: every tool has a description', tools.every((t) => typeof t.description === 'string' && t.description.length > 10));
}

// 12. No dependencies
check('zero-dep', Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify(pkg.dependencies));

// 13. provider.mjs has no open TODOs
const provPath = join(pkgDir, 'src', 'provider.mjs');
if (existsSync(provPath)) {
  const src = readFileSync(provPath, 'utf8');
  const todos = (src.match(/^\s*\/\/ TODO/gm) || []).length;
  check('provider.mjs: TODOs closed', todos === 0, todos ? `${todos} left` : '');
  check('provider.mjs: placeholders replaced', !src.includes('__SERVICE__'), '__SERVICE__ still present');
  check('provider.mjs: createTask has no auto-retries', /createTask[\s\S]{0,900}retries:\s*0/.test(src), 'retries must be 0 — otherwise you pay twice');
}

// ── report ───────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.pass);
for (const r of results) {
  console.log(`${r.pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${r.name}${r.detail && !r.pass ? `  \x1b[2m${r.detail}\x1b[0m` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

if (failed.length) {
  console.log(`\x1b[31mContract not satisfied. /creative will not work with this CLI.\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32mContract satisfied.\x1b[0m');
