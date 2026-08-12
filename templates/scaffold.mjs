#!/usr/bin/env node
/**
 * Generates a new gcv-{service} from cli-template.
 *
 *   node scaffold.mjs --service fal --name "fal.ai" \
 *     --base-url https://queue.fal.run --docs https://fal.ai/docs \
 *     --api-key-url https://fal.ai/dashboard/keys \
 *     --out ../packages/gcv-fal
 *
 * Copies the template, substitutes names, renames the binary.
 * src/provider.mjs is left with TODO markers — the agent closes them from the docs.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, 'cli-template');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const service = flag('service');
if (!service || !/^[a-z][a-z0-9-]*$/.test(service)) {
  process.stderr.write('Need --service <slug> in lower case (kie, fal, wavespeed)\n');
  process.exit(2);
}

const subs = {
  __SERVICE__: service,
  __SERVICE_UPPER__: service.toUpperCase().replace(/-/g, '_'),
  __SERVICE_NAME__: flag('name', service),
  __BASE_URL__: flag('base-url', 'https://api.example.com'),
  __DOCS_URL__: flag('docs', ''),
  __API_KEY_URL__: flag('api-key-url', ''),
};

const out = resolve(flag('out', join(HERE, '..', 'packages', `gcv-${service}`)));
const force = args.includes('--force');

if (existsSync(out) && !force) {
  process.stderr.write(`Directory already exists: ${out}\nAdd --force if you really want to overwrite it.\n`);
  process.exit(2);
}

const SKIP = new Set(['TEMPLATE.md', 'node_modules', '.git']);
const TEXT = /\.(mjs|js|json|md|txt|yml|yaml)$/i;

const substitute = (text) =>
  Object.entries(subs).reduce((acc, [k, v]) => acc.replaceAll(k, v), text);

let files = 0;

function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    if (SKIP.has(entry)) continue;
    const src = join(from, entry);
    // bin/cli.mjs → bin/gcv-{service}.mjs so the file name matches the command
    const dstName = entry === 'cli.mjs' ? `gcv-${service}.mjs` : entry;
    const dst = join(to, dstName);

    if (statSync(src).isDirectory()) { copyDir(src, dst); continue; }
    if (TEXT.test(entry)) writeFileSync(dst, substitute(readFileSync(src, 'utf8')), 'utf8');
    else writeFileSync(dst, readFileSync(src));
    files++;
  }
}

copyDir(TEMPLATE, out);

// package.json: bin points at the renamed file
const pkgPath = join(out, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.bin = { [`gcv-${service}`]: `bin/gcv-${service}.mjs`, [`gcv-${service}-mcp`]: 'mcp/server.mjs' };
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

process.stdout.write(
  JSON.stringify(
    {
      ok: true,
      service,
      out,
      files,
      next: [
        `Fill in ${join(out, 'src', 'provider.mjs')} — it has TODO markers`,
        `Add models: node ${join(out, 'bin', `gcv-${service}.mjs`)} catalog set --model <id> --credits <N>`,
        `Verify the contract: node ${join(HERE, 'verify-contract.mjs')} ${out}`,
      ],
    },
    null,
    2,
  ) + '\n',
);
